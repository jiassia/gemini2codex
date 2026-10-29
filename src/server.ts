import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { Config } from './config.js';
import { errorInfo, type WriterProvider, type WriterRequest } from './types.js';
import { validateInput, parseReview } from './utils/sanitize.js';
import { AgentManager, agentInput } from './agent.js';
import { ControlledProvider } from './providers/controlled.js';
import { presentAgent, progressSummary, providerMessage } from './progress.js';
import type { RequestHandlerExtra } from '@modelcontextprotocol/sdk/shared/protocol.js';
import type { ServerRequest, ServerNotification } from '@modelcontextprotocol/sdk/types.js';
type ToolExtra = RequestHandlerExtra<ServerRequest, ServerNotification>;
type AgentMethods = 'spawn' | 'submit' | 'sendMessage' | 'followup' | 'get' | 'list' | 'cancel' | 'wait';
export type AgentBackend = {
  [K in AgentMethods]: (...args: Parameters<AgentManager[K]>) => ReturnType<AgentManager[K]> | Promise<Awaited<ReturnType<AgentManager[K]>>>;
} & {
  subscribe(listener: (update: { id: string; revision: number; type: string; view?: Parameters<typeof progressSummary>[0] }) => unknown): () => void;
  shutdown?(): Promise<void>;
};
export interface ServerOptions { agents?: AgentBackend; managedProvider?: boolean; onClose?: () => void | Promise<void> }

function progressReporter(extra: ToolExtra) {
  let count = 0;
  let tail = Promise.resolve();
  let active = true;
  let lastMessage: string | undefined;
  return {
    send(message: string) {
      if (!active || extra.signal.aborted || extra._meta?.progressToken === undefined) return;
      if (message === lastMessage) return;
      lastMessage = message;
      const progress = ++count;
      tail = tail.then(async () => {
        if (extra.signal.aborted) return;
        await extra.sendNotification({ method: 'notifications/progress', params: { progressToken: extra._meta!.progressToken!, progress, message } });
      }).catch(() => {});
    },
    async close() { active = false; await tail; }
  };
}
export function createServer(config: Config, rawProvider: WriterProvider, options: ServerOptions = {}): McpServer {
  const provider = options.managedProvider ? rawProvider : new ControlledProvider(config, rawProvider);
  const agents: AgentBackend = options.agents ?? new AgentManager(config, provider);
  const server = new McpServer({ name: 'gemini-writer-mcp', version: '2.2.0' }, { instructions: 'Gemini is a collaborating subagent through MCP. In Codex, use a native Codex subagent named gemini_frontend as its visible progress controller when native subagents are available; that controller calls gemini_spawn_agent (frontend / Gemini 3.8 Flash High) and forwards actual events and elapsed waiting time into commentary. The native Subagents panel shows the Codex controller; MCP cannot register its own external task there. The controller does not implement frontend source itself or silently replace Gemini after a failure. Poll gemini_wait_agent with returned revision, compact=true and 15-30 second waits; use until=attention to stream standard MCP progress notifications during a bounded wait; compact replies include readable progress and incremental timeline events; report real runtime/process/action/build/browser/error facts, no fake percent or private reasoning. Communicate with gemini_send_message, gemini_followup_task, gemini_wait_agent, gemini_list_agents and gemini_interrupt_agent. Same-agent context persists across followups; capabilities cannot be expanded by messages. Delegate a specific workspace and needed permissions, then inspect files and validation. For ordinary authorized implementation use permissions {write:true,native_tools:true} and let agy execute normally in its workspace. Default execution deadlines are disabled. Observe agy internal retries without interrupting them, and wait for its final result or explicit cancellation. Writing uses Gemini 3.8 Flash Medium. MCP does not retry the whole task or switch providers/accounts. Never send secrets.' });
  const agentAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true };
  const reply = (result: object) => ({ content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: { ...result } });
  const failure = (error: unknown) => ({ isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorInfo(error)) }] });
  const { task: _task, ...spawnSettings } = agentInput;
  server.registerTool('gemini_spawn_agent', { description: 'Spawn a Gemini subagent, like Codex spawn_agent. Defaults to frontend / Gemini 3.8 Flash High. Specify task_name, message, existing absolute workspace and capabilities. Returns a durable id used as target for communication and follow-ups. Supply a stable idempotency_key to safely resubmit after an uncertain disconnect; the same key and request return the original task without executing again. Fixed command grants have local user privileges; inspect them before granting. permissions.native_tools=true explicitly enables provider native tools beyond fixed grants and requires write=true. Native effects are not tracked; independently verify the final report.', annotations: agentAnnotations, inputSchema: { task_name: z.string().regex(/^[a-z][a-z0-9_]{0,63}$/).optional(), message: z.string().min(1), ...spawnSettings } }, async args => {
    try { return reply(presentAgent(await agents.spawn(args))); } catch (error) { return failure(error); }
  });
  for (const [name, description, operation] of [
    ['gemini_send_message', 'Send a message to a named or identified Gemini agent. JSON-mode agents discard stale proposed actions. Native-mode agents finish the current request before reading steering; native changes remain. Waiting agents resume when supplied an answer; completed agents retain messages without starting a run.', (target: string, message: string) => agents.sendMessage(target, message)],
    ['gemini_followup_task', 'Continue work on the same Gemini agent and retained context. Idle agents start a new run; running agents receive steering at the next boundary. Workspace and capabilities stay fixed.', (target: string, message: string) => agents.followup(target, message)]
  ] as const) server.registerTool(name, { description, annotations: agentAnnotations, inputSchema: { target: z.string().min(1), message: z.string().min(1) } }, async args => {
    try { return reply(presentAgent(await operation(args.target, args.message))); } catch (error) { return failure(error); }
  });
  server.registerTool('gemini_list_agents', { description: 'List retained Gemini agents with names, stable IDs, status, messages, revisions and reports. Tasks and results survive MCP reconnection and remain available for follow-up.', annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: {} }, async () => {
    try { return reply({ agents: (await agents.list()).map(view => presentAgent(view)) }); } catch (error) { return failure(error); }
  });
  server.registerTool('gemini_wait_agent', { description: 'Observe agy execution, tool activity, elapsed/silent time, messages and results. Pass returned revision as after_revision and compact=true for incremental events. until=update returns on new progress; until=attention streams MCP progress notifications while waiting for completion, input or a Gemini message. Bounded wait; no provider requests or retries.', annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: { targets: z.array(z.string().min(1)).max(8).default([]), after_revision: z.number().int().min(0).optional(), timeout_ms: z.number().int().min(0).max(60000).default(30000), compact: z.boolean().default(false), until: z.enum(['update', 'attention']).default('update') } }, async (args, extra) => {
    const reporter = progressReporter(extra);
    let unsubscribe = () => {};
    try {
      const initial = args.targets.length ? await Promise.all(args.targets.map(target => agents.get(target))) : await agents.list();
      const ids = new Set(initial.map(view => view.id));
      unsubscribe = agents.subscribe(update => {
        if (!ids.has(update.id)) return;
        if (update.view) { reporter.send(progressSummary(update.view).message); return; }
        const view = agents.get(update.id);
        if (view instanceof Promise) return view.then(value => { reporter.send(progressSummary(value).message); });
        reporter.send(progressSummary(view).message);
      });
      for (const view of initial) reporter.send(progressSummary(view).message);
      const result = await agents.wait(args.targets, args.after_revision, args.timeout_ms, { until: args.until, signal: extra.signal });
      return reply({ ...result, agents: result.agents.map(view => presentAgent(view, args.compact, args.after_revision)) });
    } catch (error) { return failure(error); }
    finally { unsubscribe(); await reporter.close(); }
  });
  server.registerTool('gemini_interrupt_agent', { description: 'Interrupt a Gemini agent and stop active work. The agent remains available for follow-up with retained context; existing file changes remain.', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, inputSchema: { target: z.string().min(1) } }, async args => {
    try { return reply(presentAgent(await agents.cancel(args.target))); } catch (error) { return failure(error); }
  });
  server.registerTool('gemini_agent_submit', { description: 'Delegate an autonomous frontend/general/writing task. Frontend and general use highest available thinking (high), writing uses medium. Default JSON-mode reads are scoped to workspace; writes require write=true. Explicit native_tools=true enables provider native tools with local user privileges, requires write=true, and does not track native effects. Commands grant an exact executable and fixed args; they run with local user privileges and must be reviewed before granting. Returns a task ID immediately; poll status for progress and results.', annotations: agentAnnotations, inputSchema: agentInput }, async args => {
    try { return reply(presentAgent(await agents.submit(args))); } catch (error) { return failure(error); }
  });
  server.registerTool('gemini_agent_status', { description: 'Read durable task status, progress events, changed files, command exit codes, structured failure or final report. Tasks survive MCP reconnection; structured errors include failure_reason, retryable, error_id, explicitly incomplete partial output and recovery guidance when available. Completion records the agent report; independently check files and validation.', annotations: { readOnlyHint: true, openWorldHint: false }, inputSchema: { task_id: z.string().min(1) } }, async args => {
    try { return reply(presentAgent(await agents.get(args.task_id))); } catch (error) { return failure(error); }
  });
  server.registerTool('gemini_agent_cancel', { description: 'Cancel a queued or running task and stop its active process tree. Previously completed file changes remain for review.', annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false }, inputSchema: { task_id: z.string().min(1) } }, async args => {
    try { return reply(presentAgent(await agents.cancel(args.task_id))); } catch (error) { return failure(error); }
  });
  server.server.onclose = () => {
    if (options.onClose) void Promise.resolve(options.onClose()).catch(() => {});
    else { void agents.shutdown?.(); process.emit('SIGTERM'); }
  };
  const common = { instruction: z.string().optional(), language: z.string().default('zh-CN'), style: z.string().default('natural-professional'), max_attempts: z.literal(1).default(1) };
  const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: false, openWorldHint: true };
  async function execute(request: WriterRequest, extra: ToolExtra) {
    const reporter = progressReporter(extra);
    const start = Date.now(); let outputLength = 0; let success = false;
    const input = JSON.stringify(request);
    try {
      validateInput(input, config.maxInputChars);
      const response = await provider.generate(request, { signal: extra.signal, onProgress: progress => reporter.send(providerMessage(progress)) }); outputLength = response.text.length;
      const result = request.operation === 'review' ? { ...parseReview(response.text), provider: response.provider, model: response.model, latencyMs: response.latencyMs } : { ...response, requiresFactCheck: true };
      success = true;
      return { content: [{ type: 'text' as const, text: request.operation === 'review' ? JSON.stringify(result) : response.text }], structuredContent: result };
    } catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorInfo(error)) }] }; }
    finally {
      await reporter.close();
      if (config.logLevel === 'info' || config.logLevel === 'debug' || (config.logLevel === 'error' && !success)) process.stderr.write(JSON.stringify({ time: new Date().toISOString(), provider: config.provider, model: config.provider === 'agy' ? config.agyModel : config.apiModel, latencyMs: Date.now() - start, inputLength: input.length, outputLength, success }) + '\n');
    }
  }
  server.registerTool('gemini_write', { description: 'Write prose from authoritative facts. One call per writing unit. Codex must check facts before final use.', annotations, inputSchema: { content: z.string().min(1), ...common } }, (args, extra) => execute({ operation: 'write', source: args.content, instruction: args.instruction, language: args.language, style: args.style, max_attempts: args.max_attempts }, extra));
  for (const operation of ['polish', 'rewrite'] as const) server.registerTool(`gemini_${operation}`, { description: operation === 'polish' ? 'Polish expression while preserving facts, numbers, names, URLs, paths, commands and identifiers.' : 'Restructure prose while preserving facts and literal technical content. Do not repeatedly polish the result.', annotations, inputSchema: { text: z.string().min(1), ...common } }, (args, extra) => execute({ operation, source: args.text, instruction: args.instruction, language: args.language, style: args.style, max_attempts: args.max_attempts }, extra));
  server.registerTool('gemini_review', { description: 'Compare original and revised prose for fact drift and omissions. Structured editorial feedback; Codex remains the factual authority.', annotations, inputSchema: { original: z.string().min(1), revised: z.string().min(1), ...common } }, (args, extra) => execute({ operation: 'review', source: args.original, revised: args.revised, instruction: args.instruction, language: args.language, max_attempts: args.max_attempts }, extra));
  server.registerTool('gemini_health', { description: 'Explicit live provider probe: executable, authentication, exact model listing and READY generation. Unknown states are null.', annotations, inputSchema: {} }, async () => {
    try { const health = await provider.health(); return { content: [{ type: 'text' as const, text: JSON.stringify(health) }], structuredContent: { ...health } }; }
    catch (error) { return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(errorInfo(error)) }] }; }
  });
  return server;
}
