export type Operation = 'write' | 'polish' | 'rewrite' | 'review';
export interface WriterRequest { operation: Operation; source: string; instruction?: string; language?: string; style?: string; revised?: string; max_attempts?: number }
export interface WriterResponse { text: string; provider: string; model: string; latencyMs: number; metrics?: { providerDurationSeconds?: number; inputTokens?: number; outputTokens?: number; thinkingTokens?: number; cacheReadTokens?: number; processWallMs?: number; providerCumulativeDurationSeconds?: number; providerDurationDeltaSeconds?: number; sessionReused?: boolean; processPid?: number; conversationId?: string; sentPromptChars?: number; fullPromptChars?: number; contextDelta?: boolean } }
export interface Health { agyInstalled: boolean; authenticated: boolean | null; modelAvailable: boolean | null; model: string; agentModel?: string; agentModelAvailable?: boolean | null; cliVersion?: string; compatibility?: { protocol: string; verifiedVersions: string[]; versionVerified: boolean; capabilities: string[] }; latencyMs: number; provider: string; error?: FailureInfo }
export interface ProviderProgress {
  stage: 'starting' | 'submitted' | 'initialized' | 'activity' | 'waiting' | 'retrying' | 'completed' | 'failed';
  time: string; elapsedMs: number; timeoutMs: number; stepUpdates: number; sessionReused: boolean;
  processPid?: number; conversationId?: string; silentMs?: number;
  stepType?: 'user_input' | 'agent_response' | 'checkpoint' | 'tool' | 'subagent'; stepState?: 'ACTIVE' | 'DONE'; errorCode?: string;
}
export interface AgentProviderSession { id: string; epoch: string; nativeTools?: { workspace: string }; onProgress?: (progress: ProviderProgress) => void }
export interface GenerationOptions { signal?: AbortSignal; onProgress?: (progress: ProviderProgress) => void }
export interface WriterProvider { generate(request: WriterRequest, options?: GenerationOptions): Promise<WriterResponse>; health(): Promise<Health>; generateAgent?(prompt: string, signal?: AbortSignal, effort?: 'medium' | 'high', session?: AgentProviderSession): Promise<WriterResponse>; close?(): Promise<void> }
export interface FailureInfo {
  code: string; message: string; failure_reason?: string; retryable?: boolean; error_id?: string;
  partial?: { text: string; complete: false; source: 'result_response' | 'public_agent_response' };
  recovery?: string; diagnostics?: { logPath: string };
}
export class WriterError extends Error {
  diagnostics?: { logPath: string };
  failure_reason?: string; retryable?: boolean; error_id?: string;
  partial?: FailureInfo['partial']; recovery?: string;
  constructor(public code: string, message: string, details?: Omit<FailureInfo, 'code' | 'message'>) {
    super(message); this.name = 'WriterError'; Object.assign(this, details);
  }
}
export function errorInfo(error: unknown): FailureInfo {
  return error instanceof WriterError ? { code: error.code, message: error.message,
    failure_reason: error.failure_reason ?? error.code.toLowerCase(),
    ...(error.retryable !== undefined ? { retryable: error.retryable } : {}),
    ...(error.error_id ? { error_id: error.error_id } : {}),
    ...(error.partial ? { partial: error.partial } : {}),
    recovery: error.recovery ?? 'Inspect the retained diagnostics and current task state before deciding how to continue.',
    ...(error.diagnostics ? { diagnostics: error.diagnostics } : {})
  } : { code: 'INTERNAL_ERROR', message: 'Unexpected writer error. See local diagnostics; no prompt content was logged.', failure_reason: 'internal_error', recovery: 'Inspect the local diagnostics before continuing.' };
}
