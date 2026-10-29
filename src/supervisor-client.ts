import { createConnection, type Socket } from 'node:net';
import { readFile } from 'node:fs/promises';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as pause } from 'node:timers/promises';
import type { AgentManager, AgentSnapshot } from './agent.js';
import type { Config } from './config.js';
import { WriterError, type WriterProvider, type WriterRequest, type WriterResponse, type Health, type GenerationOptions, type ProviderProgress } from './types.js';
import { processExists, supervisorConfigFingerprint, supervisorRuntimeVersion, supervisorStateDirectory, validOwner, type SupervisorMethod, type SupervisorOwner, type SupervisorUpdate } from './supervisor-protocol.js';

interface Pending {
  resolve(value: unknown): void;
  reject(error: unknown): void;
  cleanup(): void;
  onProgress?: (progress: ProviderProgress) => void;
}
export interface SupervisorClientOptions {
  stateDir?: string;
  connectTimeoutMs?: number;
  /** Trusted test/deployment launcher override; never accepted from MCP input. */
  supervisorEntrypoint?: string;
  environment?: NodeJS.ProcessEnv;
}
function connectionError(message = 'The local execution supervisor connection closed. Accepted agent tasks continue independently; reconnect and query the same ID or idempotency key.') {
  return new WriterError('SUPERVISOR_CONNECTION_LOST', message);
}

/** An MCP connection is only a view onto independently owned task execution.
 * Constructing this client and registering tools does not start a process. */
export class SupervisorClient {
  readonly stateDir: string;
  readonly provider: WriterProvider;
  private socket?: Socket;
  private connecting?: Promise<void>;
  private closed = false;
  private pending = new Map<string, Pending>();
  private observers = new Set<(update: SupervisorUpdate) => unknown>();
  private launched?: ChildProcess;
  private launchId?: string;
  private owner?: Omit<SupervisorOwner, 'token' | 'endpoint'>;
  private mismatch?: 'SUPERVISOR_RUNTIME_MISMATCH' | 'SUPERVISOR_CONFIG_MISMATCH';

  constructor(private config: Config, private options: SupervisorClientOptions = {}) {
    this.stateDir = resolve(options.stateDir ?? supervisorStateDirectory(options.environment ?? process.env));
    this.provider = {
      generate: (request, generationOptions) => this.generate(request, generationOptions),
      health: () => this.health(),
      // Closing one MCP provider view never terminates another client's work.
      close: () => this.close()
    };
  }

  get supervisorInfo() { return this.owner ? { ...this.owner } : undefined; }
  subscribe(listener: (update: SupervisorUpdate) => unknown): () => void {
    this.observers.add(listener);
    return () => { this.observers.delete(listener); };
  }
  spawn(input: Parameters<AgentManager['spawn']>[0]): Promise<AgentSnapshot> { return this.call('spawn', input); }
  submit(input: Parameters<AgentManager['submit']>[0]): Promise<AgentSnapshot> { return this.call('submit', input); }
  get(target: string): Promise<AgentSnapshot> { return this.call('get', { target }); }
  list(): Promise<AgentSnapshot[]> { return this.call('list'); }
  sendMessage(target: string, message: string): Promise<AgentSnapshot> { return this.call('sendMessage', { target, message }); }
  followup(target: string, message: string): Promise<AgentSnapshot> { return this.call('followup', { target, message }); }
  cancel(target: string): Promise<AgentSnapshot> { return this.call('cancel', { target }); }
  wait(targets: string[], afterRevision?: number, timeoutMs = 30000, options: { until?: 'update' | 'attention'; signal?: AbortSignal } = {}): ReturnType<AgentManager['wait']> {
    return this.call('wait', { targets, afterRevision, timeoutMs, until: options.until }, { signal: options.signal });
  }
  generate(request: WriterRequest, options?: GenerationOptions): Promise<WriterResponse> { return this.call('generate', request, options); }
  health(): Promise<Health> { return this.call('health'); }

  /** Explicit administrative stop, intentionally not part of the MCP tools. */
  async shutdownSupervisor(): Promise<void> {
    await this.call('shutdown');
  }

  async close(): Promise<void> {
    this.closed = true;
    const socket = this.socket; this.socket = undefined;
    for (const entry of this.pending.values()) { entry.cleanup(); entry.reject(connectionError('This MCP client disconnected. Accepted agent tasks remain owned by the supervisor.')); }
    this.pending.clear(); this.observers.clear();
    socket?.destroy();
  }

  private async call<T>(method: SupervisorMethod, params?: unknown, options?: GenerationOptions): Promise<T> {
    options?.signal?.throwIfAborted();
    await this.ensureConnected();
    if (this.mismatch && !['get', 'list', 'wait', 'cancel', 'shutdown', 'restartIfIdle'].includes(method)) {
      const restarted = await this.request<{ stopped: boolean }>('restartIfIdle');
      if (restarted.stopped) {
        const socket = this.socket; this.socket = undefined;
        for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(connectionError('The idle supervisor is restarting with the updated configuration.')); }
        this.pending.clear(); socket?.destroy();
        await this.ensureConnected();
      }
      if (this.mismatch) throw new WriterError(this.mismatch, 'The existing execution supervisor uses another runtime or configuration. Existing tasks remain queryable; finish or explicitly interrupt them before submitting new work.');
    }
    // Once a request is written it is never automatically replayed. A caller
    // can resubmit an idempotent task explicitly after an uncertain disconnect.
    return this.request<T>(method, params, options);
  }

  private request<T>(method: SupervisorMethod, params?: unknown, options?: GenerationOptions): Promise<T> {
    const socket = this.socket;
    if (this.closed || !socket || socket.destroyed) return Promise.reject(connectionError());
    const id = randomUUID();
    return new Promise<T>((resolveResult, rejectResult) => {
      const abort = () => {
        const pending = this.pending.get(id);
        if (!pending) return;
        this.pending.delete(id); pending.cleanup();
        if (!socket.destroyed) socket.write(JSON.stringify({ cancel: id }) + '\n');
        rejectResult(options?.signal?.reason ?? new WriterError('SUPERVISOR_REQUEST_CANCELLED', 'The caller cancelled this request.'));
      };
      const cleanup = () => options?.signal?.removeEventListener('abort', abort);
      this.pending.set(id, { resolve: value => resolveResult(value as T), reject: rejectResult, cleanup, onProgress: options?.onProgress });
      options?.signal?.addEventListener('abort', abort, { once: true });
      if (options?.signal?.aborted) { abort(); return; }
      socket.write(JSON.stringify({ id, method, params }) + '\n', error => {
        if (!error) return;
        const pending = this.pending.get(id);
        if (pending) { this.pending.delete(id); pending.cleanup(); pending.reject(connectionError()); }
      });
    });
  }

  private ensureConnected(): Promise<void> {
    if (this.closed) return Promise.reject(new WriterError('SUPERVISOR_CLIENT_CLOSED', 'This MCP supervisor client has closed.'));
    if (this.socket && !this.socket.destroyed) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.connecting = this.connect().finally(() => { this.connecting = undefined; });
    return this.connecting;
  }

  private async connect(): Promise<void> {
    const timeout = this.options.connectTimeoutMs ?? 15000;
    if (!Number.isSafeInteger(timeout) || timeout < 1) throw new WriterError('CONFIG_ERROR', 'Supervisor connection timeout must be a positive integer.');
    const deadline = Date.now() + timeout;
    let launched = false;
    let launchError = false;
    let invalidOwner = false;
    while (!this.closed && Date.now() < deadline) {
      if (launched && this.launchId) {
        try {
          const failure = JSON.parse(await readFile(join(this.stateDir, 'supervisor-startup-error.json'), 'utf8'));
          if (failure.launchId === this.launchId && failure.error && typeof failure.error.code === 'string') {
            const error = new WriterError(failure.error.code, typeof failure.error.message === 'string' ? failure.error.message : 'The execution supervisor could not load its durable state.');
            for (const key of ['failure_reason', 'retryable', 'error_id', 'partial', 'recovery', 'diagnostics']) if (key in failure.error) Object.assign(error, { [key]: failure.error[key] });
            throw error;
          }
        } catch (error) { if (error instanceof WriterError) throw error; }
      }
      let owner: SupervisorOwner | undefined;
      let missing = false;
      try {
        const value: unknown = JSON.parse(await readFile(join(this.stateDir, 'supervisor-owner.json'), 'utf8'));
        if (validOwner(value, this.stateDir)) owner = value; else invalidOwner = true;
      } catch (error) { missing = (error as NodeJS.ErrnoException).code === 'ENOENT'; if (!missing) invalidOwner = true; }
      if (owner && processExists(owner.pid)) {
        try { await this.connectOwner(owner, deadline); return; }
        catch (error) {
          if (error instanceof WriterError && ['SUPERVISOR_CONFIG_MISMATCH', 'SUPERVISOR_RUNTIME_MISMATCH'].includes(error.code)) throw error;
          // Startup/connect retries never replay provider work.
        }
      } else if (!launched && (owner || missing)) {
        launched = true;
        try {
          this.launched = this.launch();
          this.launched.once('error', () => { launchError = true; });
          this.launched.unref();
        } catch { launchError = true; }
      }
      if (launchError) throw new WriterError('SUPERVISOR_START_FAILED', 'Unable to start the local execution supervisor; no provider request was replayed.');
      await pause(50);
    }
    if (this.closed) throw new WriterError('SUPERVISOR_CLIENT_CLOSED', 'The MCP client closed while connecting to the execution supervisor.');
    throw new WriterError(invalidOwner ? 'SUPERVISOR_OWNER_INVALID' : 'SUPERVISOR_UNAVAILABLE', invalidOwner
      ? 'The local supervisor owner record is incomplete or invalid. Existing task files remain in the state directory; execution was not duplicated.'
      : 'The local execution supervisor could not be reached. A live owner is not replaced or killed; reconnect and query the existing task.');
  }

  private launch(): ChildProcess {
    this.launchId = randomUUID();
    const env: NodeJS.ProcessEnv = { ...(this.options.environment ?? process.env), WRITER_STATE_DIR: this.stateDir,
      WRITER_SUPERVISOR_LAUNCH_ID: this.launchId,
      WRITER_PROVIDER: this.config.provider, AGY_COMMAND: this.config.agyCommand, AGY_MODEL: this.config.agyModel,
      AGY_AGENT_MODEL: this.config.agyAgentModel ?? this.config.agyModel,
      WRITER_TIMEOUT_MS: String(this.config.timeoutMs), AGENT_PROVIDER_TIMEOUT_MS: String(this.config.agentProviderTimeoutMs ?? this.config.timeoutMs),
      AGENT_TIMEOUT_MS: String(this.config.agentTimeoutMs ?? 0), AGENT_MIN_INTERVAL_MS: String(this.config.agentMinIntervalMs ?? 5000),
      MAX_INPUT_CHARS: String(this.config.maxInputChars), MAX_OUTPUT_CHARS: String(this.config.maxOutputChars), MAX_ATTEMPTS: String(this.config.maxAttempts), LOG_LEVEL: this.config.logLevel };
    // Credentials travel only in the inherited process environment, never in
    // command arguments or the durable owner/task metadata.
    if (this.config.apiKey !== undefined) env.GEMINI_API_KEY = this.config.apiKey;
    if (this.config.apiModel !== undefined) env.GEMINI_API_MODEL = this.config.apiModel;
    const entrypoint = this.options.supervisorEntrypoint ?? fileURLToPath(new URL('./supervisor.js', import.meta.url));
    return spawn(process.execPath, [entrypoint, '--state-dir', this.stateDir], { cwd: fileURLToPath(new URL('../', import.meta.url)), env, detached: true, windowsHide: true, stdio: 'ignore' });
  }

  private async connectOwner(owner: SupervisorOwner, deadline: number): Promise<void> {
    const socket = createConnection(owner.endpoint);
    socket.setEncoding('utf8');
    await new Promise<void>((done, reject) => {
      const fail = (error: Error) => { clearTimeout(timer); socket.off('connect', connected); socket.destroy(); reject(error); };
      const connected = () => { clearTimeout(timer); socket.off('error', fail); done(); };
      const timer = setTimeout(() => fail(connectionError('The supervisor endpoint did not accept a connection in time.')), Math.max(1, Math.min(1000, deadline - Date.now())));
      socket.once('connect', connected); socket.once('error', fail);
    });
    if (this.closed) { socket.destroy(); throw connectionError(); }
    this.socket = socket;
    let buffer = '';
    socket.on('data', data => {
      buffer += data;
      while (buffer.includes('\n')) {
        const end = buffer.indexOf('\n'); const line = buffer.slice(0, end); buffer = buffer.slice(end + 1);
        let message: Record<string, unknown>;
        try { message = JSON.parse(line); }
        catch { socket.destroy(); return; }
        if (message.event === 'agent') {
          for (const observer of this.observers) {
            try { const returned = observer(message.data as SupervisorUpdate); if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') void Promise.resolve(returned).catch(() => {}); }
            catch { /* Progress observers cannot change execution. */ }
          }
          continue;
        }
        if (message.event === 'progress' && typeof message.requestId === 'string') {
          try {
            const returned: unknown = this.pending.get(message.requestId)?.onProgress?.(message.data as ProviderProgress);
            if (returned && typeof (returned as PromiseLike<unknown>).then === 'function') void Promise.resolve(returned).catch(() => {});
          } catch { /* Observers are isolated. */ }
          continue;
        }
        if (typeof message.id !== 'string') { socket.destroy(); return; }
        const pending = this.pending.get(message.id);
        if (!pending) continue;
        this.pending.delete(message.id); pending.cleanup();
        if (message.error && typeof message.error === 'object') {
          const detail = message.error as Record<string, unknown>;
          const error = new WriterError(typeof detail.code === 'string' ? detail.code : 'SUPERVISOR_ERROR', typeof detail.message === 'string' ? detail.message : 'The supervisor operation failed.');
          for (const key of ['failure_reason', 'retryable', 'error_id', 'partial', 'recovery', 'diagnostics']) if (key in detail) Object.assign(error, { [key]: detail[key] });
          pending.reject(error);
        } else pending.resolve(message.result);
      }
    });
    const disconnected = () => {
      if (this.socket !== socket) return;
      this.socket = undefined;
      for (const pending of this.pending.values()) { pending.cleanup(); pending.reject(connectionError()); }
      this.pending.clear();
    };
    socket.on('error', disconnected); socket.on('close', disconnected);
    const handshake = new AbortController();
    const handshakeTimer = setTimeout(() => handshake.abort(connectionError('The supervisor did not complete its local authentication handshake in time.')), Math.max(1, Math.min(1000, deadline - Date.now())));
    try {
      const fingerprint = supervisorConfigFingerprint(this.config, this.options.environment ?? process.env);
      this.owner = await this.request<Omit<SupervisorOwner, 'token' | 'endpoint'>>('hello', { token: owner.token, runtimeVersion: supervisorRuntimeVersion, configFingerprint: fingerprint }, { signal: handshake.signal });
      this.mismatch = this.owner.runtimeVersion !== supervisorRuntimeVersion ? 'SUPERVISOR_RUNTIME_MISMATCH' : this.owner.configFingerprint !== fingerprint ? 'SUPERVISOR_CONFIG_MISMATCH' : undefined;
      if (this.mismatch) {
        if (owner.pid === this.launched?.pid) throw new WriterError(this.mismatch, 'The newly started supervisor loaded a different effective runtime or configuration. Check the explicit environment and launcher configuration; no task was submitted or retried.');
        const restarted = await this.request<{ stopped: boolean }>('restartIfIdle', undefined, { signal: handshake.signal });
        if (restarted.stopped) { socket.destroy(); disconnected(); throw connectionError('The idle supervisor is restarting with the current runtime and configuration.'); }
      }
    } catch (error) { socket.destroy(); disconnected(); throw error; }
    finally { clearTimeout(handshakeTimer); }
  }
}
