# Gori

[English](README.en.md)

Gori（小猩）是一款面向个人开发者的轻量 SSH Agent。用自然语言完成单台 Linux 服务器上的日常操作

项目基于 pi 的 Agent 和模型适配层开发。后端运行在本机，使用 SSH 连接你的服务器；模型请求发送到你配置的供应商。Gori 是独立应用，底层通过 SSH 协议连接服务器。

> 开源准备版本：独立构建和 macOS 本地启动验收已通过，Linux、Windows 与真实 SSH/模型联调仍待验证。详见 [验收记录](docs/release-readiness.md)。

## 功能

- Workspace 与 Session 管理，保存 SSH 凭据和主机指纹。
- AI 流式对话、工具调用、人工审批、任务队列和上下文压缩。
- SSH 命令执行、SFTP 上传下载和远程服务器指标。
- AI 终端交互模式与只读终端视图。
- 中英文界面、明暗主题和自定义模型供应商。

## 本机运行

支持目标：macOS、Linux、Windows。需要 Node.js 22.19.0 或更高版本，以及随 Node.js 安装的 npm。Windows 使用 PowerShell 或命令提示符。

Windows 的本地 Bash 工具还需要 Git for Windows 提供的 Git Bash；仅安装 Node.js 不足以运行该工具。远程 SSH 命令在远程服务器执行。

下载本仓库 ZIP 并解压，在仓库根目录打开终端。首次执行：

```sh
node scripts/start.mjs --setup
```

脚本安装锁定的依赖、构建前后端、生成并保存凭据加密密钥，然后启动本地服务。首次安装需要联网。此流程使用源码构建，尚不是无需 Node.js 的独立安装包。

后续启动：

```sh
npm start
```

前端启动成功后，打开 <http://127.0.0.1:3000>。按 Ctrl+C 停止。

1. 在设置中配置模型供应商及其 API 凭据。
2. 创建 Workspace，填写服务器地址、SSH 用户及密码或私钥。
3. 创建 Session，选择模型并开始对话。
4. 涉及审批的工具调用，在界面中检查内容后批准或拒绝。

默认使用本机 3000（网页）和 3001（后端）端口。该启动入口面向本机单用户使用，不提供公网登录服务。

若端口被占用，可选择其他端口。macOS / Linux：

```sh
SSH_AGENT_PORT=4311 npm run build
SSH_AGENT_WEB_PORT=4310 npm start
```

Windows PowerShell：

```powershell
$env:SSH_AGENT_PORT="4311"
npm run build
$env:SSH_AGENT_WEB_PORT="4310"
npm start
```

此时打开 <http://127.0.0.1:4310>。后端地址会写入前端构建产物，所以更换后端端口后必须重新构建；网页端口可以在启动时调整。启动器读取上次构建的端口记录，不会自动结束占用端口的程序。

## 数据与备份

数据目录是当前用户主目录下的 `.gori-agent`，Windows 对应 `%USERPROFILE%\.gori-agent`。旧 `.ssh-agent` 数据不会自动搬迁；继续使用旧数据的方法见 [迁移说明](docs/migration.md)。

- `credential-key`：凭据加密密钥。必须与数据库一起备份；丢失后无法解密已保存凭据。
- `ssh-agent.sqlite`：应用数据库。
- `workspace/`：本地工作目录。

启动器也把附件保存在该数据目录下。先停止程序再备份整个 `.gori-agent` 目录。可用 `SSH_AGENT_DATA_DIR` 指定其他数据目录，升级验证仍见验收记录。日志写入 `packages/ssh-agent/logs/`。提交问题前删除日志中的服务器地址、命令输出和个人信息。

密钥不等于登录认证。不要把本地服务直接暴露到公网。AI 可通过工具执行本地或远程操作；请使用你愿意授予它的账户权限。详见 [安全说明](SECURITY.md)。

## 开发

这是一个 npm workspace 工程：

| 模块 | 职责 |
| --- | --- |
| `packages/ssh-agent-web` | React / Vinext 浏览器界面 |
| `packages/ssh-agent` | HTTP、SQLite、SSH 和聊天服务 |
| `packages/agent` | pi Agent 核心 |
| `packages/ai` | 模型和供应商适配 |
| `packages/telemetry` | 共享遥测契约 |

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm run test:backend
npm run test:web
```

模型目录 JSON 随源码提供，`npm run check:model-data` 检查结构和摘要。普通安装不需要重新请求模型目录服务。

阅读 [贡献指南](CONTRIBUTING.md) 和 [Java 开发者的 TypeScript 项目入门](docs/typescript-for-java-developers.md)。

## 来源与许可证

采用 [MIT License](LICENSE)。保留 pi 原作者 Mario Zechner 的许可证与版权声明。`packages/agent`、`packages/ai` 和 `packages/telemetry` 来自 pi；参见 [来源说明](NOTICE.md)。

## AI 开发入口

先读 [agent.md](agent.md)，再读 [AI 代码路由](docs/ssh-agent/ai-repo/index.md)。迁移说明见 [migration.md](docs/migration.md)。
