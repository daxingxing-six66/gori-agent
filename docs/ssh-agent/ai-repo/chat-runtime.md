# Chat Runtime 代码路由

适用于 Session Chat Run、Pi Agent 事件、工具审批、steer/follow-up、本地工具和自动上下文压缩。

## 当前边界

- 新会话首个 Run 可通过 `generateTitle: true` 启用同模型异步命名；标题任务独立于聊天，不进入消息历史，通过 Workspace SSE 推送。见 [session-title.md](./session-title.md)。

- 每次模型流请求经过包内 Provider 错误边界，附件水合与模型同步异常分别处理。安全原因使用描述符贯穿消息、Run failure、HTTP/SSE；原始文本供超限判断与日志使用，未知内部错误不公开。见 [provider-failures.md](./provider-failures.md)。

- 上下文占用在每次 `turn_end` 和自动压缩保存摘要后推送 `context.updated`；刷新通过独立查询恢复，手动压缩返回 `contextUsage`。头部组装纯函数位于 `application/chat-context.ts`，工具共享静态定义；有效消息按 compact 边界加载，不能把 Agent 完整 transcript 当作压缩后 Context。见 [context-usage.md](./context-usage.md)。

- Session 保存 `workDir` 与 `autoAudit`；创建时未指定 `workDir` 则从 Workspace `defaultCwd` 继承并验证本地目录，创建后独立保存。已有 Session 的 null 值仍使用服务默认目录。
- Session 详情从最近一次 `chat_runs` 记录投影 `chatModelSelection`；首次 Run 显式选模型，后续 Run 可继承，模型与 thinking level 变化按当前 `pi-ai` 目录重新校验。
- 模型选择从 SSH Agent 的有效目录读取。上游明确返回所选模型不再受支持时，Run 以 `chat_model_not_supported` 失败，最终 assistant 消息携带统一安全失败报告，在公开投影中显示用户友好提示，同时该模型立即从有效目录和持久化快照删除；不会触发一次无意义的即时刷新。
- `ChatService` 保留 Chat use case、活动 Run 与初始化互斥、创建顺序和资源归属，`chat-run-executor.ts` 负责执行与清理。`ChatPromptService` 在首次 Run 组装并持久化不可变头部；后续 Run 直接复用。模式切换以真实 system 消息追加到历史，头部只解释标签及首次环境；两个远端 Tool schema 保持稳定，由运行时门禁限制可用入口。完整边界见 [session-prompt.md](./session-prompt.md)。
- Chat 与上下文压缩请求只在模型 `provider` 精确为 `opencode-go` 时附加稳定的 `x-opencode-session=<Session ID>` 和 `x-opencode-client=pi`，满足 OpenCode Go 的会话路由要求；其他 Provider 的请求选项和 Header 保持不变。
- Approval、Tool Call 协调、Queue、AgentEvent 投影、Context 压缩和 Run SSE 分别由 `ChatApprovalService`、`ChatToolCallCoordinator`、`ChatQueueService`、`ChatAgentEventHandler`、`ChatContextService` 和 `ChatRunEventHub` 持有。`ChatContextService` 在每次 Provider 请求前估算完整 payload，必要时用 PI compaction 生成摘要；Provider 尚未输出有效内容就返回上下文超限时，同一扩展点强制压缩并只重试一次。`ChatToolAuthorizationPolicy` 只负责 Tool 分类、远端和 Terminal Guard 预检查、`autoAudit` 决策及 Terminal Approval 结果回写；持久化继续通过 `ChatRepository` 端口隔离。
- Chat Run 从创建持久化前到执行 finally 持有 Session lifecycle lease；删除屏障建立时拒绝新 Run。Run 冻结 `serverInteractionMode`，Terminal Mode 绑定当前 TerminalSession；模式变化不会重写头部，Provider 请求前复核最新持久化模式，失效时停止当前 Run。
- `read` 无审批；`write`/`bash`/`remote_server_call`/Terminal submit 受 `autoAudit` 控制。远端命令和 Terminal submit 无论是否自动审批，都先执行 Guard 预检查并在派发前复检。`sftp_upload` 和 `sftp_download` 分别在远端、本地检查同名文件，仅覆盖时在 Tool 执行中读取当前 Session 的 `autoAudit`：开启则自动批准并记录 `source="auto"`，关闭则等待人工审批。并发同名冲突使用同一策略，非普通文件仍拒绝覆盖。所有 Approval 都携带后端生成并持久化的场景描述，SFTP 描述明确指出本地或远程文件覆盖。
- Run 内 steer/follow-up 使用 Pi Agent 队列；HTTP 请求 ID 和数据库唯一约束负责幂等。用户拒绝或审批超时会在完整 Tool Result 后停止当前 Turn 的自动延续，只取消 steer，follow-up 仍开启新的 Turn。
- 创建 Run、steer 和 follow-up 都可携带最多四个 Session 图片 Attachment ID；文本可为空但文本与附件不能同时为空。所选模型必须声明支持 `image` 输入，且切换到纯文本模型时当前有效历史不能仍含图片引用。消息和 Queue 只保存有序 ID；每次 Provider 请求前才安全读取 JPEG、PNG 或 WebP，并临时转换为 `ImageContent`，Base64 不进入 Agent Context、SQLite、SSE 或消息 API。详细边界见 [chat-image-input.md](./chat-image-input.md)。
- Run 内互斥生命周期由 `ChatRunRuntime` 的语义方法管理；其 `dispose()` 幂等中止 Agent 并清理 Node execution environment。Approval 等待完成时会同时清理 timeout、AbortSignal listener 和进程内 pending 索引。
- 前端刷新时通过活动 Run 和 Queue 只读接口恢复 Run SSE 与未消费消息；服务重启后活动 Run 为 `null`。
- Chat 前端通过独立的类型化 SSE 运行时归约消息、Tool、审批、Queue 和压缩状态；`message_end` 直接完成实时消息，不重复查询历史。审批卡片直接展示后端 `ToolApproval.description`，不根据 Tool 名称推断审批描述；操作区使用明确的主次按钮，SFTP 上传覆盖显示“取消 / 覆盖文件”，其他审批显示“取消 / 确认执行”。工具卡片以 Assistant Tool Call 的完整参数作为展示输入；其中 `terminal_interaction` 优先展示实际 `input`，无输入时展示 `Ctrl+C` 或原始 action，不显示 `expectation` 等运行协议字段，其余未知工具仍使用通用参数摘要作为降级。普通执行态的摘要发生真实横向截断时，悬浮或键盘聚焦会通过浏览器 portal 展示完整请求参数；审批态保持直接换行展示。
- pending Queue 在输入区展示为“引导/跟进”任务，可单独取消；普通发送始终加入 follow_up，行尾回车图标通过 `POST .../queue/{id}/steer` 转换同一 pending 项。后端同步更新数据库行为并重建 follow-up 内存队列、注入 steer，保留 ID、消息和附件，重复转换不重复注入；Run 不接受引导或消息不再 pending 时拒绝。前端归约避免延迟响应将终态恢复为 pending 或将 steer 降回 follow_up。入队时不会把乐观 User Message 提前写入聊天时间线，只有后端 Loop 消费后发出的正式消息事件才进入记录。Run 进入终态时会清除遗留的 pending Queue 和 Approval 操作。
- 消息 HTTP 接口以 Session 内单调递增的 `sequence` 提供双向游标分页：无游标返回最新一页，`beforeSequence` 向更早历史加载，`afterSequence` 向最新处补齐；三种模式都按升序返回，两个游标不能同时使用。前端首次只加载最新页，用户滚动接近顶部时请求更早历史，并按新增内容高度恢复原视口位置。UI 将 Thinking、Markdown 正文与 Tool 执行卡片分别渲染。用户消息气泡下方提供复制图标，复制发送给模型的原始文本（包括文件与目录引用标签），成功后仅在图标上给出短暂完成反馈。
- 进入已有 Session 时 Chat 消息区自动定位到最新消息；用户上滚超过底部阈值后停止跟随流式内容并显示“回到最新消息”按钮，返回底部后恢复自动跟随。
- Chat 输入区可直接更新 Session 的 `autoAudit`，但活动 Run 期间禁用修改；模型选择器与发送或停止操作位于同一操作区。新 Session 输入区可在首次发送前通过系统目录选择器设置本地 `workDir`，创建请求会携带该绝对路径；Session 编辑弹窗复用同一选择器，两处都不接受手填路径。
- Session 模型偏好恢复会重新解析当前 Provider 与模型目录；恢复请求使用递增令牌隔离 Session，Abort 不会标记恢复完成，过期请求不能覆盖新 Session。历史模型已失效时结束加载并要求重新选择，目录请求失败时允许显式重试。
- Chat 输入区使用统一 Composer Menu：消息开头的 `/` 只唤起即时前端工具，合法位置的 `@` 同时提供工具与本机文件；没有匹配工具时隐藏工具分组，工具与文件均无匹配时只显示统一空状态。选择工具不会创建用户 Chat 消息或 Agent Tool Call；Terminal 状态提交会追加 system 模式记录。真实 Session 的工具组提供 Terminal Mode 和手动上下文压缩；压缩与活动 Run 互斥，完成后直接合并同步 HTTP 响应中的摘要消息，空上下文显示跳过提示。文件仍可在普通文本间插入 `file`/`folder` Token；已有 Session 从其有效本地目录逐级浏览，新 Session 创建前从系统根目录浏览。发送内容仍是包含自闭合标签的普通消息字符串，历史消息只把标签渲染为行内引用，不新增独立 Reference 实体。
- Composer 可从拖拽文件和剪贴板的 `FileList` 或 `ClipboardItem` 读取图片；上传成功后保存完整 Attachment 投影，并仅将已成功上传、尚未移除的图片按选择顺序随新 Run、`follow_up` 或 `steer` 的 `attachmentIds` 提交。纯图片消息可发送，上传或本地预处理尚未完成时不能发送。发送成功后只清除浏览器预览和 Composer 选择状态，不删除后端附件。消息历史与新 Run 的乐观 User Message 会保留后端 Attachment 投影中的受控 `contentUrl`，仅 JPEG、PNG、WebP 通过 API Base URL 以惰加载图片回显；前端不读取或拼接 `storagePath`。完整接口约束见 [Chat 图片附件联调](../frontend/chat-image-attachment-integration.md)。
- Composer 草稿状态与历史时间线隔离：普通输入只重渲染输入区，`ChatTimeline` 与消息行使用稳定回调和 memo 避免重复协调 Markdown、Tool 与审批卡片。Token 编辑器以已同步值避免 React 回写后的二次 DOM 序列化；普通输入不 normalize DOM，粘贴和 Token 结构变更才 normalize。中文输入法组合期间关闭菜单并延后至 composition end 同步，因此不会用中间拼写状态触发 `/`、`@` 或文件检索。
- Markdown 同时把 fenced code 和未标注语言的缩进代码识别为块级代码，避免目录树等预格式化内容被压缩。
- 高频 delta 只保存在进程内 Ring Buffer，最终消息和业务状态写 SQLite。`ChatRunEventHub` 负责每 Run stream 的创建、淘汰和全量关闭；heartbeat 仅在存在订阅者时运行，进程内最多缓存 100 个 Run 的流以限制资源占用。
- Chat Run replay cache 保存未本地化的结构化事件；每个订阅者按自己的 Locale 在发送或重放时投影，因此同一 Run 可同时提供中英文流。Approval、后端 Assistant 错误和 Tool update 的内部消息描述符不会进入公开 payload，浏览器继续读取原有 `description`、`errorMessage` 和 `message` 字符串字段。
- Tool 内部仍使用 `AgentToolResult` 更新；Chat SSE 出口把 `details.update` 投影为白名单化的 `text/progress/status` 协议，旧 Tool 文本自动降级为 `text/replace`，原始 `partialResult` 不发送给浏览器。前端按 `toolCallId` 覆盖保存最新 update：`text` 更新折叠输出，`status` 展示当前阶段，`progress` 根据 `current/total` 渲染带单位的进度条。
- 压缩摘要作为 `message_type=compact` 的普通 `chat_messages` 消息保存，并保留 retained tail、压缩原因、尝试次数、摘要模型和 Usage。加载 Context 时以最新 compact 消息为边界，组合其摘要、retained tail 和边界后的消息；原始消息不删除。前端把摘要投影为可展开的系统时间线节点，并在自动 `compaction.completed` 事件后增量读取最新持久化消息；Compaction SSE parser 保留完整 reason、attempt、模型、Token 和 reduction 字段。`agent_session_entries` 已移除。详细流程见 [context-compaction.md](./context-compaction.md)。

- 失败处理统一见 [chat-failures.md](./chat-failures.md)。终态与 pending Queue/Approval 在同一 SQLite 事务提交；提交成功后发布 run.updated。失败提交按 Session 阻塞新 Run，查询/创建入口只重试提交，不重放 Agent。关闭等待已启动任务，超过 10 秒拒绝关闭，避免继续关闭仍在使用的数据库。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Chat 类型和错误 | `packages/ssh-agent/src/domain/chat.ts` |
| 图片引用类型、校验、读取和 Provider 临时投影 | `packages/ssh-agent/src/domain/chat-attachment.ts`、`packages/ssh-agent/src/application/services/chat-attachment-service.ts` |
| Chat use case、活动 Run 互斥、终态和最终清理 | `packages/ssh-agent/src/application/services/chat-service.ts` |
| Chat 组件装配 | `packages/ssh-agent/src/application/services/create-chat-service.ts` |
| 单 Run 状态和幂等资源释放 | `packages/ssh-agent/src/application/chat-run-runtime.ts` |
| Agent、执行环境和 Tool 装配 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| Approval、Tool Call 和 Queue 生命周期 | `packages/ssh-agent/src/application/services/chat-approval-service.ts`、`packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/services/chat-queue-service.ts` |
| AgentEvent 业务投影与 Context 压缩 | `packages/ssh-agent/src/application/services/chat-agent-event-handler.ts`、`packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 压缩 Setting、领域错误和 SQLite Repository | `packages/ssh-agent/src/domain/context-compaction.ts`、`packages/ssh-agent/src/application/services/context-compaction-settings-service.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-context-compaction-settings-repository.ts` |
| Tool 分类、Guard 预检查、autoAudit 和 Terminal Approval 对接 | `packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts` |
| Terminal Tool 执行和定义 | `packages/ssh-agent/src/application/services/terminal-interaction-service.ts`、`packages/ssh-agent/src/application/tools/terminal-interaction-tool.ts` |
| SFTP 上传和下载 Tool | `packages/ssh-agent/src/application/tools/sftp-upload-tool.ts`、`packages/ssh-agent/src/application/tools/sftp-download-tool.ts` |
| Tool update 标准类型、helper、校验和 SSE 投影 | `packages/ssh-agent/src/application/tool-update-protocol.ts` |
| Chat 持久化端口和 SQLite 实现 | `packages/ssh-agent/src/application/repositories/chat-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts` |
| Run SSE cache、进程内重放和 heartbeat 生命周期 | `packages/ssh-agent/src/application/chat-run-event-hub.ts`、`packages/ssh-agent/src/application/chat-run-event-stream.ts` |
| 后端静态消息本地化和公开投影 | `packages/ssh-agent/src/i18n/` |
| Chat 默认 timeout、cache 和 compaction 上限 | `packages/ssh-agent/src/application/chat-runtime-defaults.ts` |
| HTTP 路由和校验 | `packages/ssh-agent/src/api/http-handler.ts`、`packages/ssh-agent/src/api/request-validation.ts` |
| Session 字段和目录校验 | `packages/ssh-agent/src/domain/session.ts`、`packages/ssh-agent/src/application/services/session-service.ts` |
| SQLite schema | `packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| AgentHarness main lane | `packages/agent/src/harness/agent-harness.ts` |
| 服务装配和关闭 | `packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts` |
| Chat 页面、API 和 Session 设置 | `packages/ssh-agent-web/features/chat/`、`packages/ssh-agent-web/features/session/` |
| Chat SSE Client 与前端状态归约 | `packages/ssh-agent-web/features/chat/runtime/`、`packages/ssh-agent-web/features/chat/model/chat-runtime-state.ts` |
| 手动压缩 API、Composer 工具和摘要时间线 | `packages/ssh-agent-web/features/chat/api/chat-api.ts`、`packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/components/chat-message.tsx` |
| Chat 首次定位、流式跟随和返回底部状态 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/model/chat-scroll.ts` |
| Session 模型偏好恢复与竞态隔离 | `packages/ssh-agent-web/features/chat/runtime/use-chat-model-selection.ts`、`packages/ssh-agent-web/features/chat/model/chat-model-selection-restore.ts` |
| Chat 输入区、Composer Menu、本机文件 Token、工作目录选择器与通用 Switch | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/components/chat-composer-panel.tsx`、`packages/ssh-agent-web/features/chat/components/chat-timeline.tsx`、`packages/ssh-agent-web/features/chat/components/chat-token-editor.tsx`、`packages/ssh-agent-web/features/chat/model/chat-composer-menu.ts`、`packages/ssh-agent-web/features/chat/model/chat-composer.ts`、`packages/ssh-agent-web/features/session/components/new-session-chat.tsx`、`packages/ssh-agent-web/features/session/components/local-directory-picker.tsx`、`packages/ssh-agent-web/components/toggle-switch.tsx` |
| Session 图片附件上传与缩放 | `packages/ssh-agent-web/features/session/api/session-attachment-api.ts`、`packages/ssh-agent-web/features/session/model/image-upload.ts`、`packages/ssh-agent-web/features/chat/components/chat-composer-panel.tsx`、`packages/ssh-agent-web/features/chat/components/chat-token-editor.tsx`；接口约束见 [session-attachment-api.md](../frontend/session-attachment-api.md) |

前端契约见 [chat-stream-integration.md](../frontend/chat-stream-integration.md)，完整设计见 [chat-stream-runtime.md](../design/chat-stream-runtime.md)，后端结构治理顺序见 [ChatService 完整拆分计划](../design/chat-service-refactoring-plan.md)。
