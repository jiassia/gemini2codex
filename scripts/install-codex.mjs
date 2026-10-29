import { readFile, writeFile, copyFile, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { config as dotenv } from 'dotenv';
const root = fileURLToPath(new URL('../', import.meta.url));
const invocationEnv = { ...process.env };
const fileEnv = dotenv({ path: root + '.env', quiet: true }).parsed ?? {};
const home = process.env.CODEX_HOME ?? join(homedir(), '.codex');
const configPath = join(home, 'config.toml');
await mkdir(home, { recursive: true });
const config = await readFile(configPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
if (config) await copyFile(configPath, `${configPath}.before-gemini-writer-${stamp}.bak`);
const command = process.execPath.replaceAll('\\', '/');
const args = [root.replaceAll('\\', '/') + 'scripts/launch.mjs'];
// Recognize ordinary TOML table spelling, including quoted keys, indentation,
// inline comments and array tables as section boundaries. Keep unrelated text verbatim.
const keyPattern = String.raw`(?:[A-Za-z0-9_-]+|"(?:[^"\\]|\\.)*"|'[^']*')`;
const tablePattern = new RegExp(String.raw`^[ \t]*(\[\[?)(${keyPattern}(?:[ \t]*\.[ \t]*${keyPattern})*)\]\]?[ \t]*(?:#[^\r\n]*)?(?:\r?\n|$)`, 'gm');
const headers = [...config.matchAll(tablePattern)];
const sections = headers.map((match, index) => {
  const names = match[2].match(new RegExp(keyPattern, 'g')).map(key => key[0] === '"' ? JSON.parse(key) : key[0] === "'" ? key.slice(1, -1) : key);
  const end = headers[index + 1]?.index ?? config.length;
  return { start: match.index, end, names, name: names.join('.'), body: config.slice(match.index + match[0].length, end), text: config.slice(match.index, end), array: match[1] === '[[' };
});
const ownSections = sections.filter(section => !section.array && section.names[0] === 'mcp_servers' && section.names[1] === 'gemini_writer');
const existingSection = ownSections.find(section => section.name === 'mcp_servers.gemini_writer.env')?.body ?? '';
const previousEnv = {};
for (const line of existingSection.split(/\r?\n/)) {
  const match = line.match(/^[ \t]*(?:"([A-Za-z_][\w-]*)"|'([A-Za-z_][\w-]*)'|([A-Za-z_][\w-]*))\s*=\s*("(?:[^"\\]|\\.)*"|'[^']*')\s*(?:#.*)?$/);
  if (match) {
    try { previousEnv[match[1] ?? match[2] ?? match[3]] = match[4][0] === "'" ? match[4].slice(1, -1) : JSON.parse(match[4]); } catch { /* unmodified entries remain in the environment body below */ }
  }
}
// Install the explicitly requested tiers; the running Codex session may inherit obsolete Low settings.
const select = (key, fallback) => invocationEnv[key] ?? previousEnv[key] ?? fileEnv[key] ?? fallback;
const model = (key, fallback) => {
  const value = select(key, fallback);
  return /^gemini-3\.[68]-flash-low$/.test(value) ? fallback : value;
};
const env = { WRITER_PROVIDER: select('WRITER_PROVIDER', 'agy'), AGY_COMMAND: select('AGY_COMMAND', 'agy'), AGY_MODEL: model('AGY_MODEL', 'gemini-3.8-flash-medium'), AGY_AGENT_MODEL: model('AGY_AGENT_MODEL', 'gemini-3.8-flash-high'), WRITER_TIMEOUT_MS: select('WRITER_TIMEOUT_MS', '0'), AGENT_PROVIDER_TIMEOUT_MS: select('AGENT_PROVIDER_TIMEOUT_MS', '0'), AGENT_TIMEOUT_MS: select('AGENT_TIMEOUT_MS', '0'), AGENT_MIN_INTERVAL_MS: select('AGENT_MIN_INTERVAL_MS', '5000'), LOG_LEVEL: select('LOG_LEVEL', 'info') };
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'GEMINI_API_MODEL', 'MAX_INPUT_CHARS', 'MAX_OUTPUT_CHARS', 'MAX_ATTEMPTS']) if (select(key) !== undefined) env[key] = select(key);
const { loadConfig } = await import('../dist/config.js');
loadConfig({ ...previousEnv, ...env });
const quote = value => JSON.stringify(value);
const assignment = key => new RegExp(`^[ \\t]*(?:${key}|"${key}"|'${key}')[ \\t]*=[\\s\\S]*?(?=^[ \\t]*(?:[A-Za-z0-9_-]+|"[^"\\r\\n]+"|'[^'\\r\\n]+')[ \\t]*=|(?![\\s\\S]))`, 'gm');
const setting = (body, key, value) => assignment(key).test(body) ? body.replace(assignment(key), `${key} = ${value}\n`) : `${body.trimEnd()}\n${key} = ${value}\n`;
let envBody = existingSection;
for (const [key, value] of Object.entries(env)) envBody = setting(envBody, key, quote(value));
// The user requested automatic Gemini delegation. Approve only the collaboration
// interfaces; workspace/write/fixed-command grants are still checked by the executor.
const collaborationTools = ['gemini_spawn_agent', 'gemini_send_message', 'gemini_followup_task', 'gemini_interrupt_agent'];
const toolSettings = new Map();
const retainedSections = [];
for (const { text: section, name, body } of ownSections) {
  if (name !== 'mcp_servers.gemini_writer' && name !== 'mcp_servers.gemini_writer.env') {
    const tool = name.match(/^mcp_servers\.gemini_writer\.tools\.(?:"([^"]+)"|'([^']+)'|([a-zA-Z0-9_-]+))$/)?.slice(1).find(Boolean);
    if (collaborationTools.includes(tool)) {
      // Only replace this tool's approval choice; preserve output limits and other settings.
      toolSettings.set(tool, body.replace(assignment('approval_mode'), '').trim());
    } else retainedSections.push(section.trim());
  }
}
const collaborationApprovals = collaborationTools.map(tool => {
  const settings = toolSettings.get(tool);
  return `\n[mcp_servers.gemini_writer.tools.${tool}]\napproval_mode = "approve"\n${settings ? settings + '\n' : ''}`;
}).join('');
let serverBody = ownSections.find(section => section.name === 'mcp_servers.gemini_writer')?.body ?? '';
for (const [key, value] of Object.entries({ command, args, cwd: root.replaceAll('\\', '/') })) serverBody = setting(serverBody, key, quote(value));
for (const [key, value] of Object.entries({ env_vars: ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy', 'GEMINI_API_KEY'], startup_timeout_sec: 600, tool_timeout_sec: Math.max(180, Math.ceil(Number(env.WRITER_TIMEOUT_MS) / 1000) + 30) })) {
  if (!assignment(key).test(serverBody)) serverBody = setting(serverBody, key, quote(value));
}
const previousStartup = serverBody.match(assignment('startup_timeout_sec'))?.[0].match(/=\s*(\d+)/);
if (previousStartup && Number(previousStartup[1]) < 600) serverBody = setting(serverBody, 'startup_timeout_sec', '600');
// Existing API credentials stay in place; newly configured credentials are inherited,
// never copied from the process environment into the configuration file.
if (env.WRITER_PROVIDER === 'gemini-api') {
  const existing = serverBody.match(assignment('env_vars'))?.[0] ?? '';
  const closing = existing.lastIndexOf(']');
  const opening = existing.indexOf('[');
  if (opening >= 0 && closing > opening) {
    const items = [...existing.slice(opening + 1, closing).matchAll(/"(?:[^"\\]|\\.)*"|'[^']*'|#[^\r\n]*/g)]
      .map(match => match[0]).filter(value => !value.startsWith('#'))
      .map(value => value[0] === "'" ? value.slice(1, -1) : JSON.parse(value));
    if (!items.includes('GEMINI_API_KEY')) serverBody = setting(serverBody, 'env_vars', quote([...items, 'GEMINI_API_KEY']));
  }
}
const block = `[mcp_servers.gemini_writer]\n${serverBody.trim()}\n\n[mcp_servers.gemini_writer.env]\n${envBody.trim()}\n`;
// Remove only this server's sections. Keep other providers, credentials and comments intact.
let kept = config;
for (const section of [...ownSections].reverse()) kept = kept.slice(0, section.start) + kept.slice(section.end);
kept = kept.trimEnd();
await writeFile(configPath, `${kept}\n\n${block}${collaborationApprovals}${retainedSections.length ? '\n' + retainedSections.join('\n\n') + '\n' : ''}`, 'utf8');
const agentsPath = join(home, 'AGENTS.md');
const previous = await readFile(agentsPath, 'utf8').catch(error => { if (error.code === 'ENOENT') return ''; throw error; });
const begin = '<!-- gemini-writer-mcp:begin -->'; const end = '<!-- gemini-writer-mcp:end -->';
if (previous) await copyFile(agentsPath, `${agentsPath}.before-gemini-writer-${stamp}.bak`);
const rules = await readFile(root + 'docs/AGENTS.gemini-writer.md', 'utf8');
const addition = `${begin}\n${rules.trim()}\n${end}`;
const first = previous.indexOf(begin); const last = previous.indexOf(end);
const next = first >= 0 && last >= first ? previous.slice(0, first) + addition + previous.slice(last + end.length) : previous.trimEnd() + '\n\n' + addition + '\n';
await writeFile(agentsPath, next, 'utf8');
console.log(`Configured MCP: ${configPath}\nInstalled delegation rules: ${agentsPath}\nStart a new Codex session to load the tools.`);
