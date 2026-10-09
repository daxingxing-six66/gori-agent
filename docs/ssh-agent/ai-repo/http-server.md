# HTTP Server 代码路由

适用于管理 API 路由、JSON 校验、错误映射、Node HTTP 适配、CORS、请求体限制、环境变量和进程生命周期。

- `POST /api/workspaces/test-connection` 接收尚未保存的地址、Credential 和连接参数，认证成功返回 `{ success: true }`，不创建工作区或执行命令。Node 适配器在响应连接提前关闭时取消 Request，包括请求体已读完的情况；正常结束不取消。详见 [connection-test.md](./connection-test.md)。
- `POST /api/workspaces/browse-directory` 以同一草稿连接读取指定远端绝对路径的 SFTP 目录，不创建工作区或持久化凭据。接口请求可取消，细节见 [connection-test.md](./connection-test.md)。

Workspace POST/PATCH 接受可选 `remoteDefaultCwd`，响应携带持久化的远端默认目录；创建省略取 `/`，更新省略保留。`defaultCwd` 保留为本地会话默认目录，两个字段独立。

Workspace POST/PATCH 只通过 `remoteDefaultCwd` 设置远端默认目录及 Landlock 可写根，不再接收独立根字段。`POST /api/workspaces/:id/sandbox` 通过正式目标解析显式检测远端沙箱，成功返回 mode/backend/enforcement/ABI/root；不运行用户脚本，可能创建连接及投递启动器。失败沿用安全本地化错误；该检测接口不提供 Full Access 直通执行。见 [remote-sandbox.md](./remote-sandbox.md)。

## 请求链路

`Node IncomingMessage` 由 HTTP 适配器转换为 Web `Request`，随后进入 HTTP handler、Service 和 Repository；响应按相反方向返回。SFTP 与 SSE 协议见 [sftp-overview-realtime-integration.md](../frontend/sftp-overview-realtime-integration.md)。

## 当前边界

- 用户决策使用 `GET /api/sessions/:sessionId/chat/decisions` 恢复待决题，`POST /api/sessions/:sessionId/chat/decisions/:decisionId/answer` 提交按题序排列的 `{ answers }`；Session、题目数量和答案类型在服务边界验证，重复同答幂等，冲突或过期返回错误。当前 Run SSE 发送 `decision.requested` 与 `decision.resolved`。见 [user-decision.md](./user-decision.md)。

- 首次 Chat Run 接受可选 `generateTitle` 布尔值；Workspace SSE 可显式订阅 `sessions` topic 接收 `session.updated`。原默认 topics 和 SSE 传输机制不变，见 [session-title.md](./session-title.md)。
- Deployment REST 位于 `/api/sessions/:id/deployments`：GET 发现当前主机 Profile、最近 Run 和活动 Discussion；`/discussions` POST 开始服务讨论，`/discussions/active` 与 `/discussions/:discussionId` GET 恢复状态，`/discussions/:discussionId/cancel` POST 取消。首次 Chat Run 使用 `workflow=deployment_planning` 和 `deploymentDiscussionId`，后续普通新 Run 可继续当前讨论；模型提案才创建待确认 Plan。`/history` 按不透明游标分页返回持久化部署记录，`/:runId` 查询快照，`/:runId/approvals/:stage/:approvalId/approve|reject` 为准确的 RESTART/VERIFY 命令作人工决定，`/:runId/recovery/:proposalId/approve|reject` 供用户确认或拒绝失败阶段的模型修订，`/:runId/cancel` 取消。旧的根路径 POST Prepare 接口仍保留兼容，但新 UI 不使用；`/:runId/confirm` 返回冲突。用户核对计划并批准远端命令后，以 `workflow=deployment_execution` 和 `deploymentRunId` 启动模型编排；失败后 `workflow=deployment_recovery` 可绑定同一 Run 讨论修复。`deployments` Workspace SSE topic 分发 Discussion 和阶段快照，前端独立订阅；详见 [deployment.md](./deployment.md)。

- `GET /api/sessions/:sessionId/chat/context-usage` 只读返回占用快照或 null，使用 `no-store`；手动压缩响应包含同结构 `contextUsage`。联调见 [context-usage-integration.md](../frontend/context-usage-integration.md)。

- 默认监听 `127.0.0.1:3001`，提供 `/healthz` 和 `/api/*`。
- 使用持久化 SQLite 时，Server 在构造后端并执行部署、Chat、Terminal 中断恢复之前，先通过数据库旁的 `<数据库路径>.server-lock.sqlite` 文件取得进程级所有权。第二个使用相同数据库的 Server 即使监听其他端口，也会在恢复记录前被拒绝；正常关闭或端口绑定失败后释放锁，进程意外退出则由 SQLite/操作系统释放。`:memory:` 测试后端不需要此锁；直接调用底层 Backend 工厂不经过 Server 所有权检查。
- CLI 把 console 日志写入数据目录的 `logs/`，按本地日期及 10 MiB 分段；启动、关闭和未捕获异常保留错误栈。见 [logging.md](./logging.md)。
- 支持 Workspace + Session tree、Workspace 范围 Credential、活动 Credential 切换、Workspace、Session 和 Guard 管理路由；Guard 还提供后端预设规则包目录查询和原子导入接口；全局 Credential 路由已经移除。
- Workspace 创建请求只接收 hostname/port，不接收前端提供的 Host Key；创建响应和首次 Tool 调用前的 Tree 返回 `hostKey: null`，自动 TOFU 后 Tree 返回后端持久化的信任记录。
- `/api/llm/providers` 和 Provider 模型路由读取 `pi-ai` 运行时目录；LLM Provider Credential 路由只返回元数据，API Key 和环境认证值只写。
- Node 层负责 CORS、普通 JSON 请求体上限和流式响应；SFTP content 上传和 Session Attachment 原始字节上传绕过整体缓冲。Attachment 独立执行 20 MiB 上限和 Content-Length 一致性校验。API handler 负责路由、校验及错误映射。
- REST 与 SSE 在出口协商 `zh-CN`/`en-US`：REST 使用 `Accept-Language`，SSE 的 `locale` 查询参数优先于该 Header，缺省为 `zh-CN`。响应保持原 JSON/SSE 结构，只替换后端静态字符串，并携带 `Content-Language`；使用 Header 协商时同时携带 `Vary: Accept-Language`。
- 包内公开异常统一经过 `application/failure-policy.ts` 的 `normalizePublicError()`，HTTP owner 通过共用 reporter 记录诊断；已知和未知错误都携带 errorId。已知领域异常保留稳定 code、status、field、retryable 和安全 details；未知异常只返回 `internal_error` 与可查日志的 `errorId`，底层 message、cause 和 stack 不发送到浏览器。详细边界见 [backend-i18n.md](./backend-i18n.md)。
- CORS preflight 允许 `PUT`，用于活动 Credential 切换。
- CLI 从环境变量读取数据库路径、32 字节加密密钥、监听地址、端口、CORS allowlist、请求体上限、进程命令并发上限和 `SSH_AGENT_LOCAL_CWD`，并处理 SIGINT/SIGTERM。默认数据目录为 `SSH_AGENT_DATA_DIR` 或 `~/.gori-agent`；未显式配置时数据库为其中的 `ssh-agent.sqlite`，本地目录为 `workspace/`，附件与日志也使用该数据目录。未提供环境密钥时创建或复用 `credential-key`，已有数据库缺失密钥则拒绝启动。
- CLI 通过 `builtinModels()` 注入真实 `pi-ai` 目录；测试通过相同工厂端口注入 faux Provider，不复制内置模型清单。
- 服务本身不提供 TLS、登录认证或公网访问控制；非 loopback 部署必须由外层安全边界补齐。
- Workspace SSE 按 monitoring、connection、transfers、sessions、deployments topic 广播并定时 heartbeat；SSH Command Operation 事件仍不走该 SSE。
- Chat 使用独立 Run SSE；断线不取消 Run，高频 delta 不写 SQLite。
- 单 Session GET 组合最近 Chat Run 模型选择；Chat Run 请求支持继承最近模型，并验证 Provider/Model 成对提交和模型支持的 thinking level。
- Chat Run 和 Queue JSON 可携带 `attachmentIds`。请求校验数量、非空和重复 ID；Session 所有权、真实图片格式和模型图片输入能力由 Chat Attachment Service 校验。
- 本地文件接口按需列出普通文件和目录并返回规范化绝对路径：系统接口以 `/` 为根，Session 接口以有效 `workDir` 为硬边界；文件系统细节见 [local-file-system.md](./local-file-system.md)。
- `POST /api/sessions/:sessionId/attachments?name=...` 接收原始文件字节，同名时原子选择递增名称；`GET /api/sessions/:sessionId/attachments` 返回带受控 `contentUrl` 的附件元数据列表。`GET /api/sessions/:sessionId/attachments/:attachmentId/content` 流式返回经过真实格式校验的 JPEG、PNG 或 WebP，并支持不可变私有缓存和 ETag。接口不使用 multipart/Base64，不提供附件删除、覆盖或非图片通用下载；完整边界见 [attachments.md](./attachments.md)。
- 默认后端已装配 TerminalSession 与 TerminalInteraction Service。`/api/sessions/:sessionId/terminal` 提供状态、open/close、attachment、ready/focus/resize/detach、timeline、observation 和 SSE；服务关闭先停止接受新连接，再关闭 Terminal runtime 以终止长连接，最后等待 HTTP drain。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| API 响应结构 | [contracts.ts](../../../packages/ssh-agent/src/api/contracts.ts) |
| Locale、公开异常与响应投影 | [message.ts](../../../packages/ssh-agent/src/i18n/message.ts)、[public-error.ts](../../../packages/ssh-agent/src/i18n/public-error.ts)、[projection.ts](../../../packages/ssh-agent/src/i18n/projection.ts) |
| 路由和错误状态映射 | [http-handler.ts](../../../packages/ssh-agent/src/api/http-handler.ts) |
| Attachment 流式上传、列表和受控图片内容路由 | [attachment-routes.ts](../../../packages/ssh-agent/src/api/attachment-routes.ts) |
| Chat 图片附件输入 | [chat-image-input.md](./chat-image-input.md) |
| 请求体字段校验 | [request-validation.ts](../../../packages/ssh-agent/src/api/request-validation.ts) |
| Terminal REST/SSE 与请求校验 | [terminal-routes.ts](../../../packages/ssh-agent/src/api/terminal-routes.ts)、[terminal-request-validation.ts](../../../packages/ssh-agent/src/api/terminal-request-validation.ts) |
| Web Request 与 Node HTTP 适配、CORS、body limit | [node-http-server.ts](../../../packages/ssh-agent/src/server/node-http-server.ts) |
| Server 生命周期和后端组合 | [ssh-agent-server.ts](../../../packages/ssh-agent/src/server/ssh-agent-server.ts) |
| SQLite Server 所有权锁 | [database-ownership.ts](../../../packages/ssh-agent/src/server/database-ownership.ts) |
| 环境变量解析 | [environment.ts](../../../packages/ssh-agent/src/server/environment.ts) |
| CLI、umask 和信号关闭 | [main.ts](../../../packages/ssh-agent/src/server/main.ts) |
| SQLite 管理后端装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 包导出入口 | [index.ts](../../../packages/ssh-agent/src/index.ts) |
| TCP、CORS、body limit 测试 | [http-server.test.ts](../../../packages/ssh-agent/test/http-server.test.ts) |
| 环境配置测试 | [server-environment.test.ts](../../../packages/ssh-agent/test/server-environment.test.ts) |

新增接口时通常需要同步检查 handler、request validation、Management API、前端联调文档和相应定向测试。
