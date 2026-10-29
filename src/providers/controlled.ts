import { setTimeout as delay } from 'node:timers/promises';
import type { Config } from '../config.js';
import { WriterError, type WriterProvider, type WriterRequest, type AgentProviderSession, type GenerationOptions } from '../types.js';

/** One provider call at a time, including writing calls. Never retry or switch identities. */
export class ControlledProvider implements WriterProvider {
  private tail: Promise<void> = Promise.resolve();
  private next = 0;
  private cooldownUntil = 0;
  private blocked?: string;
  constructor(private config: Config, private delegate: WriterProvider) {}
  private recordFailure(code: string) {
    if (code === 'PROVIDER_RATE_LIMITED') this.cooldownUntil = Date.now() + 60000;
    if (['PROVIDER_ACCESS_DENIED', 'AGY_NOT_AUTHENTICATED', 'API_NOT_AUTHENTICATED'].includes(code)) this.blocked = code;
  }
  private async call<T>(operation: () => Promise<T>, signal?: AbortSignal, probe = false): Promise<T> {
    const prior = this.tail;
    let release!: () => void;
    const current = new Promise<void>(resolve => { release = resolve; });
    // A cancelled waiter returns immediately, but later calls still wait for prior.
    this.tail = prior.then(() => current);
    try {
      await new Promise<void>((resolve, reject) => {
        const abort = () => { signal?.removeEventListener('abort', abort); reject(signal?.reason); };
        signal?.addEventListener('abort', abort, { once: true });
        prior.then(() => { signal?.removeEventListener('abort', abort); resolve(); });
        if (signal?.aborted) abort();
      });
      signal?.throwIfAborted();
      if (this.blocked && !probe) throw new WriterError('PROVIDER_PAUSED', `Provider requests paused after ${this.blocked}. Resolve access and use explicit gemini_health or restart the MCP.`);
      if (Date.now() < this.cooldownUntil) throw new WriterError('PROVIDER_COOLDOWN', 'Provider is cooling down after a quota response. Wait at least 60 seconds before submitting a new task.');
      await delay(Math.max(0, this.next - Date.now()), undefined, { signal });
      try {
        const result = await operation();
        if (probe) {
          const error = (result as { error?: { code: string } }).error;
          if (error) this.recordFailure(error.code); else this.blocked = undefined;
        }
        return result;
      } catch (error) {
        if (error instanceof WriterError) {
          this.recordFailure(error.code);
        }
        throw error;
      } finally { this.next = Math.max(this.next, Date.now() + (this.config.agentMinIntervalMs ?? 5000)); }
    } finally { release(); }
  }
  generate(request: WriterRequest, options?: GenerationOptions) { return this.call(() => this.delegate.generate(request, options), options?.signal); }
  generateAgent(prompt: string, signal?: AbortSignal, effort: 'medium' | 'high' = 'high', session?: AgentProviderSession) {
    if (!this.delegate.generateAgent) throw new WriterError('AGENT_UNSUPPORTED_PROVIDER', 'Provider lacks agent support.');
    return this.call(() => this.delegate.generateAgent!(prompt, signal, effort, session), signal);
  }
  async close() { await this.delegate.close?.(); }
  health() { return this.call(() => this.delegate.health(), undefined, true); }
}
