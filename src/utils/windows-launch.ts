import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WriterError } from '../types.js';

/** A GUI host creates an initially hidden console for ordinary descendants to
 * inherit. windowsHide alone does not control consoles created further down
 * a third-party CLI's process tree. Pipes and arguments remain unchanged. */
export function hiddenConsoleLaunch(executable: string, args: string[], env: NodeJS.ProcessEnv, pidPath?: string) {
  if (process.platform !== 'win32') return { file: executable, args, env };
  const host = fileURLToPath(new URL('../native/HiddenConsoleLauncher.exe', import.meta.url));
  if (!existsSync(host)) throw new WriterError('AGY_LAUNCHER_NOT_FOUND', 'Windows hidden console launcher is missing. Run npm run build before starting the MCP.');
  const hostedEnv = { ...env };
  delete hostedEnv.GEMINI_LAUNCH_PID_PATH;
  // The helper opens a process handle while this owner is alive. If the
  // supervisor crashes, the helper closes its Job Object and reclaims agy.
  hostedEnv.GEMINI_LAUNCH_PARENT_PID = String(process.pid);
  if (pidPath) hostedEnv.GEMINI_LAUNCH_PID_PATH = pidPath;
  return { file: host, args: [executable, ...args], env: hostedEnv };
}
