import { createServer, type Socket } from 'node:net';
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AgentManager } from './agent.js';
import { DiskTaskStore } from './task-store.js';
import { loadConfig, type Config } from './config.js';
import { ControlledProvider } from './providers/controlled.js';
import { AgyProvider } from './providers/agy.js';
import { GeminiApiProvider } from './providers/gemini-api.js';
import { errorInfo, WriterError, type WriterProvider, type WriterRequest } from './types.js';
import { processExists, supervisorConfigFingerprint, supervisorEndpoint, supervisorProtocolVersion, supervisorRuntimeVersion, supervisorStateDirectory, validOwner,
  type SupervisorOwner, type SupervisorRequest, type SupervisorUpdate } from './supervisor-protocol.js';

export interface SupervisorOptions {
  stateDir?: string;
  provider?: WriterProvider;
  idleTimeoutMs?: number;
}
export interface RunningSupervisor {
  stateDir: string;
  endpoint: string;
  owner: Readonly<Omit<SupervisorOwner, 'token'>>;
  close(): Promise<void>;
}

const ownerFile = (directory: string) => join(directory, 'supervisor-owner.json');
function readOwner(directory: string): SupervisorOwner | undefined {
  try { const value: unknown = JSON.parse(readFileSync(ownerFile(directory), 'utf8')); return validOwner(value, directory) ? value : undefined; }
  catch { return undefined; }
}
function removeOwnedFile(path: string, instanceId: string) {
  try { if (JSON.parse(readFileSync(path, 'utf8')).instanceId === instanceId) unlinkSync(path); }
  catch { /* A different owner or missing file is never removed. */ }
}

/** The endpoint bind is the final single-owner boundary. A stale-owner recovery
 * guard serializes normal recovery; the bind also rejects any race after a crash. */
function claimOwner(directory: string, owner: SupervisorOwner) {
  const path = ownerFile(directory);
  let guard: string | undefined;
  const create = () => {
    const fd = openSync(path, 'wx', 0o600);
    try { writeFileSync(fd, JSON.stringify(owner)); } finally { closeSync(fd); }
  };
  try { create(); return; }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error; }
  const previous = readOwner(directory);
  if (!previous || processExists(previous.pid)) throw new WriterError('SUPERVISOR_ALREADY_RUNNING', 'A supervisor owns this state directory or is still starting.');
  guard = join(directory, 'supervisor-recovery.json');
  try {
    let fd: number;
    try { fd = openSync(guard, 'wx', 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      let holder: { pid?: number; instanceId?: string } | undefined;
      try { holder = JSON.parse(readFileSync(guard, 'utf8')); } catch { /* Incomplete guard remains authoritative. */ }
      if (!holder || !Number.isSafeInteger(holder.pid) || holder.pid! < 1 || processExists(holder.pid!)) throw new WriterError('SUPERVISOR_ALREADY_RUNNING', 'Another supervisor is recovering this state directory.');
      // The final pipe/socket bind still prevents a second manager if two dead
      // recovery guards are reclaimed at the same instant.
      removeOwnedFile(guard, holder.instanceId ?? '');
      fd = openSync(guard, 'wx', 0o600);
    }
    try { writeFileSync(fd, JSON.stringify({ pid: process.pid, instanceId: owner.instanceId })); } finally { closeSync(fd); }
    const current = readOwner(directory);
    if (!current || processExists(current.pid)) throw new WriterError('SUPERVISOR_ALREADY_RUNNING', 'The existing supervisor remains the execution owner.');
    removeOwnedFile(path, current.instanceId);
    create();
  } finally { if (guard) removeOwnedFile(guard, owner.instanceId); }
}

function authenticate(candidate: unknown, expected: string): boolean {
  return typeof candidate === 'string' && /^[a-f0-9]{64}$/.test(candidate) && timingSafeEqual(Buffer.from(candidate), Buffer.from(expected));
}
function rpcError(code: string, message: string) { return new WriterError(code, message); }

/** This process owns execution. MCP clients only connect to it and can leave
 * without terminating accepted work. No provider starts until an RPC needs it. */
export async function startSupervisor(config: Config, options: SupervisorOptions = {}): Promise<RunningSupervisor> {
  const stateDir = resolve(options.stateDir ?? supervisorStateDirectory());
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
  if (process.platform !== 'win32') chmodSync(stateDir, 0o700);
  const owner: SupervisorOwner = { protocol: supervisorProtocolVersion, pid: process.pid,
    instanceId: randomBytes(16).toString('hex'), startedAt: new Date().toISOString(), endpoint: supervisorEndpoint(stateDir), token: randomBytes(32).toString('hex'), runtimeVersion: supervisorRuntimeVersion, configFingerprint: supervisorConfigFingerprint(config) };
  claimOwner(stateDir, owner);
  const sockets = new Set<Socket>();
  const authorized = new Set<Socket>();
  const mismatches = new Map<Socket, 'SUPERVISOR_RUNTIME_MISMATCH' | 'SUPERVISOR_CONFIG_MISMATCH'>();
  const requests = new Map<Socket, Map<string, AbortController>>();
  let manager: AgentManager | undefined;
  let provider: ControlledProvider | undefined;
  let closing = false;
  let closePromise: Promise<void> | undefined;
  let idleTimer: ReturnType<typeof setTimeout> | undefined;
  let activeOperations = 0;
  let activeProviderOperations = 0;
  const idleTimeoutMs = options.idleTimeoutMs ?? 60000;
  if (!Number.isSafeInteger(idleTimeoutMs) || idleTimeoutMs < 1) { removeOwnedFile(ownerFile(stateDir), owner.instanceId); throw rpcError('CONFIG_ERROR', 'Supervisor idle timeout must be a positive integer.'); }
  const send = (socket: Socket, value: unknown) => { if (!socket.destroyed && socket.writable) socket.write(JSON.stringify(value) + '\n'); };
  let unsubscribe = () => {};
  const server = createServer(socket => {
    sockets.add(socket); requests.set(socket, new Map()); clearTimeout(idleTimer);
    socket.setEncoding('utf8');
    let buffer = '';
    const authenticationTimer = setTimeout(() => { if (!authorized.has(socket)) socket.destroy(); }, 5000);
    authenticationTimer.unref();
    socket.on('error', () => { /* Disconnect never cancels an accepted agent. */ });
    socket.on('close', () => {
      clearTimeout(authenticationTimer);
      sockets.delete(socket); authorized.delete(socket); mismatches.delete(socket);
      for (const controller of requests.get(socket)?.values() ?? []) controller.abort(rpcError('SUPERVISOR_CLIENT_DISCONNECTED', 'The calling MCP connection closed.'));
      requests.delete(socket); scheduleIdle();
    });
    socket.on('data', data => {
      buffer += data;
      if (!authorized.has(socket) && buffer.length > 4096) { socket.destroy(); return; }
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let request: SupervisorRequest & { cancel?: string };
        try { request = JSON.parse(line); }
        catch { socket.destroy(); return; }
        if (!request || typeof request !== 'object' || Array.isArray(request)) { socket.destroy(); return; }
        if (typeof request.cancel === 'string' && authorized.has(socket)) {
          requests.get(socket)?.get(request.cancel)?.abort(rpcError('SUPERVISOR_REQUEST_CANCELLED', 'The caller cancelled this wait or writing request.'));
          continue;
        }
        if (typeof request.id !== 'string' || !/^[A-Za-z0-9_-]{1,100}$/.test(request.id) || typeof request.method !== 'string') { socket.destroy(); return; }
        if (request.method === 'hello') {
          if (!authenticate((request.params as { token?: unknown } | undefined)?.token, owner.token)) { send(socket, { id: request.id, error: errorInfo(rpcError('SUPERVISOR_AUTH_FAILED', 'Local supervisor authentication failed.')) }); socket.end(); return; }
          const expected = request.params as { runtimeVersion?: unknown; configFingerprint?: unknown };
          if (expected.runtimeVersion !== owner.runtimeVersion) mismatches.set(socket, 'SUPERVISOR_RUNTIME_MISMATCH');
          else if (expected.configFingerprint !== owner.configFingerprint) mismatches.set(socket, 'SUPERVISOR_CONFIG_MISMATCH');
          else mismatches.delete(socket);
          authorized.add(socket); clearTimeout(authenticationTimer); send(socket, { id: request.id, result: { protocol: owner.protocol, pid: owner.pid, instanceId: owner.instanceId, startedAt: owner.startedAt, runtimeVersion: owner.runtimeVersion, configFingerprint: owner.configFingerprint } }); continue;
        }
        if (!authorized.has(socket)) { socket.destroy(); return; }
        if (requests.get(socket)?.has(request.id)) { send(socket, { id: request.id, error: errorInfo(rpcError('SUPERVISOR_DUPLICATE_REQUEST', 'RPC request IDs must be unique while pending.')) }); continue; }
        const controller = new AbortController(); requests.get(socket)?.set(request.id, controller);
        activeOperations++;
        void dispatch(request, socket, controller.signal).then(result => send(socket, { id: request.id, result }), error => send(socket, { id: request.id, error: errorInfo(error) })).finally(() => {
          requests.get(socket)?.delete(request.id); activeOperations--; scheduleIdle();
        });
      }
      // Before authentication only a short hello is valid. Do not retain an
      // unbounded unauthenticated local stream.
      if (!authorized.has(socket) && buffer.length > 4096) socket.destroy();
    });
  });

  async function dispatch(request: SupervisorRequest, socket: Socket, signal: AbortSignal): Promise<unknown> {
    if (closing || !manager || !provider) throw rpcError('SUPERVISOR_NOT_READY', 'The supervisor is not accepting new requests.');
    const params = request.params as Record<string, unknown> | undefined;
    const mismatch = mismatches.get(socket);
    if (mismatch && !['get', 'list', 'wait', 'cancel', 'shutdown', 'restartIfIdle'].includes(request.method)) throw rpcError(mismatch, 'An active supervisor uses a different runtime or execution configuration. Existing tasks remain queryable; finish or explicitly interrupt them before submitting new work.');
    switch (request.method) {
      case 'spawn': return manager.spawn(request.params as Parameters<AgentManager['spawn']>[0]);
      case 'submit': return manager.submit(request.params as Parameters<AgentManager['submit']>[0]);
      case 'get': return manager.get(String(params?.target ?? ''));
      case 'list': return manager.list();
      case 'sendMessage': return manager.sendMessage(String(params?.target ?? ''), String(params?.message ?? ''));
      case 'followup': return manager.followup(String(params?.target ?? ''), String(params?.message ?? ''));
      case 'cancel': return manager.cancel(String(params?.target ?? ''));
      case 'wait': {
        const targets = params?.targets;
        if (!Array.isArray(targets) || targets.length > 8 || !targets.every(target => typeof target === 'string')) throw rpcError('AGENT_INVALID_WAIT', 'Wait targets must contain at most eight task IDs or names.');
        const after = params?.afterRevision;
        if (after !== undefined && (!Number.isSafeInteger(after) || Number(after) < 0)) throw rpcError('AGENT_INVALID_WAIT', 'Wait revision must be a nonnegative integer.');
        return manager.wait(targets, after as number | undefined, params?.timeoutMs === undefined ? 30000 : Number(params.timeoutMs), { until: params?.until === 'attention' ? 'attention' : 'update', signal });
      }
      case 'generate': {
        activeProviderOperations++;
        try { return await provider.generate(request.params as unknown as WriterRequest, { signal, onProgress: data => send(socket, { event: 'progress', requestId: request.id, data }) }); }
        finally { activeProviderOperations--; }
      }
      case 'health': {
        activeProviderOperations++;
        try { return await provider.health(); } finally { activeProviderOperations--; }
      }
      case 'shutdown': closing = true; setImmediate(() => { void close(); }); return { stopped: true };
      case 'restartIfIdle': {
        if (activeProviderOperations || manager.list().some(task => ['queued', 'running'].includes(task.status))) return { stopped: false };
        closing = true; setImmediate(() => { void close(); }); return { stopped: true };
      }
      default: throw rpcError('SUPERVISOR_UNKNOWN_METHOD', 'Unsupported local supervisor operation.');
    }
  }

  function scheduleIdle() {
    clearTimeout(idleTimer);
    if (closing || sockets.size || activeOperations || manager?.list().some(task => ['queued', 'running'].includes(task.status))) return;
    idleTimer = setTimeout(() => { void close(); }, idleTimeoutMs);
    idleTimer.unref();
  }

  async function close(): Promise<void> {
    if (closePromise) return closePromise;
    closing = true; clearTimeout(idleTimer); unsubscribe();
    closePromise = (async () => {
      for (const pending of requests.values()) for (const controller of pending.values()) controller.abort(rpcError('SUPERVISOR_CLOSED', 'The execution supervisor is shutting down.'));
      for (const socket of sockets) socket.destroy();
      try { await manager?.shutdown(); }
      finally {
        await new Promise<void>(done => { if (!server.listening) done(); else server.close(() => done()); });
        removeOwnedFile(ownerFile(stateDir), owner.instanceId);
        process.off('SIGTERM', onShutdown); process.off('SIGINT', onShutdown);
      }
    })();
    return closePromise;
  }
  const onShutdown = () => { void close().catch(error => { process.stderr.write(JSON.stringify(errorInfo(error)) + '\n'); }); };
  try {
    // A stale Unix socket is removed only after its owner is known dead. The
    // owner file was acquired before reaching this point.
    if (process.platform !== 'win32' && existsSync(owner.endpoint)) unlinkSync(owner.endpoint);
    await new Promise<void>((done, reject) => {
      server.once('error', reject);
      server.listen({ path: owner.endpoint, readableAll: false, writableAll: false }, () => { server.off('error', reject); done(); });
    });
    if (process.platform !== 'win32') chmodSync(owner.endpoint, 0o600);
    const raw = options.provider ?? (config.provider === 'agy' ? new AgyProvider(config) : new GeminiApiProvider(config));
    provider = new ControlledProvider(config, raw);
    manager = new AgentManager(config, provider, new DiskTaskStore(join(stateDir, 'tasks')));
    server.on('error', onShutdown);
    unsubscribe = manager.subscribe(update => {
      // Capture fast transitions synchronously before another event can update
      // runtime; querying after IPC delivery would lose ACTIVE/DONE pairs.
      const current = manager!.get(update.id);
      const event: SupervisorUpdate = { ...update, view: { status: current.status, runtime: current.runtime, error: current.error } };
      for (const socket of authorized) send(socket, { event: 'agent', data: event });
      scheduleIdle();
    });
    process.once('SIGTERM', onShutdown); process.once('SIGINT', onShutdown);
    scheduleIdle();
    const { token: _token, ...publicOwner } = owner;
    return { stateDir, endpoint: owner.endpoint, owner: Object.freeze(publicOwner), close };
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const marker = process.argv.indexOf('--state-dir');
  const stateDir = marker >= 0 ? process.argv[marker + 1] : undefined;
  try { await startSupervisor(loadConfig(), { stateDir }); }
  catch (error) {
    // Never print owner tokens, prompts, provider stderr or environment values.
    if (!(error instanceof WriterError && error.code === 'SUPERVISOR_ALREADY_RUNNING')) {
      const detail = errorInfo(error);
      try {
        const directory = resolve(stateDir ?? supervisorStateDirectory());
        const temporary = join(directory, `supervisor-startup-error.${process.pid}.tmp`);
        writeFileSync(temporary, JSON.stringify({ launchId: process.env.WRITER_SUPERVISOR_LAUNCH_ID, time: new Date().toISOString(), error: detail }), { mode: 0o600 });
        renameSync(temporary, join(directory, 'supervisor-startup-error.json'));
      } catch { /* A filesystem startup failure can also prevent diagnostics. */ }
      process.stderr.write(JSON.stringify(detail) + '\n');
    }
    process.exitCode = error instanceof WriterError && error.code === 'SUPERVISOR_ALREADY_RUNNING' ? 0 : 1;
  }
}
