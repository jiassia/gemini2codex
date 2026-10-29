import { closeSync, existsSync, fsyncSync, mkdirSync, openSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join, resolve } from 'node:path';
import { z } from 'zod';
import { agentInput, type StoredTask } from './agent.js';
import { WriterError } from './types.js';

export interface TaskStore {
  save(task: StoredTask): void;
  load(): StoredTask[];
}

const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const snapshotSchema = z.object({
  id: z.string().regex(idPattern), status: z.enum(['queued', 'running', 'waiting', 'completed', 'failed', 'cancelled']),
  executionMode: z.enum(['json_actions', 'native_tools']), workspace: z.string(), kind: z.string(), effort: z.string(), createdAt: z.string(),
  task_name: z.string().optional(), revision: z.number().int().nonnegative(), runs: z.number().int().nonnegative(),
  messages: z.array(z.object({ id: z.string(), from: z.enum(['codex', 'gemini']), text: z.string(), time: z.string(), delivered: z.boolean() })),
  events: z.array(z.object({ revision: z.number().int().nonnegative(), time: z.string(), type: z.string(), detail: z.string() })),
  changedFiles: z.array(z.string()), commands: z.array(z.object({ id: z.string(), exitCode: z.number() })),
  browserChecks: z.array(z.unknown()), providerCalls: z.array(z.object({ run: z.number(), promptChars: z.number(), outputChars: z.number(), wallMs: z.number() }).passthrough()),
  error: z.object({ code: z.string(), message: z.string() }).passthrough().optional(),
  runtime: z.object({ stage: z.string(), startedAt: z.string(), lastActivityAt: z.string(), stepUpdates: z.number(), elapsedMs: z.number(), timeoutMs: z.number() }).passthrough().optional()
}).passthrough();
const storedSchema = z.object({ request: z.object(agentInput).strict(), view: snapshotSchema,
  idempotency: z.object({ key: z.string().min(1).max(200), fingerprint: z.string().regex(/^[0-9a-f]{64}$/) }).optional() }).strict();
const envelopeSchema = z.object({ formatVersion: z.literal(1), task: storedSchema }).strict();

/** One supervisor owns this directory. Each update replaces one complete task
 * atomically; the previous valid record remains in a separate backup file. */
export class DiskTaskStore implements TaskStore {
  readonly directory: string;
  constructor(directory: string) {
    this.directory = resolve(directory);
    try { mkdirSync(this.directory, { recursive: true, mode: 0o700 }); }
    catch { throw new WriterError('TASK_STORE_WRITE_FAILED', 'Unable to create the durable task directory.'); }
  }
  private parse(text: string, expectedId: string): StoredTask {
    try {
      const saved = envelopeSchema.parse(JSON.parse(text)).task;
      if (saved.view.id !== expectedId || saved.view.workspace !== saved.request.workspace || saved.idempotency?.key !== saved.request.idempotency_key) throw new Error('Stored task identity mismatch.');
      return saved as StoredTask;
    } catch { throw new WriterError('TASK_STORE_CORRUPT', `Durable task ${expectedId} has an invalid or unsupported record.`); }
  }
  private read(path: string, id: string): { text: string; task: StoredTask } {
    let text: string;
    try { text = readFileSync(path, 'utf8'); }
    catch { throw new WriterError('TASK_STORE_READ_FAILED', `Unable to read durable task ${id}.`); }
    return { text, task: this.parse(text, id) };
  }
  private atomicWrite(path: string, text: string): void {
    const temporary = `${path}.${randomUUID()}.tmp`;
    let fd: number | undefined;
    try {
      fd = openSync(temporary, 'wx', 0o600);
      writeFileSync(fd, text, 'utf8'); fsyncSync(fd); closeSync(fd); fd = undefined;
      renameSync(temporary, path);
    } catch { throw new WriterError('TASK_STORE_WRITE_FAILED', 'Unable to atomically save the durable task record. Execution cannot acknowledge this update.'); }
    finally {
      if (fd !== undefined) { try { closeSync(fd); } catch { /* Preserve the original write error. */ } }
      try { unlinkSync(temporary); } catch { /* A successful rename removes the temporary path. */ }
    }
  }
  save(task: StoredTask): void {
    if (!idPattern.test(task.view.id)) throw new WriterError('TASK_STORE_CORRUPT', 'Durable task ID must be a UUID.');
    const text = JSON.stringify({ formatVersion: 1, task }) + '\n';
    this.parse(text, task.view.id);
    const path = join(this.directory, `${task.view.id}.json`);
    const previous = existsSync(path) ? this.read(path, task.view.id).text : text;
    this.atomicWrite(path + '.bak', previous);
    this.atomicWrite(path, text);
  }
  load(): StoredTask[] {
    let files: string[];
    try { files = readdirSync(this.directory); }
    catch { throw new WriterError('TASK_STORE_READ_FAILED', 'Unable to enumerate the durable task directory.'); }
    const ids = new Set(files.map(name => name.match(/^([0-9a-f-]+)\.json(?:\.bak)?$/i)?.[1]).filter((id): id is string => !!id && idPattern.test(id)));
    const tasks: StoredTask[] = [];
    for (const id of [...ids].sort()) {
      const path = join(this.directory, `${id}.json`);
      try {
        tasks.push(this.read(path, id).task);
      } catch (error) {
        // A permission/I/O failure is not evidence of corruption. Preserve it
        // unless the primary is actually missing or invalid.
        if (existsSync(path) && (!(error instanceof WriterError) || error.code !== 'TASK_STORE_CORRUPT')) throw error;
        if (!existsSync(path + '.bak')) throw error;
        let backup: { text: string; task: StoredTask };
        try { backup = this.read(path + '.bak', id); }
        catch (backupError) {
          if (backupError instanceof WriterError && backupError.code === 'TASK_STORE_READ_FAILED') throw backupError;
          throw new WriterError('TASK_STORE_CORRUPT', `Durable task ${id} and its backup are corrupt. Execution was not resumed.`);
        }
        backup.task.view.recovery = { required: false, reason: 'TASK_STORE_BACKUP_RECOVERY', message: 'The primary task record was missing or corrupt. The previous valid backup was restored; its evidence may precede the interrupted update.' };
        const recovered = JSON.stringify({ formatVersion: 1, task: backup.task }) + '\n';
        this.atomicWrite(path, recovered);
        tasks.push(backup.task);
      }
    }
    return tasks;
  }
}
