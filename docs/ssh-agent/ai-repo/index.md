# Gori AI 代码路由

本目录用于把开发问题快速路由到真实代码。代码是第一现场和最高优先级；本文档只提供边界、入口和文件位置，不替代源码阅读。

## 使用顺序

1. 根据下表选择功能文档。
2. 打开功能文档列出的源码入口。
3. 阅读与任务相关的源码后再做设计或修改。
4. 修改后执行本文末尾的防腐检查。

## 功能路由

| 要处理的问题 | 功能文档 | 首要源码入口 |
|---|---|---|
| 独立工程的构建、启动、端口与数据目录 | [local-distribution.md](./local-distribution.md) | `scripts/build.mjs`、`scripts/start.mjs`、`package.json` |
| Workspace、Session、Credential 的实体、Service、Repository 和生命周期约束 | [management-domain.md](./management-domain.md) | `packages/ssh-agent/src/domain/`、`packages/ssh-agent/src/application/` |
| Guard 配置、规则 ID、匹配模式和整体 PATCH 语义 | [guard.md](./guard.md) | `packages/ssh-agent/src/domain/guard.ts`、`packages/ssh-agent/src/application/services/guard-service.ts` |
| LLM Provider/Model 目录、Provider Credential 和 pi-ai 接入 | [llm-provider.md](./llm-provider.md) | `packages/ssh-agent/src/domain/llm-provider.ts`、`packages/ssh-agent/src/application/services/llm-provider-service.ts` |
| 创建工作区前测试地址与草稿凭据、临时 SSH 认证和取消 | [connection-test.md](./connection-test.md) | `packages/ssh-agent/src/application/services/connection-test-service.ts`、`packages/ssh-agent-web/features/workspace/components/workspace-dialog.tsx` |
| SSH Connection Key、连接复用、Channel、主机校验、保活和重连 | [connection-runtime.md](./connection-runtime.md) | `packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-pool.ts` |
| Session 命令 FIFO、进程并发限制与排队超时 | [command-execution.md](./command-execution.md) | `packages/ssh-agent/src/application/services/session-command-scheduler.ts` |
| Operation 执行编排、执行期策略、状态/输出记录和失败分类 | [command-execution.md](./command-execution.md) | `packages/ssh-agent/src/application/services/command-operation-service.ts`、`packages/ssh-agent/src/application/services/command-execution-policy.ts`、`packages/ssh-agent/src/application/services/command-operation-recorder.ts` |
| 普通远端命令的授权计划、executionContext 交接、调用绑定和一次性 grant | [command-execution.md](./command-execution.md)、[remote-sandbox.md](./remote-sandbox.md) | `packages/ssh-agent/src/application/tools/remote-command-execution-plan.ts`、`packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/services/remote-sandbox-approval-store.ts` |
| 远端 Linux Landlock/Bubblewrap、可写根、安装审批、Full Access 与审计 | [remote-sandbox.md](./remote-sandbox.md) | `packages/ssh-agent/src/infrastructure/sandbox/`、`packages/ssh-agent/src/application/services/bubblewrap-installation-service.ts` |
| Session 沙盒模式、单一 Composer 命令、执行绕过与 Terminal 自动重开 | [session-sandbox.md](./session-sandbox.md) | `packages/ssh-agent/src/application/services/session-sandbox-policy.ts`、`session-service.ts`、`packages/ssh-agent-web/features/session/runtime/use-session-sandbox.ts` |
| 沙箱能力查询/强制刷新、连接代际缓存、准备诊断和共同文件规则 | [remote-sandbox.md](./remote-sandbox.md) | `packages/ssh-agent/src/application/services/remote-sandbox-provider.ts`、`packages/ssh-agent/src/infrastructure/sandbox/remote-sandbox-coordinator.ts`、`packages/ssh-agent/src/infrastructure/sandbox/sandbox-capability-cache.ts`、`packages/ssh-agent/src/infrastructure/sandbox/sandbox-command-runner.ts` |
| SQLite schema、migration、Repository、Credential 加密和运行时装配 | [sqlite-persistence.md](./sqlite-persistence.md) | `packages/ssh-agent/src/infrastructure/sqlite/` |
| Command/Terminal 沙箱事实解码、旧 Full Access/null 记录和状态约束 | [sqlite-persistence.md](./sqlite-persistence.md) | `packages/ssh-agent/src/infrastructure/sqlite/stored-command-sandbox.ts`、`packages/ssh-agent/src/infrastructure/sqlite/stored-terminal-sandbox.ts` |
| HTTP 路由、请求校验、CORS、环境变量、进程启动和关闭 | [http-server.md](./http-server.md) | `packages/ssh-agent/src/api/`、`packages/ssh-agent/src/server/` |
| 本地日志、按日与大小滚动、异常栈 | [logging.md](./logging.md) | `packages/ssh-agent/src/server/file-logger.ts` |
| Chat 统一异常、cause/errorId、Run 终态提交与恢复 | [chat-failures.md](./chat-failures.md) | `packages/ssh-agent/src/application/failure-policy.ts`、`packages/ssh-agent/src/application/services/chat-run-executor.ts` |
| 聊天和压缩的厂商原因提取、安全展示和重试属性 | [provider-failures.md](./provider-failures.md) | `packages/ssh-agent/src/application/provider-failure.ts` |
| 系统和 Session 本地目录浏览、绝对路径契约和文件系统边界 | [local-file-system.md](./local-file-system.md) | `packages/ssh-agent/src/application/services/local-file-system-service.ts` |
| Session 附件上传、自动命名、受控图片回显、SQLite 元数据和生命周期约束 | [attachments.md](./attachments.md) | `packages/ssh-agent/src/application/services/attachment-service.ts` |
| Chat 图片附件引用、真实格式校验、Provider 多模态投影和引用持久化 | [chat-image-input.md](./chat-image-input.md) | `packages/ssh-agent/src/application/services/chat-attachment-service.ts` |
| SFTP 文件管理、Transfer、Workspace SSE 和 Linux 实时监控 | [sftp-monitoring.md](./sftp-monitoring.md) | `packages/ssh-agent/src/application/services/file-transfer-service.ts`、`packages/ssh-agent/src/application/services/remote-metrics-service.ts` |
| Session 页首 CPU/内存/网络速率、共享监控缓存和默认网卡统计 | [session-server-metrics.md](./session-server-metrics.md) | `packages/ssh-agent-web/features/server-metrics/`、`packages/ssh-agent/src/application/monitoring/remote-network-sampler.ts` |
| 文件工具路径冲突、整批串并行与共享 SFTP Channel | [file-tool-concurrency.md](./file-tool-concurrency.md) | `packages/ssh-agent/src/application/services/file-tool-concurrency.ts`、`packages/ssh-agent/src/infrastructure/ssh/ssh2-sftp-channel-pool.ts` |
| 新会话首条消息自动标题、模型命名和 SSE 更新 | [session-title.md](./session-title.md) | `packages/ssh-agent/src/application/services/session-title-service.ts` |
| 首次 Run 固定头部、环境快照、模式 system 消息与缓存边界 | [session-prompt.md](./session-prompt.md) | `packages/ssh-agent/src/application/services/chat-prompt-service.ts`、`packages/ssh-agent/src/application/chat-context.ts` |
| Session Chat、Pi Agent 事件、本地工具、审批、队列和压缩 | [chat-runtime.md](./chat-runtime.md) | `packages/ssh-agent/src/application/services/chat-service.ts`、`packages/agent/src/harness/agent-harness.ts` |
| Tool 错误是否终止模型、模式/工作流门禁和工具自有审批准备 | [chat-runtime.md](./chat-runtime.md) | `packages/ssh-agent/src/application/tools/tool-authorization.ts`、`packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts`、`packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| Agent 用户决策工具、等待持久化、恢复与输入框上方的面板 | [user-decision.md](./user-decision.md) | `packages/ssh-agent/src/application/services/chat-user-decision-service.ts`、`packages/ssh-agent-web/features/chat/components/user-decision-panel.tsx` |
| `/deploy` 模型驱动阶段、Profile、首次配置 Skill、部署历史与阶段 UI | [deployment.md](./deployment.md) | `packages/ssh-agent/src/application/services/deployment-service.ts`、`packages/ssh-agent/src/application/tools/deployment-agent-tool.ts`、`packages/ssh-agent-web/features/deploy/` |
| Provider 请求前检查、上下文超限恢复、摘要消息、压缩 Setting 和手动压缩 | [context-compaction.md](./context-compaction.md) | `packages/ssh-agent/src/application/services/chat-context-service.ts`、`packages/agent/src/agent-loop.ts` |
| Session 上下文占用查询、Turn/压缩完成快照与 SSE | [context-usage.md](./context-usage.md) | `packages/ssh-agent/src/application/chat-context.ts`、`packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 长周期 SSH PTY、Canonical State、打开/清理、输入策略/状态记录、Observation 和只读前端 | [terminal-interaction.md](./features/terminal-interaction.md) | `packages/ssh-agent/src/application/services/terminal-session-service.ts`、`packages/ssh-agent/src/application/services/terminal-interaction-service.ts`、`packages/ssh-agent/src/application/terminal/`、`packages/ssh-agent-web/features/terminal/` |
| SSH Agent Web 页面、前端功能、客户端状态、API/SSE 和测试位置 | [ssh-agent-web.md](./ssh-agent-web.md) | `packages/ssh-agent-web/app/`、`packages/ssh-agent-web/components/`、`packages/ssh-agent-web/features/` |
| Web 明亮、暗部、明暗分层实验、跟随系统主题及 Terminal 动态配色 | [theme.md](./theme.md) | `packages/ssh-agent-web/features/theme/`、`packages/ssh-agent-web/features/settings/`、`packages/ssh-agent-web/app/globals.css` |
| Web 中英文界面、Locale 首屏恢复、类型化消息目录和语言切换 | [i18n.md](./i18n.md) | `packages/ssh-agent-web/features/i18n/`、`packages/ssh-agent-web/app/layout.tsx` |
| 后端公开异常、静态提示、REST/SSE Locale 协商和按订阅者投影 | [backend-i18n.md](./backend-i18n.md) | `packages/ssh-agent/src/i18n/`、`packages/ssh-agent/src/api/http-handler.ts` |

Workspace/Credential 前端契约见 [workspace-credential-integration.md](../frontend/workspace-credential-integration.md)，SFTP/Overview 实时联调见 [sftp-overview-realtime-integration.md](../frontend/sftp-overview-realtime-integration.md)，LLM Provider 前端契约见 [llm-provider-integration.md](../frontend/llm-provider-integration.md)，SSH 命令事件契约见 [ssh-command-events-integration.md](../frontend/ssh-command-events-integration.md)，Connection Pool 与命令执行的完整设计说明见 [ssh-connection-pool-and-command-execution.md](../design/ssh-connection-pool-and-command-execution.md)，其余请求体和响应体契约见 [frontend-integration.md](../frontend-integration.md)。

远端沙箱的双后端选择、安装审批和验证边界见 [多后端设计](../design/remote-sandbox-backends.md)。

跨电脑接续这几轮沙箱与权限重构时，先按上表阅读当前功能文档；[计划与续写上下文](../design/sandbox-authorization-handoff-2026-10-09.md) 补充已完成阶段和剩余建议。续写文档记录阶段状态，当前职责与行为以功能文档和源码为准。


本地与远程联调约定见 [test-environments.md](../test-environments.md)。真实服务器资料不进入本仓库。

## 当前实现边界

已经实现：Workspace 管理、Credential/Host Trust、Guard、LLM Provider、SSH exec Connection Pool、命令 Operation、Session 附件上传和受控图片回显、图片附件 Chat 输入，以及 Workspace 级 SFTP 文件管理、六状态 Transfer、流式上传下载、Workspace SSE 和 Linux 实时监控。

已经实现的 Terminal Interaction MVP：用户手动开启独立模式，后端维持长周期 PTY 和 Canonical State，Agent 使用专用 Tool，浏览器通过 snapshot + SSE 只读投影并同步 owner resize，Interaction/Input/Observation/Timeline 持久化到 SQLite。

已经实现的 `/deploy`：用户选定服务后先进入可跨多轮 Chat Run 的模型驱动讨论；模型提交并经服务端校验本次构建、上传、重启与验证参数后，才生成待确认的流水线。确认后模型逐阶段推进；Plan v2 阶段失败会保留原记录，模型可提出仅修改失败阶段的修订，用户确认后从该阶段继续。完整命令和日志按需展开；远端重启与验证按 Session 沙盒设置与 `autoAudit` 执行，开启时只有沙箱不可用或已知写入路径越界才逐条人工批准 Full Access，关闭时跳过沙箱链路并保留普通审批，所有命令继续受 Guard 约束。详见 [deployment.md](./deployment.md)。

尚未实现：附件删除、非图片附件的通用内容下载和 LLM 输入、图片生成、断点续传、Transfer 历史自动清理、主机密钥重新信任/预置信任/SSH CA、Chat 多 Lane/Fork 和跨进程 delta 重放。Terminal MVP 不允许用户输入、不自动开启模式，使用 REST + SSE 而不引入 WebSocket。

## 文档防腐机制

`manifest.json` 记录每份功能文档依赖的源码路径及内容摘要。源码变化后，检查会把对应文档标记为过期。

```bash
# 只检查，不修改文件
node docs/ssh-agent/ai-repo/check.mjs

# 阅读源码并校正文档后，刷新摘要
node docs/ssh-agent/ai-repo/check.mjs --update

# 刷新后必须再次检查
node docs/ssh-agent/ai-repo/check.mjs
```

`--update` 只表示“已人工重新核对”，不证明文档内容正确。维护约束见根目录 [agent.md](../../../agent.md)，`AGENTS.md` 为工具自动发现入口。根 `npm run check` 已包含本检查。
