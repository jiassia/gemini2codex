import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join, extname, isAbsolute } from 'node:path';
import { WriterError } from '../types.js';
import { hiddenConsoleLaunch } from './windows-launch.js';
export interface RunOptions { timeoutMs: number; maxOutputChars: number; env?: NodeJS.ProcessEnv; cwd?: string; input?: string; signal?: AbortSignal; inheritEnv?: boolean; hiddenConsole?: boolean }
export interface RunResult { text: string; stderr: string; exitCode: number }
export function resolveCommand(command: string, env: NodeJS.ProcessEnv = process.env): string {
  if (isAbsolute(command)) {
    if (existsSync(command)) return command;
    throw new WriterError('AGY_NOT_FOUND', 'AGY_COMMAND absolute path does not exist.');
  }
  const extensions = process.platform === 'win32' ? ['', ...(env.PATHEXT ?? '.EXE;.CMD;.BAT;.PS1').split(';')] : [''];
  for (const dir of (env.PATH ?? env.Path ?? '').split(delimiter)) for (const extension of extensions) {
    const candidate = join(dir, command + (extname(command) ? '' : extension.toLowerCase()));
    if (existsSync(candidate)) return candidate;
  }
  throw new WriterError('AGY_NOT_FOUND', 'AGY_COMMAND was not found. Install agy or set its absolute executable path.');
}
export function killTree(pid: number) {
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore', timeout: 5000 });
    // Restricted Windows tokens can forbid taskkill /T while still permitting
    // termination of a child we own. Never leave its stdio and pending turn open.
    if (result.status !== 0) { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited or inaccessible */ } }
  }
  else { try { process.kill(-pid, 'SIGKILL'); } catch { try { process.kill(pid, 'SIGKILL'); } catch { /* already exited */ } } }
}
export async function runSubprocess(command: string, args: string[], options: RunOptions): Promise<RunResult> {
  if (options.signal?.aborted) throw new WriterError('AGY_CANCELLED', 'Process was cancelled before starting.');
  const env = { ...(options.inheritEnv === false ? {} : process.env), ...options.env };
  const executable = resolveCommand(command, env);
  const scratch = options.cwd ? undefined : mkdtempSync(join(tmpdir(), 'gemini-writer-'));
  let file = executable; let argv = args;
  if (process.platform === 'win32' && /\.(cmd|bat|ps1)$/i.test(executable)) {
    const quote = (s: string) => `'${s.replace(/'/g, "''")}'`;
    const script = `$ErrorActionPreference='Stop'; [Console]::InputEncoding=[Text.UTF8Encoding]::new($false); [Console]::OutputEncoding=[Text.UTF8Encoding]::new($false); try { & ${quote(executable)} ${args.map(quote).join(' ')}; if ($null -eq $LASTEXITCODE) { exit 0 }; exit $LASTEXITCODE } catch { [Console]::Error.WriteLine($_.Exception.Message); exit 1 }`;
    file = resolveCommand('powershell.exe', env);
    argv = ['-NoLogo', '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(script, 'utf16le').toString('base64')];
  }
  if (process.platform === 'win32' && argv.join(' ').length + file.length > 30000) {
    if (scratch) rmSync(scratch, { recursive: true, force: true });
    throw new WriterError('AGY_ARGUMENT_TOO_LARGE', 'Windows command line limit reached. Use the native agy.exe path or reduce the input.');
  }
  return new Promise((resolve, reject) => {
    let launch;
    try { launch = options.hiddenConsole ? hiddenConsoleLaunch(file, argv, env) : { file, args: argv, env }; }
    catch (error) { if (scratch) rmSync(scratch, { recursive: true, force: true }); reject(error); return; }
    const child = spawn(launch.file, launch.args, { cwd: options.cwd ?? scratch!, env: launch.env, windowsHide: true, detached: process.platform !== 'win32', stdio: ['pipe', 'pipe', 'pipe'] });
    let text = ''; let stderr = ''; let failure: WriterError | undefined;
    let settled = false; let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer); clearTimeout(cleanupTimer); process.off('SIGTERM', cancel); process.off('SIGINT', cancel);
      options.signal?.removeEventListener('abort', cancel);
      if (scratch) {
        try { rmSync(scratch, { recursive: true, force: true }); }
        catch { failure ??= new WriterError('AGY_CLEANUP_FAILED', 'Unable to remove the temporary process directory.'); }
      }
      if (failure) reject(failure); else resolve({ text, stderr, exitCode: code ?? -1 });
    };
    const fail = (error: WriterError) => {
      if (failure || settled) return;
      failure = error; text = ''; stderr = '';
      // A descendant may retain inherited pipes after the direct child exits.
      // Reclaim our handles even when a restricted OS token prevents tree kill.
      cleanupTimer = setTimeout(() => {
        child.stdin.destroy(); child.stdout.destroy(); child.stderr.destroy(); child.unref();
        finish(-1);
      }, 3000);
      if (child.pid) killTree(child.pid);
    };
    const cancel = () => fail(new WriterError('AGY_CANCELLED', 'Writer process was cancelled.'));
    const timer = options.timeoutMs > 0 ? setTimeout(() => fail(new WriterError('AGY_TIMEOUT', `agy exceeded WRITER_TIMEOUT_MS=${options.timeoutMs}; process termination was requested.`)), options.timeoutMs) : undefined;
    process.once('SIGTERM', cancel); process.once('SIGINT', cancel);
    options.signal?.addEventListener('abort', cancel, { once: true });
    if (options.signal?.aborted) cancel();
    const collect = (data: string, isStderr: boolean) => {
      if (failure) return;
      if (isStderr) stderr += data; else text += data;
      if (text.length + stderr.length > options.maxOutputChars + 32768) fail(new WriterError('OUTPUT_TOO_LARGE', 'Process output exceeded the configured limit; no partial text was returned.'));
    };
    child.stdout.setEncoding('utf8').on('data', data => collect(data, false));
    child.stderr.setEncoding('utf8').on('data', data => collect(data, true));
    child.stdin.on('error', () => { /* close reports a child that exits before reading stdin */ });
    child.stdin.end(options.input ?? '', 'utf8');
    child.on('error', () => fail(new WriterError('AGY_START_FAILED', 'Unable to execute AGY_COMMAND. Check its permissions and executable type.')));
    child.on('close', finish);
  });
}
export async function runProbe(command: string, args: string[], timeoutMs = 10000, hiddenConsole = false): Promise<RunResult> {
  const result = await runSubprocess(command, args, { timeoutMs, maxOutputChars: 30000, hiddenConsole });
  return { ...result, text: result.text + result.stderr };
}
