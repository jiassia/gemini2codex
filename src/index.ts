#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { loadConfig } from './config.js';
import { AgyProvider } from './providers/agy.js';
import { GeminiApiProvider } from './providers/gemini-api.js';
import { createServer } from './server.js';
import { SupervisorClient } from './supervisor-client.js';
if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log('gemini2codex\n\nUsage: gemini2codex [--help | --healthcheck]\n\nWithout arguments, starts the stdio MCP server.\n--healthcheck makes an explicit provider request.\nBuild and Codex configuration: see README.md.');
  process.exit(0);
}
const config = loadConfig();
if (process.argv.includes('--healthcheck')) {
  const provider = config.provider === 'agy' ? new AgyProvider(config) : new GeminiApiProvider(config);
  const health = await provider.health(); console.log(JSON.stringify(health, null, 2)); process.exitCode = health.error ? 1 : 0;
} else {
  // The stdio connection owns only this client. Task execution belongs to the
  // detached supervisor and continues if a host closes or replaces this MCP.
  // Construction is lazy: initialize/listTools/ping launch neither agy nor a supervisor.
  const runtime = new SupervisorClient(config);
  const server = createServer(config, runtime.provider, { agents: runtime, managedProvider: true, onClose: () => runtime.close() });
  await server.connect(new StdioServerTransport());
}
