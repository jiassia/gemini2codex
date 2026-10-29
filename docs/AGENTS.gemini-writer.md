# Gemini delegation

Codex owns scope, authorization, architecture, integration and verification. Gemini executes bounded tasks through this MCP. Use the installed gemini_* schemas as the parameter reference.

For frontend work, create a native Codex controller named gemini_frontend when subagents are available. It calls gemini_spawn_agent with kind="frontend" and forwards actual Gemini progress. The controller must not implement frontend changes itself or silently switch executors after failure. The actual executor is Gemini. If native subagents are unavailable, use the MCP directly and explain the visibility limit.

Use an existing absolute workspace and a stable idempotency_key. For authorized native implementation, grant permissions={write:true,native_tools:true}. Native tools have local-user privileges; fixed command grants do not constrain them. Otherwise use MCP-scoped JSON actions with only the required file, fixed-command and browser permissions. Do not send credentials or unrelated private material.

Use gemini_send_message for steering, gemini_followup_task to continue on the same ID, and gemini_interrupt_agent for explicit cancellation. Sending to an idle completed agent does not start a new turn. Permissions and workspace stay fixed across follow-ups.

Read gemini_wait_agent with after_revision, compact=true and 15-30 second waits. Use until="update" for incremental events or until="attention" for completion, failure or required input. A wait timeout does not end execution. Forward actual progress, tool activity, retry reasons, elapsed time and silence. During long requests, report elapsed waiting time at least every 30 seconds. Do not invent percentages or expose private reasoning and raw tool arguments.

Default execution deadlines are disabled. Observe internal agy retries until a final result or explicit interruption. Do not infer failure from silence, replay an entire task automatically, or switch provider or account after failure. Report structured errors and available diagnostics. Follow provider cooldown instructions before an explicitly requested retry.

Accepted tasks belong to the durable supervisor. Closing the MCP connection does not cancel them. After reconnecting, query the original task ID. Reuse the original idempotency_key after an uncertain submission. Supervisor interruption marks unfinished tasks EXECUTION_INTERRUPTED. Inspect files and explicitly follow up instead of replaying prior mutations.

For substantial prose, use gemini_write, gemini_polish or gemini_rewrite once per coherent unit, with at most one optional review. Supply verified facts and preserve literal names, numbers, paths and commands. Codex checks the result before delivery. Brief replies and minor label edits need no delegation. Synchronous writing belongs to the current request; use kind="writing" for durable long work.

Inspect actual files and relevant build, test or browser evidence. A completed task records the model's report, not independent acceptance. Native file changes and command outcomes require filesystem verification. Preserve earlier changes after interruption and report their state accurately. Publishing, deployment and messaging require user authorization.

Initialization, tool listing and chat startup must not launch agy or live probes. Use gemini_health for an explicit health check. New server code requires a new MCP process.
