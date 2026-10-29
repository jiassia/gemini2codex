#!/usr/bin/env node
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { mkdir, mkdtemp, readdir, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'dotenv';

const repository = 'https://github.com/jiassia/gemini2codex.git';
const installationRoot = fileURLToPath(new URL('../', import.meta.url));
const stableVersion = /^(?:v)?(\d+)\.(\d+)\.(\d+)$/;

export function compareVersions(a, b) {
  const left = stableVersion.exec(a), right = stableVersion.exec(b);
  if (!left || !right) throw new Error('Expected a stable semantic version.');
  for (let i = 1; i <= 3; i++) {
    const difference = Number(left[i]) - Number(right[i]);
    if (difference) return Math.sign(difference);
  }
  return 0;
}

export function latestTag(output) {
  const tags = new Map();
  for (const line of output.split(/\r?\n/)) {
    const match = /^([a-f0-9]{40,64})\s+refs\/tags\/(v\d+\.\d+\.\d+)(\^\{\})?$/.exec(line);
    if (match && (!tags.has(match[2]) || match[3])) tags.set(match[2], { commit: match[1], tag: match[2], version: match[2].slice(1) });
  }
  return [...tags.values()].sort((a, b) => compareVersions(b.version, a.version))[0];
}

function run(command, args, { cwd, env, timeout = 0 } = {}) {
  return new Promise((accept, reject) => {
    const child = spawn(command, args, { cwd, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    child.stdout.on('data', data => { output += data; });
    child.stderr.resume();
    const timer = timeout ? setTimeout(() => child.kill(), timeout) : undefined;
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('exit', code => {
      clearTimeout(timer);
      if (code === 0) accept(output.trim());
      else reject(new Error(`${command} exited with code ${code}.`));
    });
  });
}

function npmCli(env) {
  const candidates = [env.npm_execpath, join(dirname(process.execPath), 'node_modules/npm/bin/npm-cli.js')];
  for (const directory of (env.PATH ?? env.Path ?? '').split(delimiter)) {
    if (directory) candidates.push(join(directory, 'node_modules/npm/bin/npm-cli.js'), join(directory, 'npm'));
  }
  for (const candidate of candidates) {
    if (!candidate || !existsSync(candidate)) continue;
    const path = realpathSync(candidate);
    if (path.endsWith('npm-cli.js')) return path;
  }
  throw new Error('npm CLI was not found.');
}

function packageVersion(root) {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
}

function ready(root, expectedVersion) {
  try {
    const marker = JSON.parse(readFileSync(join(root, '.gemini2codex-ready.json'), 'utf8'));
    return marker.version === expectedVersion && packageVersion(root) === expectedVersion && existsSync(join(root, 'dist/index.js'));
  } catch { return false; }
}

export function runtimeEnvironment(root, environment) {
  const file = join(root, '.env');
  const env = { ...(existsSync(file) ? parse(readFileSync(file)) : {}), ...environment };
  if (!env.WRITER_STATE_DIR?.trim()) {
    // Match the original installation's namespace even when running a cached update.
    const installation = resolve(root) + sep;
    const key = createHash('sha256').update(process.platform === 'win32' ? installation.toLowerCase() : installation).digest('hex').slice(0, 24);
    env.WRITER_STATE_DIR = join(env.LOCALAPPDATA ?? join(homedir(), '.local', 'state'), 'gemini-writer-mcp', key);
  }
  return env;
}

export async function selectRuntime({ root = installationRoot, environment = process.env, execute = run,
  cacheRoot, log = message => console.error(`[gemini2codex] ${message}`) } = {}) {
  const env = runtimeEnvironment(root, environment);
  const current = packageVersion(root);
  if (env.GEMINI2CODEX_AUTO_UPDATE === '0') return { root, env, version: current };
  cacheRoot ??= join(env.LOCALAPPDATA ?? join(homedir(), '.cache'), 'gemini2codex', 'versions');
  let selected = { root, env, version: current };
  // An already built update remains usable when GitHub is temporarily unavailable.
  for (const directory of await readdir(cacheRoot).catch(() => [])) {
    if (!/^v\d+\.\d+\.\d+$/.test(directory)) continue;
    const version = directory.slice(1), cached = join(cacheRoot, directory);
    if (compareVersions(version, selected.version) > 0 && ready(cached, version)) selected = { root: cached, env, version };
  }
  let staging;
  try {
    log('Checking GitHub for updates.');
    const newest = latestTag(await execute('git', ['ls-remote', '--tags', repository], { env, timeout: 10000 }));
    if (!newest || compareVersions(newest.version, selected.version) <= 0) return selected;
    log(`Installing ${newest.tag}.`);
    await mkdir(cacheRoot, { recursive: true });
    staging = await mkdtemp(join(cacheRoot, '.install-'));
    const source = join(staging, 'source');
    await execute('git', ['clone', '--depth', '1', '--single-branch', '--branch', newest.tag, '--', repository, source], { env });
    const commit = await execute('git', ['rev-parse', 'HEAD'], { cwd: source, env });
    if (commit !== newest.commit || packageVersion(source) !== newest.version) throw new Error('The downloaded version does not match the release tag.');
    await execute(process.execPath, [npmCli(env), 'ci', '--include=dev', '--no-audit', '--no-fund'], { cwd: source, env: { ...env, GEMINI2CODEX_AUTO_UPDATE: '0' } });
    if (!existsSync(join(source, 'dist/index.js'))) throw new Error('The updated server was not built.');
    await writeFile(join(source, '.gemini2codex-ready.json'), JSON.stringify(newest) + '\n');
    const target = join(cacheRoot, newest.tag);
    try { await rename(source, target); }
    catch (error) { if (!ready(target, newest.version)) throw error; }
    selected = { root: target, env, version: newest.version };
    log(`Using ${newest.tag}.`);
  } catch {
    log(`Update check or installation failed; using ${selected.version}.`);
  } finally {
    // Only remove the temporary directory created by mkdtemp inside this cache.
    if (staging && dirname(staging) === resolve(cacheRoot)) await rm(staging, { recursive: true, force: true }).catch(() => {});
  }
  return selected;
}

async function main() {
  const args = process.argv.slice(2);
  const runtime = args.includes('--help') || args.includes('-h')
    ? { root: installationRoot, env: runtimeEnvironment(installationRoot, process.env) }
    : await selectRuntime();
  const child = spawn(process.execPath, [join(runtime.root, 'dist/index.js'), ...args], {
    env: runtime.env, stdio: 'inherit', windowsHide: true
  });
  const stop = signal => { if (!child.killed) child.kill(signal); };
  process.on('SIGINT', () => stop('SIGINT')); process.on('SIGTERM', () => stop('SIGTERM'));
  child.on('error', () => { console.error('[gemini2codex] Unable to start MCP server.'); process.exitCode = 1; });
  child.on('exit', (code, signal) => { process.exitCode = code ?? (signal ? 1 : 0); });
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
