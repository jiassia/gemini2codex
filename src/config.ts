import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
import { WriterError } from './types.js';
export const projectRoot = fileURLToPath(new URL('../', import.meta.url));
dotenv({ path: fileURLToPath(new URL('../.env', import.meta.url)), quiet: true });
export interface Config { provider: 'agy' | 'gemini-api'; agyCommand: string; agyModel: string; agyAgentModel?: string; timeoutMs: number; agentProviderTimeoutMs?: number; maxInputChars: number; maxOutputChars: number; maxAttempts: number; logLevel: 'silent' | 'error' | 'info' | 'debug'; apiKey?: string; apiModel?: string; agentMinIntervalMs?: number; agentTimeoutMs?: number }
function integer(env: NodeJS.ProcessEnv, name: string, fallback: number, maximum = Number.MAX_SAFE_INTEGER, minimum = 1) {
  const value = Number(env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) throw new WriterError('CONFIG_ERROR', `${name} must be ${minimum === 0 ? 'a nonnegative' : 'a positive'} integer${maximum < Number.MAX_SAFE_INTEGER ? ` no greater than ${maximum}` : ''}.`);
  return value;
}
// Node truncates larger timer delays to 1 ms, making an increased timeout fail immediately.
const maximumTimerDelay = 2_147_483_647;
function requiredText(env: NodeJS.ProcessEnv, name: string, fallback: string) {
  const value = env[name] ?? fallback;
  if (!value.trim()) throw new WriterError('CONFIG_ERROR', `${name} must not be empty.`);
  return value;
}
export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const provider = env.WRITER_PROVIDER ?? 'agy';
  if (provider !== 'agy' && provider !== 'gemini-api') throw new WriterError('CONFIG_ERROR', 'WRITER_PROVIDER must be agy or gemini-api.');
  const logLevel = env.LOG_LEVEL ?? 'info';
  if (!['silent', 'error', 'info', 'debug'].includes(logLevel)) throw new WriterError('CONFIG_ERROR', 'Invalid LOG_LEVEL.');
  const maxAttempts = integer(env, 'MAX_ATTEMPTS', 1);
  if (maxAttempts !== 1) throw new WriterError('CONFIG_ERROR', 'MAX_ATTEMPTS must be 1; retries are controlled by Codex, not this server.');
  return { provider, agyCommand: requiredText(env, 'AGY_COMMAND', 'agy'), agyModel: requiredText(env, 'AGY_MODEL', 'gemini-3.8-flash-medium'), agyAgentModel: requiredText(env, 'AGY_AGENT_MODEL', 'gemini-3.8-flash-high'), timeoutMs: integer(env, 'WRITER_TIMEOUT_MS', 0, maximumTimerDelay, 0), agentProviderTimeoutMs: integer(env, 'AGENT_PROVIDER_TIMEOUT_MS', 0, maximumTimerDelay, 0), maxInputChars: integer(env, 'MAX_INPUT_CHARS', 24000), maxOutputChars: integer(env, 'MAX_OUTPUT_CHARS', 100000), maxAttempts, logLevel: logLevel as Config['logLevel'], apiKey: env.GEMINI_API_KEY, apiModel: env.GEMINI_API_MODEL, agentMinIntervalMs: integer(env, 'AGENT_MIN_INTERVAL_MS', 5000, maximumTimerDelay), agentTimeoutMs: integer(env, 'AGENT_TIMEOUT_MS', 0, maximumTimerDelay, 0) };
}
