import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { mkdtempSync, rmSync, readFileSync, realpathSync, statSync, existsSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, isAbsolute, join, resolve, sep } from 'node:path';
import type { Config } from '../config.js';
import { WriterError, type WriterResponse, type ProviderProgress } from '../types.js';
import { killTree, resolveCommand } from '../utils/subprocess.js';
import { terminalText } from '../utils/sanitize.js';
import { hiddenConsoleLaunch } from '../utils/windows-launch.js';
import { AgyDiagnostics } from './agy-diagnostics.js';
import { agyFailure, attachPartial, parseAgyErrorTail, terminalAgyFailure } from './agy-errors.js';

export interface AgySessionOptions {
  /** Trusted test harness prefix, never a model or MCP input. Production leaves this empty. */
  argsPrefix?: string[];
  idleTimeoutMs?: number;
  /** Trusted harness timing; production waiting updates use 30 seconds. */
  heartbeatMs?: number;
  /** Explicit native execution grant; runs with local user privileges, not an OS sandbox. */
  nativeTools?: { workspace: string };
}
export interface AgySessionResponse extends WriterResponse {
  metrics: NonNullable<WriterResponse['metrics']> & {
    processPid?: number; conversationId: string; sessionReused: boolean;
    /** Session elapsed time; includes idle intervals between prompts. */
    providerCumulativeDurationSeconds?: number;
    /** Difference between cumulative counters; also includes inter-turn idle. */
    providerDurationDeltaSeconds?: number;
  };
}
interface Pending {
  start: number; timer?: ReturnType<typeof setTimeout>; signal?: AbortSignal; abort: () => void;
  resolve: (response: AgySessionResponse) => void; reject: (error: WriterError) => void;
  onProgress?: (progress: ProviderProgress) => void; stepUpdates: number;
}
interface Envelope {
  conversation_id?: unknown; status?: unknown; response?: unknown; error?: unknown;
  duration_seconds?: unknown; num_turns?: unknown; usage?: Record<string, unknown>;
}

function sessionError(detail: string, status?: string, exitCode?: number | null, signal?: NodeJS.Signals | null): WriterError {
  return agyFailure(detail, status, exitCode, signal);
}

/** NDJSON protocol with opt-in native execution. The owner serializes calls with its Provider gate. */
export class AgySession {
  private child?: ChildProcessWithoutNullStreams;
  private scratch?: string;
  private pending?: Pending;
  private closed = false;
  private failure?: WriterError;
  private cleanup?: Promise<void>;
  private processClosed?: Promise<void>;
  private idleTimer?: ReturnType<typeof setTimeout>;
  private monitor?: ReturnType<typeof setInterval>;
  private diagnostics?: AgyDiagnostics;
  private lastDiagnostic?: WriterError;
  private lastActivity = 0;
  private lastHeartbeat = 0;
  private buffer = '';
  private stderr = '';
  private publicOutput = '';
  private terminalFailure?: Envelope;
  private terminalFailureTimer?: ReturnType<typeof setTimeout>;
  private turnOutputChars = 0;
  private conversationId?: string;
  private completedTurns = 0;
  private cumulativeDuration = 0;
  private cumulativeUsage: Record<string, number> = {};
  private readonly idleTimeoutMs: number;
  private readonly nativeWorkspace?: string;
  private readonly onShutdown = () => { void this.stop(new WriterError('AGY_CANCELLED', 'Provider process is shutting down.')); };
  private readonly onExit = () => {
    if (this.child?.pid && this.child.exitCode === null) killTree(this.child.pid);
    if (this.scratch) { this.checkScratch(this.scratch); rmSync(this.scratch, { recursive: true, force: true }); }
  };
  constructor(private config: Config, private model: string, private effort: 'medium' | 'high', private options: AgySessionOptions = {}) {
    this.idleTimeoutMs = options.idleTimeoutMs ?? 60000;
    if (!Number.isSafeInteger(options.heartbeatMs ?? 30000) || (options.heartbeatMs ?? 30000) < 1) throw new WriterError('CONFIG_ERROR', 'Heartbeat interval must be a positive integer.');
    if (options.nativeTools) {
      const workspace = options.nativeTools.workspace;
      try {
        if (!isAbsolute(workspace) || !statSync(workspace).isDirectory()) throw new Error('Invalid workspace');
        this.nativeWorkspace = realpathSync(workspace);
      } catch { throw new WriterError('AGY_NATIVE_WORKSPACE', 'Native tools require an existing absolute workspace directory.'); }
    }
    if (!Number.isSafeInteger(this.idleTimeoutMs) || this.idleTimeoutMs < 1 || this.idleTimeoutMs > 60000) throw new WriterError('CONFIG_ERROR', 'Session idle timeout must be between 1 and 60000 ms.');
  }
  get isClosed(): boolean { return this.closed; }
  private get providerPid(): number | undefined {
    if (process.platform !== 'win32') return this.child?.pid;
    if (!this.scratch) return undefined;
    try {
      const pid = Number(readFileSync(join(this.scratch, 'launch.pid'), 'utf8').trim());
      return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
    } catch { return undefined; }
  }

  async ask(prompt: string, signal?: AbortSignal, onProgress?: (progress: ProviderProgress) => void): Promise<AgySessionResponse> {
    if (this.closed) throw this.failure ?? new WriterError('AGY_SESSION_CLOSED', 'Provider session has closed; create a fresh session explicitly.');
    if (this.pending) throw new WriterError('AGY_SESSION_BUSY', 'Wait for the current Provider turn before sending another prompt.');
    if (signal?.aborted) throw new WriterError('AGY_CANCELLED', 'Provider turn was cancelled before starting.');
    if (!prompt.trim() || (!this.nativeWorkspace && prompt.length > this.config.maxInputChars)) throw new WriterError('INPUT_TOO_LARGE', 'Session prompt is empty or exceeds MAX_INPUT_CHARS.');
    clearTimeout(this.idleTimer);
    this.stderr = ''; this.publicOutput = ''; this.terminalFailure = undefined; this.turnOutputChars = 0; this.lastDiagnostic = undefined;
    return new Promise<AgySessionResponse>((resolveTurn, rejectTurn) => {
      const abort = () => { void this.stop(new WriterError('AGY_CANCELLED', 'Provider turn was cancelled; process termination was requested.')); };
      const timer = this.config.timeoutMs > 0 ? setTimeout(() => { void this.stop(new WriterError('AGY_TIMEOUT', `Provider turn exceeded WRITER_TIMEOUT_MS=${this.config.timeoutMs}; process termination was requested.`)); }, this.config.timeoutMs) : undefined;
      this.pending = { start: Date.now(), timer, signal, abort, resolve: resolveTurn, reject: rejectTurn, onProgress, stepUpdates: 0 };
      this.lastActivity = this.lastHeartbeat = Date.now();
      signal?.addEventListener('abort', abort, { once: true });
      try {
        this.progress('starting');
        if (this.closed) return;
        if (!this.child) this.start();
        this.monitor = setInterval(() => {
          if (this.closed || !this.pending) return;
          const failure = this.diagnostics?.poll();
          if (failure) { this.lastDiagnostic = failure; this.progress('retrying', { errorCode: failure.code }); }
          const now = Date.now();
          if (now - this.lastHeartbeat >= (this.options.heartbeatMs ?? 30000)) {
            this.lastHeartbeat = now;
            this.progress('waiting');
          }
        }, Math.min(250, this.options.heartbeatMs ?? 30000));
        if (signal?.aborted) { abort(); return; }
        const pending = this.pending;
        this.child!.stdin.write(JSON.stringify({ event: 'user', message: { content: prompt } }) + '\n', 'utf8', error => {
          if (this.pending !== pending) return;
          if (error && !this.closed) void this.stop(new WriterError('AGY_START_FAILED', 'Provider session could not accept stdin.'));
          else if (!this.closed) this.progress('submitted');
        });
      } catch (error) {
        void this.stop(error instanceof WriterError ? error : new WriterError('AGY_START_FAILED', 'Unable to start the native agy executable.'));
      }
    });
  }

  async close(): Promise<void> { await this.stop(new WriterError('AGY_SESSION_CLOSED', 'Provider session was closed explicitly.')); }

  private progress(stage: ProviderProgress['stage'], extra: Pick<ProviderProgress, 'stepType' | 'stepState' | 'errorCode'> = {}) {
    if (stage !== 'waiting') this.lastActivity = Date.now();
    const pending = this.pending;
    if (!pending?.onProgress) return;
    const progress: ProviderProgress = { stage, time: new Date().toISOString(), elapsedMs: Date.now() - pending.start,
      timeoutMs: this.config.timeoutMs, stepUpdates: pending.stepUpdates, sessionReused: this.completedTurns > 0,
      processPid: this.providerPid, conversationId: this.conversationId, silentMs: Math.max(0, Date.now() - this.lastActivity), ...extra };
    // Telemetry observers cannot affect execution or leak provider response/step text.
    try {
      const returned: unknown = pending.onProgress(Object.freeze(progress));
      if (returned && (typeof returned === 'object' || typeof returned === 'function')) void Promise.resolve(returned).catch(() => {});
    } catch { /* observers are deliberately isolated */ }
  }

  private start() {
    const executable = resolveCommand(this.config.agyCommand);
    if (/\.(?:cmd|bat|ps1)$/i.test(executable)) throw new WriterError('AGY_SESSION_NATIVE_EXECUTABLE', 'Streaming sessions require a native executable; set AGY_COMMAND to agy.exe. Shell-wrapper fallback is not automatic.');
    this.scratch = mkdtempSync(join(tmpdir(), 'agy-session-'));
    const diagnosticPath = join(this.scratch, 'provider.log');
    this.diagnostics = new AgyDiagnostics(diagnosticPath);
    const toolFlags = this.nativeWorkspace ? ['--mode', 'auto', '--dangerously-skip-permissions'] : ['--sandbox', '--disable-slash-commands'];
    const timeoutFlags = this.config.timeoutMs > 0 ? ['--print-timeout', `${Math.ceil(this.config.timeoutMs / 1000)}s`] : [];
    const launch = hiddenConsoleLaunch(executable, [...(this.options.argsPrefix ?? []), '--log-file', diagnosticPath, '--input-format', 'stream-json', '--output-format', 'stream-json', ...toolFlags, '--model', this.model, '--effort', this.effort, ...timeoutFlags], process.env, join(this.scratch, 'launch.pid'));
    this.child = spawn(launch.file, launch.args, {
      cwd: this.nativeWorkspace ?? this.scratch, env: launch.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe']
    });
    const child = this.child;
    this.processClosed = new Promise<void>(resolveClose => child.once('close', () => resolveClose()));
    child.stdin.on('error', () => {});
    child.on('error', () => { void this.stop(new WriterError('AGY_START_FAILED', 'Unable to start the native agy executable.')); });
    child.on('close', (code, signal) => {
      if (!this.closed) {
        const result = this.terminalFailure;
        const error = result
          ? attachPartial(this.resultError(result, code, signal), result.response)
          : sessionError(this.stderr, undefined, code, signal);
        void this.stop(error.code === 'AGY_EXIT_ERROR' && this.lastDiagnostic
          && error.retryable === undefined && !error.error_id
          ? new WriterError(this.lastDiagnostic.code, `agy exited after ${this.lastDiagnostic.code}; inspect the retained diagnostics log for the final cause.`, { partial: error.partial }) : error);
      }
    });
    child.stdout.setEncoding('utf8').on('data', data => this.receive(data));
    child.stderr.setEncoding('utf8').on('data', data => {
      if (this.closed) return;
      this.turnOutputChars += data.length;
      this.stderr = (this.stderr + data).slice(-32768);
      if (!this.nativeWorkspace && this.turnOutputChars > this.config.maxOutputChars * 12 + 65536) void this.stop(new WriterError('OUTPUT_TOO_LARGE', 'Provider stream output exceeded its bounded limit.'));
    });
    process.once('SIGTERM', this.onShutdown); process.once('SIGINT', this.onShutdown); process.once('exit', this.onExit);
  }

  private receive(data: string) {
    if (this.closed) return;
    this.turnOutputChars += data.length;
    // Bound wire output separately from decoded text: streamed text and the
    // final result can each contain JSON's six-character escape sequences.
    if (!this.nativeWorkspace && this.turnOutputChars > this.config.maxOutputChars * 12 + 65536) { void this.stop(new WriterError('OUTPUT_TOO_LARGE', 'Provider stream output exceeded its bounded per-turn limit.')); return; }
    this.buffer += data;
    const lineLimit = this.config.maxOutputChars * 6 + 32768;
    while (!this.closed) {
      const end = this.buffer.indexOf('\n');
      if (end < 0) { if (!this.nativeWorkspace && this.buffer.length > lineLimit) void this.stop(new WriterError('OUTPUT_TOO_LARGE', 'Provider NDJSON line exceeded its bounded limit.')); break; }
      const line = this.buffer.slice(0, end).replace(/\r$/, '');
      this.buffer = this.buffer.slice(end + 1);
      if (!this.nativeWorkspace && line.length > lineLimit) { void this.stop(new WriterError('OUTPUT_TOO_LARGE', 'Provider NDJSON line exceeded its bounded limit.')); break; }
      if (!line.trim()) continue;
      try { this.event(JSON.parse(line)); }
      catch (error) {
        const classified = /^(?:Error:|AGY_ERROR:|Please sign in|You are not logged in)/im.test(line) ? sessionError(`${this.stderr}\n${line}`) : undefined;
        void this.stop(error instanceof WriterError ? error : classified ?? new WriterError('AGY_INVALID_OUTPUT', 'Provider emitted an invalid NDJSON event.'));
      }
    }
  }

  private event(event: Record<string, unknown>) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new WriterError('AGY_INVALID_OUTPUT', 'Provider stream event must be an object.');
    if (event.event === 'init') {
      if (this.conversationId || typeof event.conversation_id !== 'string' || !event.conversation_id) throw new WriterError('AGY_INVALID_OUTPUT', 'Provider session init is missing or repeated.');
      const init = event.init as { model?: string; permission_mode?: string } | undefined;
      if (init?.model && init.model !== this.model) throw new WriterError('AGY_MODEL_UNAVAILABLE', 'Provider session initialized a different model.');
      if (!this.nativeWorkspace && init?.permission_mode && init.permission_mode !== 'request-review') throw new WriterError('AGY_SESSION_PERMISSION', 'Provider session requires request-review mode; broad persisted auto-approval was rejected.');
      this.conversationId = event.conversation_id;
      this.progress('initialized');
      return;
    }
    if (event.event === 'step_update') {
      const step = event.step_update as { step_type?: string; state?: string; text_delta?: unknown; tool_info?: unknown; subagent_info?: unknown } | undefined;
      // agy stream-json defines agent_response.text_delta as public answer text.
      // Every other text/reasoning/tool field is deliberately ignored.
      if (this.pending && !this.terminalFailure && step?.step_type === 'agent_response') {
        if (typeof step.text_delta === 'string') this.publicOutput += step.text_delta;
        if (step.state === 'DONE' && this.publicOutput && !this.publicOutput.endsWith('\n')) this.publicOutput += '\n';
      }
      const nativeStep = step?.step_type === 'tool' || step?.step_type === 'subagent' || step?.tool_info || step?.subagent_info;
      if (nativeStep && !this.nativeWorkspace) throw new WriterError('AGY_TOOL_REQUESTED', 'Provider attempted a native tool action; session stopped. Execute only MCP-authorized action JSON.');
      const stepType = nativeStep ? (step?.subagent_info || step?.step_type === 'subagent' ? 'subagent' : 'tool') : step?.step_type;
      if (step && ['user_input', 'agent_response', 'checkpoint', ...(this.nativeWorkspace ? ['tool', 'subagent'] : [])].includes(stepType ?? '') && ['ACTIVE', 'DONE'].includes(step.state ?? '')) {
        if (this.pending) this.pending.stepUpdates++;
        this.progress('activity', { stepType: stepType as ProviderProgress['stepType'], stepState: step.state as ProviderProgress['stepState'] });
      }
      return;
    }
    // New event kinds may add progress without changing the established result protocol.
    if (event.event !== 'result') return;
    const pending = this.pending;
    const result = event.result as Envelope | undefined;
    if (!pending || !result || typeof result !== 'object') throw new WriterError('AGY_INVALID_OUTPUT', 'Provider emitted an unsolicited or malformed result.');
    const diagnosticFailure = this.diagnostics?.poll();
    if (diagnosticFailure) this.lastDiagnostic = diagnosticFailure;
    if (result.status !== 'SUCCESS') {
      this.terminalFailure = result;
      // agy may emit its structured stderr error immediately after the result.
      // Allow that terminal record to arrive, then settle a persistent session.
      clearTimeout(this.terminalFailureTimer);
      this.terminalFailureTimer = setTimeout(() => {
        const error = attachPartial(this.resultError(result), result.response);
        void this.stop(error);
      }, 100);
      return;
    }
    const explicitFailure = terminalAgyFailure(this.stderr);
    if (explicitFailure) throw attachPartial(explicitFailure, result.response);
    if (!this.conversationId || result.conversation_id !== this.conversationId) throw new WriterError('AGY_INVALID_OUTPUT', 'Provider result changed or omitted its conversation ID.');
    if (typeof result.response !== 'string' || !result.response.trim()) throw new WriterError('EMPTY_RESPONSE', 'Provider session returned no text.');
    if (!this.nativeWorkspace && result.response.length > this.config.maxOutputChars) throw new WriterError('OUTPUT_TOO_LARGE', 'Provider response exceeded MAX_OUTPUT_CHARS.');
    if (result.response.includes('\uFFFD')) throw new WriterError('INVALID_UTF8', 'Provider returned damaged UTF-8 text.');
    const usage = result.usage ?? {};
    const delta = (key: string) => {
      const value = usage[key];
      if (value === undefined) return undefined;
      if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < (this.cumulativeUsage[key] ?? 0)) throw new WriterError('AGY_INVALID_OUTPUT', 'Provider cumulative token counters are invalid.');
      const difference = value - (this.cumulativeUsage[key] ?? 0);
      this.cumulativeUsage[key] = value;
      return difference;
    };
    const duration = result.duration_seconds;
    if (duration !== undefined && (typeof duration !== 'number' || !Number.isFinite(duration) || duration < this.cumulativeDuration)) throw new WriterError('AGY_INVALID_OUTPUT', 'Provider cumulative duration is invalid.');
    const elapsedMs = Date.now() - pending.start;
    const response: AgySessionResponse = {
      text: result.response.trim(), provider: 'agy', model: this.model, latencyMs: elapsedMs,
      metrics: { processWallMs: elapsedMs, processPid: this.providerPid, conversationId: this.conversationId, sessionReused: this.completedTurns > 0,
        inputTokens: delta('input_tokens'), outputTokens: delta('output_tokens'), thinkingTokens: delta('thinking_tokens'), cacheReadTokens: delta('cache_read_tokens'),
        providerCumulativeDurationSeconds: typeof duration === 'number' ? duration : undefined,
        providerDurationDeltaSeconds: typeof duration === 'number' ? duration - this.cumulativeDuration : undefined }
    };
    if (typeof duration === 'number') this.cumulativeDuration = duration;
    this.progress('completed');
    this.completedTurns++;
    this.pending = undefined;
    this.publicOutput = '';
    clearInterval(this.monitor); this.monitor = undefined;
    clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort);
    this.idleTimer = setTimeout(() => { void this.close(); }, this.idleTimeoutMs);
    this.idleTimer.unref();
    pending.resolve(response);
  }

  private checkScratch(path: string) {
    if (!resolve(path).startsWith(resolve(tmpdir()) + sep) || !basename(path).startsWith('agy-session-')) throw new WriterError('AGY_CLEANUP_PATH', 'Refusing to remove an unexpected session directory.');
  }
  private resultError(result: Envelope, exitCode?: number | null, signal?: NodeJS.Signals | null): WriterError {
    const detail = typeof result.error === 'string' ? result.error : typeof result.response === 'string' ? result.response : '';
    return sessionError(parseAgyErrorTail(this.stderr) ? this.stderr : detail || this.stderr, typeof result.status === 'string' ? result.status : undefined, exitCode, signal);
  }
  private stop(error: WriterError): Promise<void> {
    if (this.cleanup) return this.cleanup;
    if (this.pending && !error.partial) attachPartial(error, this.publicOutput, 'public_agent_response');
    this.closed = true; this.failure = error;
    const diagnosticPath = this.scratch ? join(this.scratch, 'provider.log') : undefined;
    const retainDiagnostics = !['AGY_SESSION_CLOSED', 'AGY_CANCELLED'].includes(error.code) && diagnosticPath && existsSync(diagnosticPath);
    if (retainDiagnostics) error.diagnostics = { logPath: diagnosticPath! };
    clearTimeout(this.idleTimer);
    clearTimeout(this.terminalFailureTimer);
    clearInterval(this.monitor); this.monitor = undefined;
    this.diagnostics?.close();
    this.progress('failed', { errorCode: error.code });
    const pending = this.pending; this.pending = undefined;
    if (pending) { clearTimeout(pending.timer); pending.signal?.removeEventListener('abort', pending.abort); pending.reject(error); }
    process.off('SIGTERM', this.onShutdown); process.off('SIGINT', this.onShutdown); process.off('exit', this.onExit);
    if (this.child?.pid && this.child.exitCode === null) killTree(this.child.pid);
    this.cleanup = (async () => {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      if (this.processClosed) {
        try { await Promise.race([this.processClosed, new Promise<void>(resolveClose => { cleanupTimer = setTimeout(resolveClose, 3000); })]); }
        finally { clearTimeout(cleanupTimer); }
      }
      if (this.scratch) {
        this.checkScratch(this.scratch);
        // Cleanup errors must not replace the actual provider result or become
        // unhandled rejections from the monitor/idle callback.
        if (!retainDiagnostics) await rm(this.scratch, { recursive: true, force: true }).catch(() => {});
        this.scratch = undefined;
      }
      this.buffer = ''; this.stderr = ''; this.publicOutput = ''; this.terminalFailure = undefined;
    })();
    return this.cleanup;
  }
}
