import { existsSync, mkdirSync, statSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
export const launcherPath = join(root, 'dist', 'native', 'HiddenConsoleLauncher.exe');

export function findCSharpCompiler() {
  const windows = process.env.SystemRoot ?? process.env.WINDIR ?? 'C:\\Windows';
  const frameworks = process.arch === 'ia32' ? ['Framework', 'Framework64'] : ['Framework64', 'Framework'];
  for (const framework of frameworks) {
    const compiler = join(windows, 'Microsoft.NET', framework, 'v4.0.30319', 'csc.exe');
    if (existsSync(compiler)) return compiler;
  }
  throw new Error('Windows build requires the .NET Framework 4 C# compiler (csc.exe).');
}

export function buildNativeLauncher() {
  if (process.platform !== 'win32') return undefined;
  mkdirSync(join(root, 'dist', 'native'), { recursive: true });
  const source = join(root, 'native', 'HiddenConsoleLauncher.cs');
  // Windows locks running executables. Reuse an up-to-date launcher rather
  // than attempting to overwrite it while an agy request is active.
  if (existsSync(launcherPath) && statSync(launcherPath).mtimeMs >= statSync(source).mtimeMs) return launcherPath;
  try {
    execFileSync(findCSharpCompiler(), ['/nologo', '/target:winexe', '/platform:anycpu', '/optimize+',
      `/out:${launcherPath}`, source],
    { cwd: root, windowsHide: true, stdio: 'pipe', timeout: 30000 });
  } catch (error) {
    const diagnostic = [error.stdout, error.stderr].filter(Boolean).map(value => value.toString()).join('\n').trim();
    throw new Error(`Unable to build the Windows hidden console launcher.${diagnostic ? '\n' + diagnostic : ''}`, { cause: error });
  }
  return launcherPath;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const output = buildNativeLauncher();
  if (output) console.log(`Built ${output}`);
}
