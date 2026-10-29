import { WriterError } from './types.js';
import { normalize, sep } from 'node:path';

type Role = 'codex' | 'gemini';
type Observation = { action: Record<string, unknown>; result: unknown };
type FileContext = { path: string; content?: string; omitted?: true; reread?: true };
type Report = { summary: string; truncated?: true };
const note = 'Omitted file contents must be read again when needed. Context summaries never replace reading the current file before editing.';
const length = (value: unknown) => (JSON.stringify(value) ?? 'null').length;
function excerpt(text: string, max: number, tail = false) {
  if (text.length <= max) return text;
  const marker = '[earlier text omitted] ';
  return tail ? marker + text.slice(-Math.max(0, max - marker.length)) : text.slice(0, Math.max(0, max - 18)) + '[text truncated]';
}

/** Deterministic feedback reduction; never invents a language-model summary. */
function feedback(result: unknown, limit: number): unknown {
  if (length(result) <= limit) return structuredClone(result);
  const compact = (value: unknown, chars: number, depth: number): unknown => {
    if (typeof value === 'string') return excerpt(value, chars, true);
    if (Array.isArray(value)) {
      if (depth === 0) return { omitted: true, items: value.length };
      return value.length <= 4 ? value.map(item => compact(item, chars, depth - 1))
        : [...value.slice(0, 2).map(item => compact(item, chars, depth - 1)), { omittedItems: value.length - 4 }, ...value.slice(-2).map(item => compact(item, chars, depth - 1))];
    }
    if (value && typeof value === 'object') {
      const entries = Object.entries(value);
      if (depth === 0) return { omitted: true, keys: entries.slice(0, 12).map(([key]) => key) };
      const priority = ['error', 'code', 'message', 'exitCode', 'passed', 'success', 'status', 'errors', 'failures', 'warnings', 'diagnostics', 'stderr', 'text', 'stdout'];
      entries.sort(([a], [b]) => {
        const ai = priority.indexOf(a), bi = priority.indexOf(b);
        return (ai < 0 ? 100 : ai) - (bi < 0 ? 100 : bi);
      });
      const output = Object.fromEntries(entries.slice(0, 16).map(([key, item]) => [key, compact(item, chars, depth - 1)]));
      if (entries.length > 16) output.omittedKeys = entries.slice(16).map(([key]) => key).slice(0, 16);
      return output;
    }
    return value;
  };
  for (const chars of [800, 300, 100, 40]) {
    const reduced = compact(result, chars, 3);
    if (length(reduced) <= limit) return reduced;
  }
  // Preserve useful terminal flags and the diagnostic tail even for huge nested results.
  const record = result && typeof result === 'object' && !Array.isArray(result) ? result as Record<string, unknown> : {};
  const flags = Object.fromEntries(['exitCode', 'passed', 'success', 'status', 'code'].filter(key => key in record).map(key => [key, compact(record[key], 40, 1)]));
  const diagnostic = record.error ?? record.stderr ?? record.diagnostics ?? record.errors ?? record.text ?? result;
  const summary = { ...flags, truncated: true, feedback: excerpt(typeof diagnostic === 'string' ? diagnostic : JSON.stringify(compact(diagnostic, 80, 2)), Math.max(40, limit - length(flags) - 60), true) };
  return summary;
}

/** Bounded context only. File-read authorization remains the caller's responsibility. */
export class AgentContext {
  private parentInstructions: string[] = [];
  private messages: { role: Role; text: string; truncated?: true }[] = [];
  private reports: Report[] = [];
  private files = new Map<string, FileContext>();
  private unreadFileContexts = new Set<string>();
  private changes = new Map<string, { path: string; action: string }>();
  private observations: Observation[] = [];
  private counters = { compactions: 0, evictedFileContents: 0, renderedChars: 0 };
  constructor(private goal: string, private maxChars: number) {
    if (!Number.isSafeInteger(maxChars) || maxChars < 1) throw new WriterError('INPUT_TOO_LARGE', 'Context budget must be a positive integer.');
    this.requireMessage(goal);
  }
  get stats() { return { ...this.counters }; }
  setGoal(goal: string) { this.requireMessage(goal); this.goal = goal; }
  addMessage(role: Role, text: string) {
    this.requireMessage(text);
    if (role === 'codex') this.parentInstructions = [...this.parentInstructions, text].slice(-3);
    else this.messages = [...this.messages, { role, text }].slice(-3);
  }
  recordReport(summary: string) {
    const shortened = excerpt(summary, this.maxChars);
    this.reports = [...this.reports, { summary: shortened, ...(shortened !== summary ? { truncated: true as const } : {}) }].slice(-3);
  }
  observe(action: object, result: unknown) {
    const original = action as Record<string, unknown>;
    const stored = structuredClone(original);
    const path = typeof original.path === 'string' ? normalize(original.path).split(sep).join('/') : undefined;
    if (path !== undefined) stored.path = path;
    // Generated bodies belong on disk; retain only the write identity in context.
    if (original.action === 'write_file') delete stored.content;
    const record = result && typeof result === 'object' ? result as Record<string, unknown> : {};
    if (path && original.action === 'read_file' && typeof record.content === 'string') {
      if (this.files.get(path)?.content !== undefined && this.files.get(path)?.content !== record.content) this.counters.evictedFileContents++;
      this.files.delete(path);
      this.files.set(path, { path, content: record.content });
      this.unreadFileContexts.add(path);
      result = { path, fileContext: true };
    } else if (path && original.action === 'write_file' && !record.error && !record.discarded) {
      this.evictFile(path);
      this.files.delete(path);
      this.files.set(path, { path, omitted: true, reread: true });
      this.changes.delete(path);
      this.changes.set(path, { path, action: 'write_file' });
    }
    if (this.observations.length) {
      const previous = this.observations.at(-1)!;
      previous.result = feedback(previous.result, Math.max(128, Math.floor(this.maxChars / 8)));
    }
    this.observations.push({ action: stored, result: feedback(result, Math.max(128, Math.floor(this.maxChars / 2))) });
    this.observations = this.observations.slice(-32);
    while (this.files.size > 64) { const key = this.files.keys().next().value!; this.evictFile(key); this.files.delete(key); }
    while (this.changes.size > 64) this.changes.delete(this.changes.keys().next().value!);
    // Bound retained bodies between renders as well as the actual model prompt.
    let retained = [...this.files.values()].reduce((total, file) => total + (file.content?.length ?? 0), 0);
    for (const [key, file] of this.files) {
      if (retained <= this.maxChars) break;
      retained -= file.content?.length ?? 0;
      this.evictFile(key);
    }
  }
  invalidateFiles() { for (const path of this.files.keys()) this.evictFile(path); }
  render(reservedChars = 0): string {
    if (!Number.isSafeInteger(reservedChars) || reservedChars < 0) throw new WriterError('INPUT_TOO_LARGE', 'Reserved context length must be a nonnegative integer.');
    const budget = this.maxChars - reservedChars;
    const context = {
      goal: this.goal, parentInstructions: [...this.parentInstructions],
      messages: structuredClone(this.messages), reports: structuredClone(this.reports),
      fileChanges: [...this.changes.values()], files: [...this.files.values()].map(file => ({ ...file })),
      observations: structuredClone(this.observations), contextNote: note
    };
    const fits = () => length(context) <= budget;
    let compacted = false;
    // Keep every read from the current action batch until older feedback is removed.
    // The final observation may be a read_files summary or an unrelated batch action.
    for (const file of context.files) {
      if (fits()) break;
      if (file.content !== undefined && !this.unreadFileContexts.has(file.path)) {
        delete file.content; file.omitted = true; file.reread = true; compacted = true;
      }
    }
    while (!fits() && context.observations.length > 1) { context.observations.shift(); compacted = true; }
    while (!fits() && context.reports.length > 1) { context.reports.shift(); compacted = true; }
    while (!fits() && context.messages.length > 1) { context.messages.shift(); compacted = true; }
    // Current diagnostics must survive even when newly read bodies do not fit.
    // Files can be read again; losing the latest failure would hide why to retry.
    for (const file of context.files) {
      if (fits()) break;
      if (file.content !== undefined) { delete file.content; file.omitted = true; file.reread = true; compacted = true; }
    }
    for (const limit of [1000, 500, 250]) {
      if (fits()) break;
      if (context.observations.length) context.observations[0].result = feedback(context.observations[0].result, limit);
      if (context.reports.length) {
        const report = context.reports[0];
        const clipped = excerpt(report.summary, limit);
        if (clipped !== report.summary) { report.summary = clipped; report.truncated = true; }
      }
      if (context.messages.length) {
        const message = context.messages[0];
        const clipped = excerpt(message.text, limit);
        if (clipped !== message.text) { message.text = clipped; message.truncated = true; }
      }
      compacted = true;
    }
    while (!fits() && context.files.length > 1) { context.files.shift(); compacted = true; }
    while (!fits() && context.fileChanges.length > 1) { context.fileChanges.shift(); compacted = true; }
    if (!fits()) throw new WriterError('INPUT_TOO_LARGE', 'Current goal, recent parent instructions and essential feedback cannot fit the context budget. Shorten the task or parent messages.');
    const rendered = JSON.stringify(context);
    // Commit the bounded state only after a successful render. Recompacting an
    // unchanged history otherwise needlessly advances the provider session epoch.
    const retainedFiles = new Map(context.files.map(file => [file.path, file]));
    for (const [path, file] of this.files) {
      if (file.content !== undefined && retainedFiles.get(path)?.content === undefined) this.counters.evictedFileContents++;
    }
    this.files = retainedFiles;
    this.unreadFileContexts.clear();
    this.changes = new Map(context.fileChanges.map(change => [change.path, change]));
    this.messages = context.messages;
    this.reports = context.reports;
    this.observations = context.observations;
    if (compacted) this.counters.compactions++;
    this.counters.renderedChars = rendered.length;
    return rendered;
  }
  private requireMessage(text: string) {
    if (text.length > this.maxChars) throw new WriterError('INPUT_TOO_LARGE', 'A goal or message exceeds the context budget; it will not be silently truncated.');
  }
  private evictFile(path: string) {
    this.unreadFileContexts.delete(path);
    const file = this.files.get(path);
    if (file?.content !== undefined) {
      this.files.set(path, { path, omitted: true, reread: true });
      this.counters.evictedFileContents++;
    }
  }
}
