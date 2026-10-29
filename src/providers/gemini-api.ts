import { EnvHttpProxyAgent, fetch } from 'undici';
import type { Config } from '../config.js';
import { buildPrompt } from '../prompts/writer.js';
import { WriterError, type WriterProvider, type WriterRequest, type WriterResponse, type Health, type GenerationOptions } from '../types.js';
export class GeminiApiProvider implements WriterProvider {
  constructor(private config: Config) {}
  async generate(request: WriterRequest, options?: GenerationOptions): Promise<WriterResponse> {
    return this.invoke(buildPrompt(request), request.operation === 'review', options?.signal);
  }
  async generateAgent(prompt: string, signal?: AbortSignal, effort: 'medium' | 'high' = 'high'): Promise<WriterResponse> {
    return this.invoke(prompt, true, signal, effort);
  }
  private async invoke(prompt: string, json = false, signal?: AbortSignal, effort: 'medium' | 'high' = 'medium'): Promise<WriterResponse> {
    if (!this.config.apiKey || !this.config.apiModel) throw new WriterError('API_NOT_CONFIGURED', 'Explicit Gemini API provider requires GEMINI_API_KEY and GEMINI_API_MODEL. agy credentials are not reused.');
    const start = Date.now();
    const timeoutMs = effort === 'high' ? this.config.agentProviderTimeoutMs ?? this.config.timeoutMs : this.config.timeoutMs;
    const deadline = timeoutMs > 0 ? AbortSignal.timeout(timeoutMs) : undefined;
    const requestSignal = signal && deadline ? AbortSignal.any([signal, deadline]) : signal ?? deadline;
    const dispatcher = new EnvHttpProxyAgent({ httpProxy: process.env.HTTP_PROXY ?? process.env.ALL_PROXY, httpsProxy: process.env.HTTPS_PROXY ?? process.env.ALL_PROXY, noProxy: process.env.NO_PROXY });
    try {
      const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(this.config.apiModel)}:generateContent`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': this.config.apiKey }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }] }], generationConfig: { temperature: 0.2, thinkingConfig: { thinkingLevel: effort === 'high' ? 'high' : 'medium' }, ...(json ? { responseMimeType: 'application/json' } : {}) } }), dispatcher, signal: requestSignal });
      if (!response.ok) {
        // Release unfinished error bodies before close waits for their connection.
        await response.body?.cancel().catch(() => {});
        throw new WriterError(response.status === 429 ? 'PROVIDER_RATE_LIMITED' : response.status === 403 ? 'PROVIDER_ACCESS_DENIED' : response.status === 401 ? 'API_NOT_AUTHENTICATED' : response.status === 404 ? 'API_MODEL_UNAVAILABLE' : 'API_HTTP_ERROR', `Gemini API returned HTTP ${response.status}.`);
      }
      const data = await response.json() as { candidates?: { content?: { parts?: { text?: string }[] }; finishReason?: string }[] };
      const candidate = data.candidates?.[0];
      if (candidate?.finishReason !== 'STOP') throw new WriterError('API_INCOMPLETE_RESPONSE', `Gemini API did not finish normally (${candidate?.finishReason ?? 'no candidate'}); partial text was not returned.`);
      const text = candidate.content?.parts?.map(part => part.text ?? '').join('').trim() ?? '';
      if (!text) throw new WriterError('EMPTY_RESPONSE', 'Gemini API returned no text.');
      if (text.length > this.config.maxOutputChars) throw new WriterError('OUTPUT_TOO_LARGE', 'Response exceeds MAX_OUTPUT_CHARS.');
      return { text, provider: 'gemini-api', model: this.config.apiModel, latencyMs: Date.now() - start };
    } catch (error) {
      if (signal?.aborted) throw new WriterError('API_CANCELLED', 'Gemini API request was cancelled.');
      if (error instanceof WriterError) throw error;
      if (error instanceof Error && /Timeout|Abort/.test(error.name)) throw new WriterError('API_TIMEOUT', 'Gemini API request timed out.');
      throw new WriterError('API_NETWORK_ERROR', 'Gemini API could not be reached. Check proxy settings.');
    } finally { await dispatcher.close(); }
  }
  async health(): Promise<Health> {
    const start = Date.now();
    const result: Health = { provider: 'gemini-api', agyInstalled: false, authenticated: null, modelAvailable: null, model: this.config.apiModel ?? '', latencyMs: 0 };
    try {
      const answer = await this.generate({ operation: 'polish', source: 'READY', instruction: 'Return exactly READY' });
      if (answer.text !== 'READY') throw new WriterError('API_HEALTH_RESPONSE', 'Health probe did not return the expected READY response.');
      result.authenticated = true; result.modelAvailable = true;
    }
    catch (error) { if (!(error instanceof WriterError)) throw error; result.error = { code: error.code, message: error.message }; if (error.code === 'API_NOT_AUTHENTICATED') result.authenticated = false; }
    result.latencyMs = Date.now() - start; return result;
  }
}
