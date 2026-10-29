# gemini2codex

通过本地 stdio MCP 服务，让 Codex 调用 Gemini 完成前端开发、通用实现和写作任务。Codex 负责任务范围、授权、集成与验收；Gemini 负责执行委派任务。

## 快速运行

将以下内容复制给 Codex，由 Codex 完成下载、依赖检查、构建、MCP 配置和连接验证。安装后，每次启动 MCP 都会检查 GitHub 最新稳定版本，有新版时自动下载、构建并运行。

```text
请安装并配置 https://github.com/jiassia/gemini2codex，让当前 Codex 可以调用 Gemini。

请自行完成以下操作：
1. 检查 Node.js 22+、npm、Git，以及 Antigravity CLI agy 的安装和登录状态，补齐构建依赖。
2. 将仓库下载到本地固定目录，执行 npm ci，自动完成源码构建。
3. 执行 npm run configure:codex，安装 MCP 配置和自动委派规则。
4. 验证 MCP 初始化、工具列表和 ping，完成后报告安装目录及验证结果，并提示新开 Codex 会话。

请直接执行安装和配置，不要只列出步骤或要求用户手动编辑配置文件。
```

Codex 也可通过以下命令下载、构建并启动指定版本的 stdio MCP 服务：

```sh
npx --yes --package=github:jiassia/gemini2codex#v2.3.0 gemini2codex
```

## 环境要求

需要 Node.js 22 或更高版本、npm 和 Git。Windows 构建还需要 .NET Framework 4 的 C# 编译器，构建脚本会从系统目录查找 csc.exe。

默认使用 Antigravity CLI `agy`，需先安装并完成登录。安装信息参见 [Antigravity 官方文档](https://antigravity.google/docs/cli/headless/)。`agy` 应位于 PATH，或通过 `AGY_COMMAND` 指定可执行文件的绝对路径。

## 使用

任务协作工具包括 `gemini_spawn_agent`、`gemini_send_message`、`gemini_followup_task`、`gemini_wait_agent`、`gemini_list_agents` 和 `gemini_interrupt_agent`。写作工具包括 `gemini_write`、`gemini_polish`、`gemini_rewrite` 和 `gemini_review`。

Codex 通过以下接口委派任务，并将 `workspace` 设置为实际项目的绝对路径。

```json
{
  "task_name": "project_task",
  "idempotency_key": "project-task-001",
  "message": "阅读项目说明，完成指定修改并执行项目构建，报告实际结果。",
  "workspace": "C:/work/project",
  "kind": "general",
  "permissions": { "write": true, "native_tools": true }
}
```

`kind` 支持 `frontend`、`general` 和 `writing`。默认写入和原生工具权限均关闭；上述授权使 Gemini 以本机用户权限读写项目并执行工具。

Codex 创建任务后使用返回的 ID 查询或继续任务。`gemini_wait_agent` 配合 `after_revision` 获取新增进度；等待超时只返回当前状态。任务默认不设执行时限，使用 `gemini_interrupt_agent` 显式中断。`completed` 表示 Gemini 已提交报告，仍需检查实际文件和构建结果。

独立 supervisor 保存任务状态，已接受的任务在 MCP 连接断开后继续运行。提交结果不确定时复用原 `idempotency_key`，同一键用于不同请求会返回冲突。supervisor 中断后，未完成任务标记为 `EXECUTION_INTERRUPTED`，检查文件后通过 `gemini_followup_task` 显式继续。同步写作属于当前请求，需要重连恢复的长任务应使用 `kind: "writing"`。

## 配置与检查

Codex 根据 [.env.example](.env.example) 配置环境变量，父进程变量优先。默认实现模型为 `gemini-3.8-flash-high`，写作模型为 `gemini-3.8-flash-medium`，可通过 `AGY_AGENT_MODEL` 和 `AGY_MODEL` 调整。模型可用性取决于本机 CLI 和账号。

可选官方 API 接入需要同时设置 `WRITER_PROVIDER=gemini-api`、`GEMINI_API_KEY` 和 `GEMINI_API_MODEL`，并选择支持所需思考档位的模型。服务不会自动切换 Provider。凭证应保存在本机环境，不应提交到仓库。

`gemini2codex --help` 显示帮助。源码安装可执行 `node dist/index.js --help`。`npm run healthcheck` 和工具 `gemini_health` 会显式请求 Provider。普通初始化、工具列表和 ping 不启动 agy。

## 友链

[LINUX DO 社区](https://linux.do/)

## 许可证

[MIT](LICENSE)
