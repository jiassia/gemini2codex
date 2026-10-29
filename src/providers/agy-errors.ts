import { WriterError, type FailureInfo } from '../types.js';
import { terminalText } from '../utils/sanitize.js';

export interface AgyErrorRecord { status?: string; retryable?: boolean; error_id?: string }

/** agy >=1.2.6 emits one terminal AGY_ERROR JSON line. Only the last
 * column-zero record is authoritative; malformed newer records supersede old ones.
 * short_error contains cloud project/region details and is never returned. */
export function parseAgyErrorTail(stderr: string): AgyErrorRecord | undefined {
  const lines = stderr.split(/\r?\n/).filter(line => line.startsWith('AGY_ERROR:'));
  const last = lines.at(-1);
  if (!last) return;
  let value: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(last.slice('AGY_ERROR:'.length).trim());
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return;
    value = parsed as Record<string, unknown>;
  } catch { return; }
  for (const [key, type] of [['short_error', 'string'], ['retryable', 'boolean'], ['error_id', 'string']] as const) {
    if (value[key] !== undefined && value[key] !== null && typeof value[key] !== type) return;
  }
  const status = typeof value.short_error === 'string' ? value.short_error.match(/^([A-Z][A-Z_]*) \(code \d+\):/)?.[1] : undefined;
  const error_id = typeof value.error_id === 'string' && /^[A-Za-z0-9._:-]{1,128}$/.test(value.error_id) ? value.error_id : undefined;
  const retryable = typeof value.retryable === 'boolean' ? value.retryable : undefined;
  if (!status && !error_id && retryable === undefined) return;
  return { ...(status ? { status } : {}), ...(error_id ? { error_id } : {}), ...(retryable !== undefined ? { retryable } : {}) };
}

const descriptions: Record<string, [string, string, string]> = {
  PROVIDER_RATE_LIMITED: ['quota_exhausted', 'Provider quota or rate limit reached.', 'Review provider quota and the retained diagnostics before a manually requested retry.'],
  PROVIDER_ACCESS_DENIED: ['access_denied', 'Provider access was denied.', 'Check account access, selected model and region; inspect the retained diagnostics and error_id.'],
  AGY_NOT_AUTHENTICATED: ['authentication_failed', 'agy authentication is missing or expired.', 'Sign in interactively with the same local user and proxy environment.'],
  AGY_EFFORT_UNAVAILABLE: ['effort_unavailable', 'Selected model and effort are not compatible.', 'Inspect the exact model and effort supported by the installed agy CLI.'],
  PROVIDER_UNAVAILABLE: ['provider_unavailable', 'Provider model capacity is unavailable.', 'Inspect provider availability and the retained diagnostics before a manually requested retry.'],
  AGY_MODEL_UNAVAILABLE: ['model_unavailable', 'Selected agy model or location is unavailable.', 'Check the configured model, account access and region against agy models.'],
  AGY_INVALID_REQUEST: ['invalid_request', 'Provider rejected the request arguments.', 'Review the selected model, CLI arguments and retained diagnostics.'],
  AGY_TIMEOUT: ['timeout', 'agy reported a response timeout; any partial output is incomplete.', 'Inspect partial output and task state; adjust an explicitly configured timeout before continuing.'],
  AGY_NETWORK_ERROR: ['network_error', 'agy could not reach the provider or its eligibility service, or the connection ended unexpectedly. Inspect the matching agy CLI log under ~/.gemini/antigravity-cli/log.', 'Check inherited proxy connectivity and the retained diagnostics before continuing.'],
  AGY_ELIGIBILITY_FAILED: ['eligibility_failed', 'agy account eligibility validation failed. Inspect the matching agy CLI log under ~/.gemini/antigravity-cli/log.', 'Inspect the retained diagnostics for the eligibility failure and resolve account or network access.'],
  AGY_CANCELLED: ['cancelled', 'agy execution was cancelled or interrupted.', 'Inspect existing file changes before explicitly continuing the task.'],
  AGY_WAITING: ['waiting_for_input', 'agy ended while waiting for input.', 'Inspect the task request and provide the required input.'],
  AGY_EXIT_ERROR: ['agy_error', 'agy execution failed; inspect the retained diagnostics for the final cause. Older CLI diagnostics may be under ~/.gemini/antigravity-cli/log.', 'Inspect the retained diagnostics and error_id before continuing.']
};

function makeError(code: string, record?: AgyErrorRecord): WriterError {
  const [failure_reason, message, recovery] = descriptions[code] ?? descriptions.AGY_EXIT_ERROR;
  return new WriterError(code, message, { failure_reason, recovery,
    ...(record?.retryable !== undefined ? { retryable: record.retryable } : {}),
    ...(record?.error_id ? { error_id: record.error_id } : {}) });
}

export function agyFailure(detail: string, status?: string, exitCode?: number | null, signal?: NodeJS.Signals | null): WriterError {
  const record = parseAgyErrorTail(detail);
  if (record) {
    const codes: Record<string, string> = { RESOURCE_EXHAUSTED: 'PROVIDER_RATE_LIMITED', PERMISSION_DENIED: 'PROVIDER_ACCESS_DENIED', UNAUTHENTICATED: 'AGY_NOT_AUTHENTICATED', NOT_FOUND: 'AGY_MODEL_UNAVAILABLE', UNAVAILABLE: 'PROVIDER_UNAVAILABLE', DEADLINE_EXCEEDED: 'AGY_TIMEOUT', INVALID_ARGUMENT: 'AGY_INVALID_REQUEST' };
    return makeError(codes[record.status ?? ''] ?? 'AGY_EXIT_ERROR', record);
  }
  // Exclude structured payload text and source locations from legacy matching.
  // Bare numeric values in ordinary prose are not HTTP response evidence.
  const text = terminalText(detail).split(/\r?\n/).filter(line => !/^AGY_ERROR:\s*(?:[\[{"]|null\b)/.test(line)).map(line => line.replace(/^AGY_ERROR:\s*/, '')).join('\n').replace(/\b[\w./\\-]+\.go:\d+(?::\d+)?\]?/g, '');
  const http = (code: number) => new RegExp(`\\b(?:HTTP(?:/\\d(?:\\.\\d)?)?|status(?: code)?|code)\\s*[:=(]?\\s*${code}\\b`, 'i').test(text);
  if (http(429) || /rate.?limit|resource.?exhausted|quota.*exceed|too many requests/i.test(text)) return makeError('PROVIDER_RATE_LIMITED');
  if (http(403) || /account.*(?:suspend|restrict)|access denied|permission denied/i.test(text)) return makeError('PROVIDER_ACCESS_DENIED');
  if (http(401) || /sign in|log(?:ged)? ?in|unauthenticated|authentication|token.*expired/i.test(text)) return makeError('AGY_NOT_AUTHENTICATED');
  if (/conflicts with --effort|unsupported.*effort|invalid.*effort/i.test(text)) return makeError('AGY_EFFORT_UNAVAILABLE');
  if (http(503) || /no capacity available/i.test(text)) return makeError('PROVIDER_UNAVAILABLE');
  if (/model.*(?:not found|unavailable|invalid|unknown|unsupported|not supported)|invalid model|unknown model/i.test(text)) return makeError('AGY_MODEL_UNAVAILABLE');
  if (/timed? ?out|timeout|deadline exceeded|time limit/i.test(text)) return makeError('AGY_TIMEOUT');
  if (/network|connection|proxy|dial tcp|no such host|TLS|certificate|ECONN|fetch|unreachable|\bEOF\b/i.test(text)) return makeError('AGY_NETWORK_ERROR');
  if (/eligibility check failed/i.test(text)) return makeError('AGY_ELIGIBILITY_FAILED');
  if (status === 'CANCELED' || status === 'INTERRUPTED') return makeError('AGY_CANCELLED');
  if (status === 'WAITING') return makeError('AGY_WAITING');
  const error = makeError('AGY_EXIT_ERROR');
  if (exitCode !== undefined) error.message += ` (exit code ${exitCode ?? 'none'}${signal ? `, signal ${signal}` : ''}).`;
  return error;
}

/** Only explicit result output or allowlisted public agent_response deltas.
 * No tool arguments, arbitrary step fields or reasoning enter this channel. */
export function attachPartial(error: WriterError, response: unknown, source: NonNullable<FailureInfo['partial']>['source'] = 'result_response'): WriterError {
  const errorDescription = source === 'result_response' && typeof response === 'string' && /^(?:Error:|AGY_ERROR:|Eligibility check failed:|(?:UNAUTHENTICATED|PERMISSION_DENIED|RESOURCE_EXHAUSTED|UNAVAILABLE|NOT_FOUND) \(code \d+\):)/i.test(response.trim());
  if (typeof response === 'string' && response.trim() && !response.includes('\uFFFD') && !errorDescription) error.partial = { text: response, complete: false, source };
  return error;
}

/** A final SUCCESS outranks transient stderr warnings from auth or retries.
 * The known print-timeout variant explicitly declares incomplete output. */
export function terminalAgyFailure(stderr: string): WriterError | undefined {
  if (parseAgyErrorTail(stderr)) return agyFailure(stderr);
  if (stderr.split(/\r?\n/).some(line => /\bpartial output returned\b/i.test(line) && /timed?\s?out|timeout|time limit/i.test(line))) return makeError('AGY_TIMEOUT');
}
