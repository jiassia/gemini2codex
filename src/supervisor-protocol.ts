import { createHash } from 'node:crypto';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AgentSnapshot } from './agent.js';
import type { ProviderProgress } from './types.js';
import type { Config } from './config.js';

export const supervisorProtocolVersion = 1;
export const supervisorRuntimeVersion = '2.3.0';
export type SupervisorMethod = 'hello' | 'spawn' | 'submit' | 'get' | 'list' | 'sendMessage' | 'followup' | 'cancel' | 'wait' | 'generate' | 'health' | 'shutdown' | 'restartIfIdle';
export interface SupervisorOwner {
  protocol: number;
  pid: number;
  instanceId: string;
  startedAt: string;
  endpoint: string;
  token: string;
  runtimeVersion: string;
  configFingerprint: string;
}
export interface SupervisorUpdate {
  id: string;
  revision: number;
  type: string;
  view?: Pick<AgentSnapshot, 'status' | 'runtime' | 'error'>;
}
export type SupervisorEvent = { event: 'agent'; data: SupervisorUpdate } | { event: 'progress'; requestId: string; data: ProviderProgress };
export interface SupervisorRequest { id: string; method: SupervisorMethod; params?: unknown }
export interface SupervisorCancel { cancel: string }
export interface SupervisorReply { id: string; result?: unknown; error?: Record<string, unknown> }

function digest(value: string) { return createHash('sha256').update(value).digest('hex').slice(0, 24); }

/** Compare execution configuration without writing any secret or proxy value
 * to owner metadata. Runtime version changes are checked independently. */
export function supervisorConfigFingerprint(config: Config, env: NodeJS.ProcessEnv = process.env): string {
  const values = { provider: config.provider, agyCommand: config.agyCommand, agyModel: config.agyModel,
    agyAgentModel: config.agyAgentModel ?? config.agyModel, timeoutMs: config.timeoutMs,
    agentProviderTimeoutMs: config.agentProviderTimeoutMs ?? config.timeoutMs, agentTimeoutMs: config.agentTimeoutMs ?? 0,
    maxInputChars: config.maxInputChars, maxOutputChars: config.maxOutputChars, maxAttempts: config.maxAttempts,
    logLevel: config.logLevel, apiKey: config.provider === 'gemini-api' ? config.apiKey ?? null : null,
    apiModel: config.provider === 'gemini-api' ? config.apiModel ?? null : null, agentMinIntervalMs: config.agentMinIntervalMs ?? 5000 };
  const names = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY'];
  // Windows process.env is case-insensitive but an explicit environment object
  // is not. Node also keeps only the first lexicographic spelling when spawning
  // a Windows child. Canonicalize actual keys using those same semantics so an
  // uppercase-only object matches the child process's lowercase alias lookups.
  const proxies = process.platform === 'win32'
    ? Object.fromEntries(names.map(name => {
      const key = Object.keys(env).filter(candidate => candidate.toUpperCase() === name).sort()[0];
      return [name, key === undefined ? null : env[key] ?? null];
    }))
    : Object.fromEntries([...names, ...names.map(name => name.toLowerCase())].map(key => [key, env[key] ?? null]));
  return createHash('sha256').update(JSON.stringify({ config: values, proxies })).digest('hex');
}

/** One project installation gets one state namespace. The explicit override is
 * useful for portable deployments and keeps test processes fully isolated. */
export function supervisorStateDirectory(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WRITER_STATE_DIR?.trim()) return resolve(env.WRITER_STATE_DIR);
  const installation = fileURLToPath(new URL('../', import.meta.url));
  const key = digest(process.platform === 'win32' ? installation.toLowerCase() : installation);
  return join(env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'gemini-writer-mcp', key);
}

export function supervisorEndpoint(stateDir: string): string {
  const directory = resolve(stateDir);
  const key = digest(process.platform === 'win32' ? directory.toLowerCase() : directory);
  return process.platform === 'win32' ? `\\\\.\\pipe\\gemini-writer-mcp-${key}` : join(tmpdir(), `gemini-writer-mcp-${key}.sock`);
}

export function validOwner(value: unknown, stateDir: string): value is SupervisorOwner {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const owner = value as Partial<SupervisorOwner>;
  return owner.protocol === supervisorProtocolVersion && Number.isSafeInteger(owner.pid) && owner.pid! > 0 &&
    typeof owner.instanceId === 'string' && /^[a-f0-9]{32}$/.test(owner.instanceId) &&
    typeof owner.startedAt === 'string' && Number.isFinite(Date.parse(owner.startedAt)) &&
    owner.endpoint === supervisorEndpoint(stateDir) && typeof owner.token === 'string' && /^[a-f0-9]{64}$/.test(owner.token) &&
    typeof owner.runtimeVersion === 'string' && /^[0-9]+\.[0-9]+\.[0-9]+(?:[-+][A-Za-z0-9.-]+)?$/.test(owner.runtimeVersion) &&
    typeof owner.configFingerprint === 'string' && /^[a-f0-9]{64}$/.test(owner.configFingerprint);
}

/** A reused PID is deliberately treated as live. It may delay recovery but can
 * never authorize killing an unrelated process or launching a second worker. */
export function processExists(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
}
