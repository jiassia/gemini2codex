import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import { mkdir, lstat, realpath } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { chromium, type Browser, type BrowserServer } from 'playwright';
import { z } from 'zod';
import { WriterError } from './types.js';
import { killTree } from './utils/subprocess.js';

export const browserCheckGrantSchema = z.object({
  command_id: z.string().min(1), url: z.string().url(),
  checks: z.array(z.object({
    name: z.string().regex(/^[a-zA-Z0-9_-]{1,60}$/),
    width: z.number().int().min(240).max(4096), height: z.number().int().min(240).max(4096),
    steps: z.array(z.discriminatedUnion('action', [
      z.object({ action: z.literal('click'), selector: z.string().min(1).max(500) }).strict(),
      z.object({ action: z.literal('fill'), selector: z.string().min(1).max(500), value: z.string().max(2000) }).strict()
    ])).max(20).default([]),
    assertions: z.array(z.object({ selector: z.string().min(1).max(500), text: z.string().max(2000).optional(), visible: z.boolean().optional() }).strict()).max(20).default([])
  }).strict()).min(1).max(8)
}).strict();
export interface BrowserCheckGrant {
  command_id: string; url: string;
  checks: { name: string; width: number; height: number;
    steps?: { action: 'click' | 'fill'; selector: string; value?: string }[];
    assertions?: { selector: string; text?: string; visible?: boolean }[] }[];
}
export interface BrowserCheckOptions {
  workspace: string;
  command: { id: string; executable: string; args: string[] };
  grant: BrowserCheckGrant;
  signal?: AbortSignal;
  timeoutMs?: number;
  browserChannel?: 'chrome' | 'msedge';
}
export interface BrowserCheckResult {
  passed: boolean; command_id: string; url: string; elapsedMs: number;
  checks: { name: string; width: number; height: number; statusCode: number | null;
    title: string; visibleText: string;
    consoleErrors: string[]; pageErrors: string[]; blockedRequests: string[];
    overflowPx: number; assertions: { selector: string; expectedText?: string; actualText: string; visible: boolean | null; passed: boolean }[];
    screenshot?: string; error?: string; passed: boolean }[];
  serverExitCode: number | null;
  serverStopped: boolean;
  termination: 'cleanup' | 'cancelled' | 'exited' | null;
}

/** A grant fixes the preview command, origin, interactions and viewports before delegation. */
export function previewOrigin(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'http:' || !['127.0.0.1', '[::1]', 'localhost'].includes(parsed.hostname) || parsed.username || parsed.password || !parsed.port) {
    throw new WriterError('AGENT_BROWSER_PERMISSION', 'Preview URL must use an explicitly ported HTTP loopback origin without credentials.');
  }
  return parsed.origin;
}

/** Preview commands run as the local user; grants are reviewed code, not an OS sandbox. */
export function previewEnvironment(source: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const allowed = new Set(['path', 'pathext', 'systemroot', 'windir', 'comspec', 'temp', 'tmp', 'home', 'userprofile', 'appdata', 'localappdata', 'programfiles', 'programfiles(x86)', 'lang', 'lc_all']);
  return Object.fromEntries(Object.entries(source).filter(([key, value]) => value !== undefined && allowed.has(key.toLowerCase())));
}

async function previewDirectory(workspace: string) {
  const root = await realpath(workspace);
  const path = join(root, '.gemini-preview');
  try { if ((await lstat(path)).isSymbolicLink()) throw new WriterError('AGENT_PATH_DENIED', 'Preview output cannot be a linked directory.'); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
  await mkdir(path, { recursive: true });
  const actual = await realpath(path);
  const rel = relative(root, actual);
  if (rel === '..' || rel.startsWith('..' + sep) || isAbsolute(rel)) throw new WriterError('AGENT_PATH_DENIED', 'Preview output escapes workspace.');
  return actual;
}

/** TCP only: never send an HTTP request to a process that already owns the port. */
async function refuseOccupiedPreview(url: string, signal?: AbortSignal) {
  const parsed = new URL(url);
  const hosts = parsed.hostname === 'localhost' ? ['127.0.0.1', '::1'] : [parsed.hostname.replace(/^\[|\]$/g, '')];
  for (const host of hosts) {
    const occupied = await new Promise<boolean>((resolveProbe, rejectProbe) => {
      const socket = createConnection({ host, port: Number(parsed.port) });
      let settled = false;
      const finish = (value?: boolean, error?: WriterError) => {
        if (settled) return;
        settled = true;
        signal?.removeEventListener('abort', abort);
        socket.destroy();
        if (error) rejectProbe(error); else resolveProbe(value ?? false);
      };
      const abort = () => finish(undefined, new WriterError('AGENT_CANCELLED', 'Browser check cancelled during the preview-port check.'));
      socket.once('connect', () => finish(true));
      socket.once('error', error => {
        if (['ECONNREFUSED', 'EAFNOSUPPORT'].includes((error as NodeJS.ErrnoException).code ?? '')) finish(false);
        else finish(undefined, new WriterError('AGENT_PREVIEW_PORT_CHECK', 'Could not verify that the granted loopback preview port is free.'));
      });
      socket.setTimeout(500, () => finish(undefined, new WriterError('AGENT_PREVIEW_PORT_CHECK', 'Granted loopback preview-port check timed out.')));
      signal?.addEventListener('abort', abort, { once: true });
      if (signal?.aborted) abort();
    });
    if (occupied) throw new WriterError('AGENT_PREVIEW_BUSY', 'Granted preview port already has a listener; the preview command was not started.');
  }
}

export async function runBrowserCheck(options: BrowserCheckOptions): Promise<BrowserCheckResult> {
  const grant = browserCheckGrantSchema.parse(options.grant);
  const origin = previewOrigin(grant.url);
  if (options.command.id !== grant.command_id || !isAbsolute(options.command.executable) || /\.(?:cmd|bat|ps1)$/i.test(options.command.executable)) {
    throw new WriterError('AGENT_BROWSER_PERMISSION', 'Preview needs the matching fixed command ID and an absolute executable (use a granted Node preview script for shell wrappers).');
  }
  if (options.signal?.aborted) throw new WriterError('AGENT_CANCELLED', 'Browser check cancelled before starting.');
  const timeoutMs = options.timeoutMs ?? 60000;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 120000) throw new WriterError('AGENT_BROWSER_PERMISSION', 'Browser check timeout must be between 1 and 120 seconds.');
  const start = Date.now();
  await refuseOccupiedPreview(grant.url, options.signal);
  const screenshotDirectory = await previewDirectory(options.workspace);
  const result: BrowserCheckResult = { passed: false, command_id: grant.command_id, url: grant.url, elapsedMs: 0, checks: [], serverExitCode: null, serverStopped: false, termination: null };
  let server: ChildProcess | undefined;
  let serverClosed: Promise<void> | undefined;
  let browserServer: BrowserServer | undefined;
  let browser: Browser | undefined;
  let abortReason: WriterError | undefined;
  const abort = () => {
    abortReason = new WriterError('AGENT_CANCELLED', 'Browser check cancelled or timed out.');
    result.termination = 'cancelled';
    if (server?.pid) killTree(server.pid);
    const browserProcess = browserServer?.process();
    if (browserProcess?.pid) killTree(browserProcess.pid);
  };
  const timer = setTimeout(abort, timeoutMs);
  options.signal?.addEventListener('abort', abort, { once: true });
  try {
    server = spawn(options.command.executable, options.command.args, { cwd: options.workspace, env: previewEnvironment(), shell: false, windowsHide: true, detached: process.platform !== 'win32', stdio: ['ignore', 'pipe', 'pipe'] });
    serverClosed = new Promise(resolveClose => server!.once('close', () => resolveClose()));
    let serverStartError = false;
    server.on('error', () => { serverStartError = true; });
    // Do not expose environment or arbitrary server logs to Gemini. Drain bounded output.
    let serverOutput = 0;
    for (const stream of [server.stdout, server.stderr]) stream?.on('data', chunk => {
      serverOutput += chunk.length;
      if (serverOutput > 1024 * 1024 && server?.pid) killTree(server.pid);
    });
    server.on('exit', code => { result.serverExitCode = code; result.termination ??= 'exited'; });
    const startupDeadline = Math.min(start + timeoutMs, Date.now() + 20000);
    let ready = false;
    while (Date.now() < startupDeadline && !ready) {
      if (abortReason) throw abortReason;
      if (serverStartError || server.exitCode !== null) throw new WriterError('AGENT_PREVIEW_START', 'Granted preview command exited before the page became available.');
      try {
        const response = await fetch(grant.url, { redirect: 'manual', signal: AbortSignal.timeout(1000) });
        await response.body?.cancel();
        // Redirects are checked by the routed browser, not followed by this readiness probe.
        ready = response.status < 500;
      } catch { /* bounded readiness polling */ }
      if (!ready) await delay(200);
    }
    if (!ready) throw new WriterError('AGENT_PREVIEW_START', 'Granted preview did not become available within the startup deadline.');
    const channel = options.browserChannel ?? ((await import('node:fs')).existsSync(chromium.executablePath()) ? undefined : 'chrome');
    browserServer = await chromium.launchServer({ headless: true, ...(channel ? { channel } : {}), env: previewEnvironment(), timeout: Math.min(15000, timeoutMs) });
    if (abortReason) throw abortReason;
    browser = await chromium.connect(browserServer.wsEndpoint());
    const context = await browser.newContext({ serviceWorkers: 'block', acceptDownloads: false });
    const blocked: string[] = [];
    const allowed = (url: string) => { try { const parsed = new URL(url); return parsed.origin === origin || parsed.protocol === 'data:' || (parsed.protocol === 'blob:' && parsed.origin === origin); } catch { return false; } };
    await context.route('**/*', route => {
      if (allowed(route.request().url())) return route.continue();
      if (blocked.length < 30) blocked.push(route.request().url().slice(0, 500));
      return route.abort('blockedbyclient');
    });
    await context.routeWebSocket('**/*', route => {
      const url = new URL(route.url());
      const httpOrigin = `${url.protocol === 'wss:' ? 'https:' : 'http:'}//${url.host}`;
      if (httpOrigin === origin) route.connectToServer();
      else { if (blocked.length < 30) blocked.push(route.url().slice(0, 500)); route.close(); }
    });
    context.on('page', page => { page.on('download', download => void download.cancel()); });
    for (const check of grant.checks) {
      if (abortReason) throw abortReason;
      const record: BrowserCheckResult['checks'][number] = { name: check.name, width: check.width, height: check.height, statusCode: null, title: '', visibleText: '', consoleErrors: [], pageErrors: [], blockedRequests: [], overflowPx: 0, assertions: [], passed: false };
      result.checks.push(record);
      blocked.length = 0;
      const page = await context.newPage();
      page.setDefaultTimeout(5000);
      page.on('console', message => { if (message.type() === 'error' && record.consoleErrors.length < 30) record.consoleErrors.push(message.text().slice(0, 1000)); });
      page.on('pageerror', error => { if (record.pageErrors.length < 30) record.pageErrors.push(error.message.slice(0, 1000)); });
      try {
        await page.setViewportSize({ width: check.width, height: check.height });
        const response = await page.goto(grant.url, { waitUntil: 'load', timeout: 10000 });
        record.statusCode = response?.status() ?? null;
        // Long polling and event streams may keep a healthy page busy forever.
        // Let ordinary async rendering settle briefly; assertions wait for the actual UI.
        await page.waitForLoadState('networkidle', { timeout: 1000 }).catch(() => {});
        if (new URL(page.url()).origin !== origin) throw new Error('Page navigated away from the granted origin.');
        for (const step of check.steps) {
          if (abortReason) throw abortReason;
          const locator = page.locator(step.selector);
          if (step.action === 'click') await locator.click(); else await locator.fill(step.value);
        }
        if (new URL(page.url()).origin !== origin) throw new Error('Interaction navigated away from the granted origin.');
        for (const assertion of check.assertions) {
          const locator = page.locator(assertion.selector);
          let passed = false;
          let actualText = '';
          let actualVisible: boolean | null = null;
          try {
            await locator.waitFor({ state: assertion.visible === false ? 'hidden' : 'visible' });
            if (assertion.text !== undefined && assertion.visible !== false) await locator.filter({ hasText: assertion.text }).waitFor({ state: 'visible' });
            const visible = await locator.isVisible();
            actualVisible = visible;
            const fullText = await locator.count() ? await locator.innerText() : '';
            actualText = fullText.slice(0, 1000);
            const matchesText = assertion.text === undefined || fullText.includes(assertion.text);
            passed = matchesText && (assertion.visible === undefined ? visible : visible === assertion.visible);
          } catch { /* record a failed assertion while preserving other checks and screenshot */ }
          if (!passed) {
            try {
              const count = await locator.count();
              actualText = count ? (await locator.first().innerText()).slice(0, 1000) : '[No matching element]';
              actualVisible = count ? await locator.first().isVisible() : false;
              if (count > 1) actualText = `[${count} matching elements] ${actualText}`;
            } catch { actualText ||= '[Unable to read matching element]'; }
          }
          record.assertions.push({ selector: assertion.selector, expectedText: assertion.text, actualText, visible: actualVisible, passed });
        }
        record.overflowPx = await page.evaluate(() => Math.max(0, document.documentElement.scrollWidth - window.innerWidth));
      } catch (error) { record.error = error instanceof Error ? error.message.slice(0, 1000) : 'Browser check failed.'; }
      try { record.title = (await page.title()).slice(0, 300); record.visibleText = (await page.locator('body').innerText({ timeout: 1000 })).slice(0, 3000); } catch { /* retain useful diagnostics if the page disappeared */ }
      try {
        record.screenshot = join(screenshotDirectory, `${randomUUID()}-${check.name}.png`);
        await page.screenshot({ path: record.screenshot, fullPage: true, timeout: 5000 });
      } catch { delete record.screenshot; record.error ??= 'Screenshot capture failed.'; }
      record.blockedRequests = [...blocked];
      record.passed = !record.error && record.statusCode !== null && record.statusCode >= 200 && record.statusCode < 400 && !record.consoleErrors.length && !record.pageErrors.length && !record.blockedRequests.length && record.overflowPx <= 1 && record.assertions.every(assertion => assertion.passed);
      await page.close();
    }
    await context.close();
    if (abortReason) throw abortReason;
    result.passed = result.checks.every(check => check.passed);
    return result;
  } catch (error) {
    if (abortReason) throw abortReason;
    if (error instanceof WriterError) throw error;
    throw new WriterError('AGENT_BROWSER_ERROR', 'Browser preview failed to start or complete; inspect the local browser installation and preview command.');
  } finally {
    clearTimeout(timer);
    options.signal?.removeEventListener('abort', abort);
    const closeBounded = async (close: Promise<unknown>) => {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try { await Promise.race([close.catch(() => {}), new Promise(resolve => { cleanupTimer = setTimeout(resolve, 3000); })]); }
      finally { clearTimeout(cleanupTimer); }
    };
    if (browser) await closeBounded(browser.close());
    const browserProcess = browserServer?.process();
    if (browserServer) await closeBounded(browserServer.close());
    if (browserProcess?.pid && browserProcess.exitCode === null) killTree(browserProcess.pid);
    if (server?.pid && server.exitCode === null && server.signalCode === null) {
      result.termination = abortReason ? 'cancelled' : 'cleanup';
      killTree(server.pid);
    }
    if (serverClosed) await closeBounded(serverClosed);
    result.serverStopped = !!server && (server.exitCode !== null || server.signalCode !== null);
    result.passed = result.passed && result.serverStopped;
    result.elapsedMs = Date.now() - start;
  }
}
