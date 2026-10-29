import { WriterError } from '../types.js';
export function terminalText(raw: string): string {
  // Normalize CLI display output; writing responses use the native JSON envelope.
  const lastClear = raw.lastIndexOf('\x1b[2J');
  if (lastClear !== -1) raw = raw.slice(lastClear + 4);
  raw = raw.replace(/[⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏] Fetching available models\.\.\./g, '');
  return raw.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '').replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '').replace(/\x1b[()][A-Z0-9]/g, '').replace(/\r\n/g, '\n').replace(/\r/g, '\n').replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '').trim();
}
export function validateInput(source: string, maxChars: number) {
  if (source.length > maxChars) throw new WriterError('INPUT_TOO_LARGE', `Input contains ${source.length} characters; MAX_INPUT_CHARS=${maxChars}. Extract relevant facts or split into coherent sections.`);
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\b(?:sk-[A-Za-z0-9_-]{20,}|AIza[A-Za-z0-9_-]{30,})\b|\b(?:API_KEY|ACCESS_TOKEN|PASSWORD|SECRET)\s*[:=]\s*["']?[^\s"']+/i.test(source)) throw new WriterError('SENSITIVE_INPUT', 'Input appears to contain credentials. Redact them before delegation.');
}
export function parseReview(text: string): { safe: boolean; issues: unknown[]; suggestion: string } {
  const body = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '');
  let result: unknown;
  try { result = JSON.parse(body); } catch { throw new WriterError('INVALID_REVIEW_OUTPUT', 'Model review did not return valid JSON. Codex must review the draft directly.'); }
  if (!result || typeof result !== 'object') throw new WriterError('INVALID_REVIEW_OUTPUT', 'Review must be an object.');
  const value = result as Record<string, unknown>;
  if (typeof value.safe !== 'boolean' || !Array.isArray(value.issues) || typeof value.suggestion !== 'string' || (value.safe && value.issues.length)) throw new WriterError('INVALID_REVIEW_OUTPUT', 'Review fields are invalid or internally inconsistent.');
  return { safe: value.safe, issues: value.issues, suggestion: value.suggestion };
}
