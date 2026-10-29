# gemini2codex

[中文](README.zh-CN.md)

`gemini2codex` runs a local stdio MCP server that allows Codex to delegate frontend development, general implementation, and writing tasks to Gemini. Codex handles task scoping, authorization, integration, and verification, while Gemini executes the delegated work.

## Quick Start

Provide the following prompt to Codex to download, verify dependencies, build, configure MCP, and test the connection. Once installed, each MCP server startup checks GitHub for the latest stable release and automatically downloads, builds, and runs updates when available.

```text
Please install and configure https://github.com/jiassia/gemini2codex so that this Codex session can delegate tasks to Gemini.

Perform the following steps autonomously:
1. Verify that Node.js 22+, npm, and Git are installed, check that Antigravity CLI (agy) is installed and authenticated, and install any missing build dependencies.
2. Clone the repository into a persistent local directory, run npm ci, and build from source.
3. Run npm run configure:codex to install the MCP configuration and automated delegation rules.
4. Verify the MCP initialization, tool listing, and ping. Once finished, report the installation directory and verification status, and suggest opening a new Codex session.

Execute the installation and configuration directly. Do not merely list instructions or ask the user to manually edit configuration files.
```

Codex can also download, build, and launch a specific release of the stdio MCP service directly:

```sh
npx --yes --package=github:jiassia/gemini2codex#v2.3.0 gemini2codex
```

## Requirements

- Node.js 22 or higher, npm, and Git.
- On Windows, builds require the .NET Framework 4 C# compiler; the build script searches system directories for `csc.exe`.
- The Antigravity CLI `agy` is used by default and must be installed and authenticated beforehand. See the [Antigravity official documentation](https://antigravity.google/docs/cli/headless/) for setup details. Ensure `agy` is in your `PATH` or specify its absolute executable path with `AGY_COMMAND`.

## Usage

Task orchestration tools include `gemini_spawn_agent`, `gemini_send_message`, `gemini_followup_task`, `gemini_wait_agent`, `gemini_list_agents`, and `gemini_interrupt_agent`. Dedicated writing tools include `gemini_write`, `gemini_polish`, `gemini_rewrite`, and `gemini_review`.

Codex delegates work using the following schema, setting `workspace` to the absolute path of the target project:

```json
{
  "task_name": "project_task",
  "idempotency_key": "project-task-001",
  "message": "Read the project instructions, implement the specified changes, run the project build, and report the actual results.",
  "workspace": "C:/work/project",
  "kind": "general",
  "permissions": { "write": true, "native_tools": true }
}
```

The `kind` field accepts `frontend`, `general`, and `writing`. File write access and native tool execution are disabled by default; enabling them in `permissions` grants Gemini the local user's permissions to modify project files and run tools.

Once Codex spawns a task, it uses the returned ID to inspect progress or send follow-ups. Use `gemini_wait_agent` with `after_revision` to fetch incremental updates; timeouts simply return the current task state. Tasks run without a default execution timeout and require `gemini_interrupt_agent` to halt explicitly. A `completed` status indicates that Gemini submitted its report, but actual filesystem changes and build outputs must still be verified.

An independent supervisor manages task states, allowing accepted tasks to continue running across MCP disconnections. Reuse the original `idempotency_key` if a submission result is ambiguous; using an existing key with different parameters returns a conflict error. If the supervisor process terminates, incomplete tasks are marked as `EXECUTION_INTERRUPTED`; inspect the filesystem and resume execution explicitly with `gemini_followup_task`. Synchronous writing operations run within the active request context, whereas long-running writing jobs that need disconnection recovery should use `kind: "writing"`.

## Configuration and Diagnostics

Codex configures environment variables according to [.env.example](.env.example); parent process environment variables take precedence. The default implementation model is `gemini-3.8-flash-high` and the writing model is `gemini-3.8-flash-medium`, configurable via `AGY_AGENT_MODEL` and `AGY_MODEL`. Model availability depends on the local CLI installation and account access.

To connect directly to the official Google Gemini API instead of the local CLI, set `WRITER_PROVIDER=gemini-api`, `GEMINI_API_KEY`, and `GEMINI_API_MODEL` simultaneously, selecting a model that supports the required thinking level. The server does not automatically switch providers. Keep all credentials in the local environment and never commit them to the repository.

Run `gemini2codex --help` for usage information, or run `node dist/index.js --help` when building from source. Both `npm run healthcheck` and the `gemini_health` MCP tool issue active requests to the configured provider. Standard server initialization, tool listings, and ping requests do not spawn `agy`.

## License

[MIT](LICENSE)

## LINUX DO Community

Thanks to the [Linux.do](https://linux.do/) community for its support and contributions.
