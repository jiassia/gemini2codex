# gemini2codex

通过本地 stdio MCP 服务，让 Codex 调用 Gemini 完成前端开发、通用实现和写作任务。Codex 负责任务范围、授权、集成与验收；Gemini 负责执行委派任务。

当前仓库为私有审阅版本，下载与克隆需要仓库访问权限及 GitHub 身份验证。确认公开前不提供匿名安装。

## 环境要求

需要 Node.js 22 或更高版本、npm 和 Git。Windows 构建还需要 .NET Framework 4 的 C# 编译器，构建脚本会从系统目录查找 csc.exe。

默认使用 Antigravity CLI `agy`，需先安装并完成登录。安装信息参见 [Antigravity 官方文档](https://antigravity.google/docs/cli/headless/)。`agy` 应位于 PATH，或通过 `AGY_COMMAND` 指定可执行文件的绝对路径。

## 一行运行

```sh
npx --yes --package=github:jiassia/gemini2codex#v2.2.0 gemini2codex
```

npm 会从 GitHub 下载指定版本、安装依赖、构建源码并启动服务，无需预先克隆仓库。本命令使用 GitHub 源码包，不依赖 npm registry 中的同名包。首次运行需要网络和上述构建环境。启动后服务等待 MCP 客户端通过标准输入输出通信，单独运行时不会显示聊天界面。

在 Codex 的 `config.toml` 中加入以下配置。Windows 使用 `npx.cmd`，其他系统使用 `npx`。

```toml
[mcp_servers.gemini_writer]
command = "npx.cmd"
args = ["--yes", "--package=github:jiassia/gemini2codex#v2.2.0", "gemini2codex"]
startup_timeout_sec = 180
```

配置后新开 Codex 会话。为兼容现有调用，服务名 `gemini_writer` 和工具名 `gemini_*` 保持稳定。

可将以下安装要求交给支持终端操作的 AI：

> 请从 https://github.com/jiassia/gemini2codex 自动下载并安装 MCP。先检查 Node.js 22+、npm、Git 和已登录的 agy，再按照 README 配置 Codex；如需自动委派规则，请采用源码安装并执行 npm run configure:codex。完成后检查 MCP 初始化和工具列表，并说明需要新开会话。账号登录由用户完成。

## 从源码构建

```sh
git clone https://github.com/jiassia/gemini2codex.git
cd gemini2codex
npm ci
```

`npm ci` 通过 `prepare` 自动完成 TypeScript 和 Windows 启动器构建。修改源码后执行 `npm run build`；`npm start` 启动 stdio 服务。

```sh
npm run configure:codex
```

此命令为当前源码目录安装 Codex 配置和自动委派规则，先备份再修改 `CODEX_HOME` 或用户主目录 `.codex` 下的 `config.toml`、`AGENTS.md`。安装后应保留该源码目录，并新开 Codex 会话。Windows 也可使用 `build.cmd` 和 `configure-codex.cmd`。

## 使用

任务协作工具包括 `gemini_spawn_agent`、`gemini_send_message`、`gemini_followup_task`、`gemini_wait_agent`、`gemini_list_agents` 和 `gemini_interrupt_agent`。写作工具包括 `gemini_write`、`gemini_polish`、`gemini_rewrite` 和 `gemini_review`。

授权 Gemini 使用原生工具实现项目任务时，调用示例如下。`workspace` 应替换为已有项目的绝对路径。

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

默认写入和原生工具权限均关闭。原生工具模式以本机用户权限运行，固定命令列表不限制原生工具，也不提供操作系统沙箱。权限应与实际委派范围一致。`kind` 支持 `frontend`、`general` 和 `writing`。

创建任务后使用返回的 ID 查询或继续任务。`gemini_wait_agent` 配合 `after_revision` 获取新增进度；等待超时只返回当前状态。任务默认不设执行时限，使用 `gemini_interrupt_agent` 显式中断。`completed` 表示 Gemini 已提交报告，仍需检查实际文件和构建结果。

独立 supervisor 保存任务状态，已接受的任务在 MCP 连接断开后继续运行。提交结果不确定时复用原 `idempotency_key`，同一键用于不同请求会返回冲突。supervisor 中断后，未完成任务标记为 `EXECUTION_INTERRUPTED`，检查文件后通过 `gemini_followup_task` 显式继续。同步写作属于当前请求，需要重连恢复的长任务应使用 `kind: "writing"`。

## 配置与检查

可参考 [.env.example](.env.example) 配置环境变量，父进程变量优先。默认实现模型为 `gemini-3.8-flash-high`，写作模型为 `gemini-3.8-flash-medium`，可通过 `AGY_AGENT_MODEL` 和 `AGY_MODEL` 调整。模型可用性取决于本机 CLI 和账号。

可选官方 API 接入需要同时设置 `WRITER_PROVIDER=gemini-api`、`GEMINI_API_KEY` 和 `GEMINI_API_MODEL`，并选择支持所需思考档位的模型。服务不会自动切换 Provider。凭证应保存在本机环境，不应提交到仓库。

`gemini2codex --help` 显示帮助。源码安装可执行 `node dist/index.js --help`。`npm run healthcheck` 和工具 `gemini_health` 会显式请求 Provider。普通初始化、工具列表和 ping 不启动 agy。

仓库仅包含运行、构建和安装所需源码与文档，测试数据、历史诊断记录、依赖和构建产物不纳入源码发布。

## 许可证

[MIT](LICENSE)
