import type { Config } from '../config.js';
import { buildPrompt } from '../prompts/writer.js';
import { WriterError, errorInfo, type WriterProvider, type WriterRequest, type WriterResponse, type Health, type AgentProviderSession, type ProviderProgress } from '../types.js';
import { runProbe, runSubprocess, type RunResult } from '../utils/subprocess.js';
import { terminalText } from '../utils/sanitize.js';
import { AgySession, type AgySessionOptions } from './agy-session.js';
import { agyFailure, attachPartial, parseAgyErrorTail, terminalAgyFailure } from './agy-errors.js';
export function checkAgyOutput(text: string, exitCode: number): string {
  const failure = terminalAgyFailure(text);
  if (failure) throw failure;
  if (exitCode !== 0) throw agyFailure(text, undefined, exitCode);
  const response = text.replace(/^Warning:[^\n]*\n/gm, '').trim();
  if (!response) throw new WriterError('EMPTY_RESPONSE', 'agy returned no text. Check login and non-interactive print capability.');
  if (response.includes('\uFFFD')) throw new WriterError('INVALID_UTF8', 'Response contains replacement characters; no damaged text was returned.');
  return response;
}
export function parseAgyResponse(result: RunResult): string {
  let envelope: { status?: string; response?: string; error?: string; num_turns?: number };
  try { envelope = JSON.parse(result.text); } catch {
    if (parseAgyErrorTail(result.stderr) || result.exitCode !== 0 || /^(?:Error:|error:|AGY_ERROR:)/m.test(result.stderr + result.text)) throw agyFailure(result.stderr + '\n' + result.text, undefined, result.exitCode);
    throw new WriterError('AGY_INVALID_OUTPUT', 'agy did not return its native JSON envelope. Inspect installed CLI output-format support.');
  }
  if (!envelope || typeof envelope !== 'object' || Array.isArray(envelope)) throw new WriterError('AGY_INVALID_OUTPUT', 'agy JSON output is not a result object.');
  const explicitFailure = terminalAgyFailure(result.stderr);
  if (explicitFailure || result.exitCode !== 0 || envelope.status !== 'SUCCESS') {
    const detail = typeof envelope.error === 'string' ? envelope.error : envelope.status !== 'SUCCESS' && typeof envelope.response === 'string' ? envelope.response : '';
    throw attachPartial(explicitFailure ?? agyFailure(detail || result.stderr, envelope.status, result.exitCode), envelope.response);
  }
  if (typeof envelope.response !== 'string') throw new WriterError('EMPTY_RESPONSE', 'agy JSON result has no response string.');
  if (!envelope.response.trim()) throw new WriterError('EMPTY_RESPONSE', 'agy returned an empty response.');
  if (envelope.response.includes('\uFFFD')) throw new WriterError('INVALID_UTF8', 'Response contains replacement characters.');
  return envelope.response.trim();
}
export class AgyProvider implements WriterProvider {
  private cliVersion?: string;
  private active?: { id: string; epoch: string; effort: string; nativeWorkspace?: string; chars: number; session: Pick<AgySession, 'ask' | 'close' | 'isClosed'>; snapshot?: { prefix: string; context: Record<string, unknown> } };
  constructor(private config: Config, private makeSession: (model: string, effort: 'medium' | 'high', timeoutMs: number, options?: AgySessionOptions) => Pick<AgySession, 'ask' | 'close' | 'isClosed'> = (model, effort, timeoutMs, options) => new AgySession({ ...config, timeoutMs }, model, effort, options)) {}
  async close(): Promise<void> {
    const active = this.active; this.active = undefined;
    await active?.session.close();
  }
  private snapshot(prompt: string) {
    const marker = '\nHistory: ';
    const index = prompt.lastIndexOf(marker);
    if (index < 0) return undefined;
    try {
      const context = JSON.parse(prompt.slice(index + marker.length));
      if (!context || typeof context !== 'object' || Array.isArray(context)) return undefined;
      return { prefix: prompt.slice(0, index).replace(/Remaining turns: \d+\./, 'Remaining turns: N.'), context: context as Record<string, unknown> };
    } catch { return undefined; }
  }
  private delta(prompt: string, current: NonNullable<ReturnType<AgyProvider['snapshot']>>, prior: NonNullable<ReturnType<AgyProvider['snapshot']>>): string {
    if (current.prefix !== prior.prefix) return prompt;
    const changes: Record<string, unknown> = {};
    const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
    for (const [key, value] of Object.entries(current.context)) {
      if (equal(value, prior.context[key])) continue;
      if (key === 'files' && Array.isArray(value) && Array.isArray(prior.context.files)) {
        const old = new Map((prior.context.files as { path: string; content?: string }[]).map(file => [file.path, file]));
        changes.files = value.map(file => file && typeof file === 'object' && typeof file.content === 'string' && old.get(file.path)?.content === file.content
          ? { path: file.path, contentUnchanged: true } : file);
      } else if (key === 'observations' && Array.isArray(value) && Array.isArray(prior.context.observations)) {
        const old = prior.context.observations;
        changes.observations = old.length <= value.length && old.every((item, index) => equal(item, value[index])) ? value.slice(old.length) : value;
      } else changes[key] = value;
    }
    const remaining = prompt.match(/Remaining turns: (\d+)\./)?.[1];
    const update = `Continue the same MCP agent using its existing goal, permissions and JSON protocol. This is an authoritative MCP context update: fields not included remain unchanged; included fields replace older values. observations contains the latest executed-action feedback. contentUnchanged refers to the body already provided for that path, which remains current in this run. Only actions with execution feedback have run. Follow all new parent instructions. Remaining turns: ${remaining ?? 'as previously specified'}.\nContext update: ${JSON.stringify(changes)}`;
    return update.length < prompt.length ? update : prompt;
  }
  async probe(): Promise<void> {
    const version = await runProbe(this.config.agyCommand, ['--version'], 10000, true);
    this.cliVersion = version.exitCode === 0 ? version.text.match(/\b(\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\b/)?.[1] : undefined;
    const help = await runProbe(this.config.agyCommand, ['--help'], 10000, true);
    if (help.exitCode !== 0 || !['--print', '--model', '--sandbox', '--print-timeout', '--output-format', '--disable-slash-commands'].every(flag => help.text.includes(flag))) throw new WriterError('AGY_UNSUPPORTED_CLI', 'Installed agy lacks required print interface capabilities. Inspect the installed CLI help and compatibility information.');
  }
  private async invoke(prompt: string, timeoutMs = this.config.timeoutMs, signal?: AbortSignal, effort: 'medium' | 'high' = 'medium', model = this.config.agyModel): Promise<{ text: string; metrics: WriterResponse['metrics'] }> {
    const started = Date.now();
    // A JSON character can occupy six wire characters (for example \\u0001).
    // The decoded response is checked against the actual text limit below.
    const result = await runSubprocess(this.config.agyCommand, ['--model', model, '--effort', effort, '--sandbox', '--disable-slash-commands', '--output-format', 'json', ...(timeoutMs > 0 ? ['--print-timeout', `${Math.max(1, Math.ceil(timeoutMs / 1000))}s`] : []), '-p', prompt], { timeoutMs, maxOutputChars: this.config.maxOutputChars * 6, signal, hiddenConsole: true });
    const response = parseAgyResponse(result);
    if (response.length > this.config.maxOutputChars) throw new WriterError('OUTPUT_TOO_LARGE', 'Response exceeds MAX_OUTPUT_CHARS; no truncated text was returned.');
    const envelope = JSON.parse(result.text) as { duration_seconds?: number; usage?: Record<string, number> };
    const usage = envelope.usage ?? {};
    return { text: response, metrics: { processWallMs: Date.now() - started, providerDurationSeconds: envelope.duration_seconds,
      inputTokens: usage.input_tokens, outputTokens: usage.output_tokens, thinkingTokens: usage.thinking_tokens, cacheReadTokens: usage.cache_read_tokens } };
  }
  async generate(request: WriterRequest, options?: { signal?: AbortSignal; onProgress?: (progress: ProviderProgress) => void }): Promise<WriterResponse> {
    await this.close();
    const start = Date.now();
    const session = this.makeSession(this.config.agyModel, 'medium', this.config.timeoutMs);
    this.active = { id: 'writing', epoch: 'writing', effort: 'medium', chars: 0, session };
    try {
      const response = await session.ask(buildPrompt(request), options?.signal, options?.onProgress);
      return { ...response, provider: 'agy', model: this.config.agyModel, latencyMs: Date.now() - start };
    } finally {
      if (this.active?.session === session) await this.close();
      else await session.close();
    }
  }
  async generateAgent(prompt: string, signal?: AbortSignal, effort: 'medium' | 'high' = 'high', session?: AgentProviderSession): Promise<WriterResponse> {
    const start = Date.now();
    const model = effort === 'medium' ? this.config.agyModel : this.config.agyAgentModel ?? this.config.agyModel;
    if (session) {
      // Native history is discarded whenever bounded MCP context evicts contents or a run resumes.
      // Also cap accumulated prompt+response text; --continue would preserve the evicted history.
      if (this.active && (this.active.id !== session.id || this.active.epoch !== session.epoch || this.active.effort !== effort || this.active.nativeWorkspace !== session.nativeTools?.workspace || this.active.session.isClosed)) await this.close();
      const snapshot = session.nativeTools ? undefined : this.snapshot(prompt);
      let sentPrompt = snapshot && this.active?.snapshot ? this.delta(prompt, snapshot, this.active.snapshot) : prompt;
      if (!session.nativeTools && this.active && this.active.chars + sentPrompt.length > this.config.maxInputChars) { await this.close(); sentPrompt = prompt; }
      if (!this.active) this.active = { id: session.id, epoch: session.epoch, effort, nativeWorkspace: session.nativeTools?.workspace, chars: 0, session: this.makeSession(model, effort, session.nativeTools ? this.config.agentTimeoutMs ?? 0 : effort === 'high' ? this.config.agentProviderTimeoutMs ?? this.config.timeoutMs : this.config.timeoutMs, session.nativeTools ? { nativeTools: session.nativeTools } : undefined) };
      const active = this.active;
      try {
        const response = await active.session.ask(sentPrompt, signal, session.onProgress);
        active.chars += sentPrompt.length + response.text.length;
        active.snapshot = snapshot;
        return { ...response, metrics: { ...response.metrics, sentPromptChars: sentPrompt.length, fullPromptChars: prompt.length, contextDelta: sentPrompt !== prompt } };
      } catch (error) { await this.close(); throw error; }
    }
    await this.close();
    return { ...await this.invoke(prompt, effort === 'high' ? this.config.agentProviderTimeoutMs ?? this.config.timeoutMs : this.config.timeoutMs, signal, effort, model), provider: 'agy', model, latencyMs: Date.now() - start };
  }
  async health(generateProbe = true): Promise<Health> {
    await this.close();
    const start = Date.now();
    const result: Health = { agyInstalled: false, authenticated: null, modelAvailable: null, agentModel: this.config.agyAgentModel ?? this.config.agyModel, agentModelAvailable: null, provider: 'agy', model: this.config.agyModel, latencyMs: 0 };
    try {
      await this.probe(); result.agyInstalled = true;
      result.cliVersion = this.cliVersion;
      result.compatibility = { protocol: 'stream-json:init/step_update/result', verifiedVersions: ['1.3.1', '1.4.9'], versionVerified: ['1.3.1', '1.4.9'].includes(this.cliVersion ?? ''), capabilities: ['print', 'model', 'sandbox', 'print-timeout', 'output-format', 'disable-slash-commands'] };
      const models = await runSubprocess(this.config.agyCommand, ['models'], { timeoutMs: this.config.timeoutMs > 0 ? Math.min(30000, this.config.timeoutMs) : 30000, maxOutputChars: 20000, hiddenConsole: true });
      const names = checkAgyOutput(terminalText(models.text + '\n' + models.stderr), models.exitCode);
      result.authenticated = true;
      result.modelAvailable = names.split('\n').some(line => line.trim() === this.config.agyModel || line.trim().split(/\s+/)[0] === this.config.agyModel || line.trim().endsWith('\t' + this.config.agyModel));
      result.agentModelAvailable = names.split('\n').some(line => line.trim() === result.agentModel || line.trim().split(/\s+/)[0] === result.agentModel || line.trim().endsWith('\t' + result.agentModel));
      if (!result.modelAvailable) throw new WriterError('AGY_MODEL_UNAVAILABLE', 'Configured AGY_MODEL is absent from the current agy models list.');
      if (!result.agentModelAvailable) throw new WriterError('AGY_AGENT_MODEL_UNAVAILABLE', 'Configured AGY_AGENT_MODEL is absent from the current agy models list.');
      if (generateProbe) {
        const remaining = this.config.timeoutMs > 0 ? this.config.timeoutMs - (Date.now() - start) : 0;
        if (this.config.timeoutMs > 0 && remaining < 1) throw new WriterError('AGY_TIMEOUT', 'Health check exhausted WRITER_TIMEOUT_MS.');
        const answer = await this.invoke('Do not use tools. Reply with exactly READY.', remaining);
        if (answer.text !== 'READY') throw new WriterError('AGY_HEALTH_RESPONSE', 'Health probe did not return the expected READY response.');
      }
    } catch (error) {
      if (!(error instanceof WriterError)) throw error;
      if (error.code === 'AGY_NOT_AUTHENTICATED') result.authenticated = false;
      if (error.code === 'AGY_MODEL_UNAVAILABLE') result.modelAvailable = false;
      result.error = errorInfo(error);
    }
    result.latencyMs = Date.now() - start;
    return result;
  }
}
