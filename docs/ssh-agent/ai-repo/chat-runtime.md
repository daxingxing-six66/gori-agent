# Chat Runtime 代码路由

只读 Session 通过可信策略禁用上传、安装及部署写入工具，保留读取、Terminal 与下载。远端命令拒绝所有 Full Access 路线，不受 `autoAudit` 放宽。详见 [session-sandbox.md](./session-sandbox.md)。

适用于 Session Chat Run、Pi Agent 事件、工具审批、steer/follow-up、本地工具和自动上下文压缩。


Runtime Factory 将 Run ID 绑定到远端 Tool。Full Access grant 绑定完整请求，只能消费一次，Run 清理会删除未消费授权；审批不能绕过 Guard。原命令失败不会自动升级权限。见 [remote-sandbox.md](./remote-sandbox.md)。

远端命令授权阶段生成不可变 `RemoteCommandExecutionPlan`，保存 Run/Session/Tool Call 身份、原请求快照、选定的权限模式、Full Access 理由和已解析的 SSH 目标。Coordinator 确认审批来源，并仅为开启状态的 Full Access 例外记录一次性 grant 后，通过 `BeforeToolCallResult.executionContext` 交给 Agent；Agent 只在本次调用内部保存它，并作为 `execute()` 的第五个参数传入。顺序和并行批次均按调用隔离；拒绝或取消不会执行计划。它不进入模型参数、transcript、SQLite Chat 消息或生命周期事件。远端 Tool 校验计划与调用一致后直接提交选定模式，Store 只负责派发时验证/消费 grant 和 Run 清理，不再提供 `approvedJustification()` 或参与权限选择。

普通命令模式还提供 `bubblewrap_inspect` 和 `bubblewrap_install`。仅当 Landlock 不可用且 Bubblewrap 缺失时，前者无需审批读取系统与包管理器信息，后者经人工审批执行服务端生成的准确安装命令；`autoAudit` 不能自动批准安装。命令的 Full Access grant 只用于本次安装，成功后自动探测，后续受限命令无需安装审批。Terminal Mode 不开放该安装流程；部署模式不额外禁用命令模式的既有安装能力。

## 当前边界

- 普通请求与所有 SSE 使用独立 origin；Chat 事件适配器通过 `shared/events/client.ts` 生成地址，模型/历史/队列等请求仍走 API 客户端。传输只负责通道隔离，不参与 Run 状态、工具、队列或重放规则，见 [transport-channels.md](./transport-channels.md)。

- 左侧会话行右侧运行标识由独立 Session Activity 投影观察已持久化的 Run、审批和用户决策事实。ChatRunEventHub 按类型提供进程内观察出口；投影不处理 token delta，不控制 Run 或队列。初次插入后发布 pending 事实，终态提交成功后结束旋转并保留该会话本次结果，停止并续接队列时保持运行；未参与本次运行的历史会话不批量标记。结构、全局 SSE 和生命周期见 [session-activity.md](./session-activity.md)。

- `@` 非空文件检索使用独立 Hook 与后端有界候选索引，不逐目录发 HTTP，也不创建 Chat Run。取消、缓存、全局排序及不完整提示见 [local-file-search.md](./local-file-search.md)。

- 成功的 `read` / `write` 工具行可在悬浮或键盘聚焦时点击 Eye 图标与“查看”，经展示回调在右侧打开独立阅读器，读取当前磁盘文件而非截断的工具输出。阅读器自有标签与读取状态，不创建 Chat Run、消息或审批，不依赖 Terminal/Deploy 生命周期；完整入口与边界见 [file-reader.md](./file-reader.md)。

- `ask_user_decision` 在普通模式与 Terminal Mode 共用同一工具定义和独立的 `ChatUserDecisionService`。服务持有无超时等待，SQLite 保存题目、回答及终态；Run 取消和服务关闭中止等待。回答只表达用户选择，不授予命令权限，Guard 和原有审批规则继续生效。前端通过 Run SSE 和待决 REST 接口恢复；完整代码入口见 [user-decision.md](./user-decision.md)。

- `/deploy` 在无活动部署时展开 Agent 输入框上方的模块选择，选定服务后创建稳定部署身份、Session 模式与正式历史消息并展示右侧任务页；已有活动部署直接定位任务；配置补充仍使用独立 `deployment_setup` Skill，保存不自动发布。后续普通消息由后端活动模式绑定讨论、待审、执行或诊断。部署跨 Chat Run 保留，模型用专用工具推进及明确结束；成功须核验必要阶段。模式/结算由 DeploymentModeService 持有，阶段/执行/日志由 DeploymentService 与 ExecutionRecorder 保存，模型文字、用户问题和命令权限审批留在中间会话，计划确认及修订移至右侧 Deploy 页。阶段失败由当前模型直接读取工具结果并诊断，前端通过 Deploy 自有审阅模型和到期 Hook 统一计算实际待决需求，展示组件只读共享快照；不再提供“让模型分析修复”的二次选择或额外启动恢复 Run；计划修订及命令权限审批继续保留。完整链路见 [deployment.md](./deployment.md)。

- 文件工具批次仅允许 read/SFTP 上传/SFTP 下载在无路径冲突时并行；包含其他串行工具或路径读写/写写冲突则整批按模型顺序执行。详见 [文件工具并发](./file-tool-concurrency.md)。

- 新会话首个 Run 可通过 `generateTitle: true` 启用同模型异步命名；标题任务独立于聊天，不进入消息历史，通过 Workspace SSE 推送。见 [session-title.md](./session-title.md)。

- 每次模型流请求经过包内 Provider 错误边界，附件水合与模型同步异常分别处理。安全原因使用描述符贯穿消息、Run failure、HTTP/SSE；原始文本供超限判断与日志使用，未知内部错误不公开。见 [provider-failures.md](./provider-failures.md)。
- 主聊天在每次模型请求中设置 `maxRetries=3`，复用 pi-ai Adapter 的 HTTP 指数退避机制处理 429、5xx 和网络异常；初次请求外最多重试三次，没有厂商等待响应头时以 2、4、8 秒为等待基准，沿用 Adapter 的随机抖动、状态码与响应头策略。Run 取消信号贯穿请求和退避等待。此配置覆盖首次、Tool 后续和队列消息请求，不重放工具或已开始输出的流；上下文压缩摘要与异步标题保持原有配置。实现边界及确定性 HTTP 回归见 [provider-failures.md](./provider-failures.md) 与 `packages/ssh-agent/test/chat-provider-retry.test.ts`。

- 上下文占用在每次 `turn_end` 和自动压缩保存摘要后推送 `context.updated`；刷新通过独立查询恢复，手动压缩返回 `contextUsage`。头部组装纯函数位于 `application/chat-context.ts`，工具共享静态定义；有效消息按 compact 边界加载，不能把 Agent 完整 transcript 当作压缩后 Context。见 [context-usage.md](./context-usage.md)。

- Session 保存 `workDir`、`autoAudit`、默认开启的 `sandboxEnabled`、默认关闭的 `sandboxReadOnly` 与独立 `sandboxWritableRoots`；创建时未指定 `workDir` 则从 Workspace `defaultCwd` 继承并验证本地目录，创建后独立保存。已有 Session 的 null 值仍使用服务默认目录。
- 已有 Session 页首通过可选展示插槽接入独立 `SessionServerMetrics`，按 Workspace 共享服务器 CPU/内存/网络快照；它使用 monitoring SSE，与 Chat Run、审批、消息和 Agent Context 无关。桌面保留紧凑页首，窄屏允许指标换行。详见 [session-server-metrics.md](./session-server-metrics.md)。
- Chat 页首由 `ChatPageHeader` 组合会话标题、必要运行状态及 `SessionSandboxBadge`，桌面使用 44px 单行页首，不显示工作区/本地目录副标题和空闲“就绪”标签；活动运行、排队、重连、失败及取消状态继续展示。组件只读取总装配传入的状态，不持有请求或审批逻辑。沙盒标识显示已确认的 Session 设置，只有图标和开启/只读/关闭短文案；标识只读，无配置按钮或点击动作；Session 目录配置统一由侧边栏铅笔编辑入口提供，保存后刷新当前 Terminal；切换进度与异常继续由独立状态提示展示。见 [session-sandbox.md](./session-sandbox.md)。
- Session 详情从最近一次 `chat_runs` 记录投影 `chatModelSelection`；首次 Run 显式选模型，后续 Run 可继承，模型与 thinking level 变化按当前 `pi-ai` 目录重新校验。
- 模型选择从 SSH Agent 的有效目录读取。上游明确返回所选模型不再受支持时，Run 以 `chat_model_not_supported` 失败，最终 assistant 消息携带统一安全失败报告，在公开投影中显示用户友好提示，同时该模型立即从有效目录和持久化快照删除；不会触发一次无意义的即时刷新。
- `ChatService` 保留 Chat use case、活动 Run 与初始化互斥、创建顺序和资源归属，`chat-run-executor.ts` 负责执行与清理。`ChatPromptService` 在首次 Run 组装并持久化不可变头部；后续 Run 复用基础头部，通过独立上下文服务追加当前沙盒、Terminal、诊断、部署及工作流状态。模式切换以真实 system 消息追加到历史，头部只解释标签及首次环境；全部 18 个内置 Tool schema 按名称排序并保持稳定，由运行时门禁限制可用入口。完整边界见 [session-prompt.md](./session-prompt.md)。
- Chat 与上下文压缩请求只在模型 `provider` 精确为 `opencode-go` 时附加稳定的 `x-opencode-session=<Session ID>` 和 `x-opencode-client=pi`，满足 OpenCode Go 的会话路由要求；其他 Provider 不增加这两个 Header。
- Approval、Tool Call 协调、Queue、AgentEvent 投影、Context 压缩和 Run SSE 分别由 `ChatApprovalService`、`ChatToolCallCoordinator`、`ChatQueueService`、`ChatAgentEventHandler`、`ChatContextService` 和 `ChatRunEventHub` 持有。`ChatContextService` 在每次 Provider 请求前估算完整 payload，必要时用 PI compaction 生成摘要；Provider 尚未输出有效内容就返回上下文超限时，同一扩展点强制压缩并只重试一次。`ChatToolAuthorizationPolicy.prepare()` 只分发 Tool 自有的审批准备函数，并统一转换可修正请求错误；它不执行工具，也不再集中检查模式或部署冲突。远端命令、Terminal、Bubblewrap 安装和部署阶段各自生成审批方案（含 Guard 预检、沙箱路由和场景描述）。策略类共享读取 `autoAudit`、管理逐次 Full Access grant；Terminal 工具通过方案内的 `onDecision` 回写 Interaction 状态。持久化继续通过 `ChatRepository` 端口隔离。
- Chat Run 从创建持久化前到执行 finally 持有 Session lifecycle lease；删除屏障建立时拒绝新 Run。Run 冻结 `serverInteractionMode`，Terminal Mode 绑定当前 TerminalSession；模式变化不会重写头部，Provider 请求前复核最新持久化模式，失效时停止当前 Run。
- `read` 无审批；普通 Chat Run 的 `write`/`bash`/默认 `remote_server_call`/Terminal submit 受 `autoAudit` 控制。Session 开启沙盒且有效后端存在、已声明写入路径在范围内时，开启自动审批直接在沙箱内执行，关闭时逐条请求人工批准后仍在沙箱内执行。明确无后端或已知路径越界时，远端命令使用 `remote_sandbox_exception` 名称请求一次性人工 Full Access 授权。Session 开启时，显式 `full_access` 远端调用无论 `autoAudit` 设置如何都强制人工审批，非空理由进入描述，批准来源必须为 user；只传理由却未设置 `sandbox_permissions: "full_access"`，审批前返回可修正的 Tool 错误。远端命令和 Terminal submit 无论是否自动审批，都先执行 Guard 预检查并在派发前复检。部署规划、执行和修复 Run 的普通本地 `write`/`bash`、远端命令与 Terminal submit 同样服从 `autoAudit`；远端操作按当前 Session 策略执行，关闭时跳过沙箱路由与准备但保留普通审批，本地 `bash` 不受远端沙箱约束。SFTP Tool、Terminal 控制键和 observe 按原交互模式与审批规则可用，诊断结果不推进部署阶段。部署受限的 RESTART/VERIFY 阶段也服从 `autoAudit`，Full Access 例外保留专用逐命令人工审批。普通 Run 的 `sftp_upload` 和 `sftp_download` 分别在远端、本地检查同名文件，仅覆盖时在 Tool 执行中读取当前 Session 的 `autoAudit`：开启则自动批准并记录 `source="auto"`，关闭则等待人工审批。并发同名冲突使用同一策略，非普通文件仍拒绝覆盖。所有 Approval 都携带后端生成并持久化的场景描述，SFTP 描述明确指出本地或远程文件覆盖。
- Run 内 steer/follow-up 使用 Pi Agent 队列；HTTP 请求 ID 和数据库唯一约束负责幂等。用户拒绝或审批超时会在完整 Tool Result 后停止当前 Turn 的自动延续，只取消 steer，follow-up 仍开启新的 Turn。
- 用户点击停止输出经 `ChatService.stopRun()` 处理：存在 pending steer/follow-up 时只中断当前 Agent Loop，等待请求、工具及持久化监听器收尾，再从数据库重读剩余队列，重建内存队列，每次仅将队首一条原始消息加入同一 Chat Run 的下一轮，其余消息保留原 steer/follow-up 行为并继续排队，按既有逐条规则消费。通过 Agent 的单条队列续接入口启动，避免与下一条 steer 合并进入同一个初始请求。沿用模型、附件引用和 Run SSE，使用新的 AbortSignal；消息仍由正式 `message_end` 落库后标记 consumed，不预先写入历史、不重放工具。中断期间取消的队列项不再加入；队列已空则结束为 cancelled，真实运行/持久化失败仍终止为 failed。内部 `cancelRun()`、`cancelRunAndWait()` 及服务关闭保持强制取消，覆盖尚未开始的队列续接。回归见 `chat-stop-queue-api.test.ts`、`chat-run-interruption.test.ts` 和 `chat-user-decision-api.test.ts`。
- 队列为空时点击停止会取消整个 Run。Adapter 把中止返回为 error 事件时统一按 aborted 处理，不保存伪造的厂商失败；明确被中止的压缩摘要也不会变成 Run failure。前端将 `stopReason: "aborted"` 作为取消结束，不因附带的 `errorMessage` 显示红色错误框；已输出的正文、Thinking 和工具事实继续保留，实时消息和刷新后的历史共用该规则。只有 Run 真正进入终态才清除待处理控件，继续队列时保持活动状态；取消与失败展示回归见 `packages/ssh-agent-web/tests/chat-failure-details.test.tsx`，停止后的状态恢复见 `chat-runtime-cancel.test.ts`。
- 可修正的 Tool 错误以 `isError: true`、`terminate: false` 返回上下文，让模型在下一次请求中读取错误并调整调用。模式不匹配、当前工作流内 Tool 不可用、Full Access 缺少理由、相对或非法 `write_paths`、Terminal 动作与字段矛盾、输入无效/超限以及普通远端命令执行失败都遵循此规则；拒绝执行本次调用不等于结束 Run。Terminal submit 只接受 input，key 只接受 CTRL_C，observe 不接受 input/key；矛盾参数在审批预检和实际派发前拒绝，结果包含字段纠正与重新生成提示，不静默改写动作。自动与人工审批下的重新生成链路由 `chat-agent-runtime-factory.test.ts` 使用 faux 模型验证。Guard 硬阻断仍返回 `terminate: true`，用户拒绝审批、审批超时和主动取消保留各自的停止语义。
- 普通工具按冻结 Run 的交互模式装配，模式不兼容保留 `unavailableTool`，参数准备及直接执行入口复检。部署工具定义始终保留，仅在后端绑定模式内连接可执行实现，结束后通过不可用入口拒绝；阶段语义预检在 Schema 之后、审批之前执行，直接服务入口再次校验。已知部署 4xx 返回非终止错误供模型纠正；探针、持久化和未知异常保留原失败分类。Provider 请求前提交变化后的完整状态到聊天历史，再追加给模型；不在工具结果组中间插入状态。
- 部署状态包含后端绑定的选择来源、Profile 和模块身份。固定头部不附加动态指引，完整工具结果组之后以独立 `role:system` 追加状态并持久化，不把状态混进工具正文，不改用户或诊断输出角色；跨 Run 与压缩后继续读取持久化 Discussion。前端选择后自动发送的 user 意图通过双语模板补入 `discussion.module.name`，不再只说“所选服务”。详见 [deployment.md](./deployment.md)。
- 创建 Run、steer 和 follow-up 都可携带最多四个 Session 图片 Attachment ID；文本可为空但文本与附件不能同时为空。所选模型必须声明支持 `image` 输入，且切换到纯文本模型时当前有效历史不能仍含图片引用。消息和 Queue 只保存有序 ID；每次 Provider 请求前才安全读取 JPEG、PNG 或 WebP，并临时转换为 `ImageContent`，Base64 不进入 Agent Context、SQLite、SSE 或消息 API。详细边界见 [chat-image-input.md](./chat-image-input.md)。
- Run 内互斥生命周期由 `ChatRunRuntime` 的语义方法管理；其 `dispose()` 幂等中止 Agent 并清理 Node execution environment。Approval 等待完成时会同时清理 timeout、AbortSignal listener 和进程内 pending 索引。
- 前端切回 Session 或刷新时通过消息、待审批、待决策、活动 Run 和 Queue 的只读接口恢复状态，再订阅 Run SSE。仅加载更早消息或合并压缩结果不会清除已恢复的待审批与待决策记录；审批/决策列表成功返回时才以该快照替换待决记录。服务重启后活动 Run 为 `null`。
- Chat 前端通过独立的类型化 SSE 运行时归约消息、Tool、审批、Queue 和压缩状态；`message_end` 直接完成实时消息；仅完整用户附件消息缺少回显元数据时，由独立 `use-chat-attachment-history.ts` 有界补读原历史接口并只合并消息，不覆盖 Run/审批/Queue 状态，也不针对 token delta 查询。待审批工具使用带细警示边线的行内确认区，完整请求参数可滚动阅读，后端 `ToolApproval.description` 原文始终可见，不根据 Tool 名称推断风险；“拒绝本次 / 批准执行”按钮在处理时保留原位并禁用，SFTP 覆盖使用“批准覆盖”。普通 Tool Call 使用紧凑的原生 `details` 行，按状态显示“已运行”“正在读取”等动作与截断目标；连续纯工具消息缩小间距。展开后保留完整参数、输出、耗时与复制按钮，失败时在收起态显示最后一行错误线索。工具行以 Assistant Tool Call 的完整参数作为展示输入；其中 `terminal_interaction` 优先展示实际 `input`，无输入时展示 `Ctrl+C` 或原始 action，不显示 `expectation` 等运行协议字段，其余未知工具仍使用通用参数摘要作为降级。
- 普通发送先添加临时气泡，收到 createRun 响应直接绑定 Run 并订阅原 SSE；后端业务入口已创建的 Run 才经 attachRun 补读历史。同步读取先取活动 Run 再读消息，防止结束状态先到、最终消息未读却已关闭订阅。requestId 将临时气泡绑定到实际 runId，REST 和 SSE 任一先到均可合并；更早轮次同文用户消息继续保留。同步 ref 防止 React 下一次 render 前重复发请求，跨 Session 的迟到响应不写回当前状态。回归见 chat-runtime-state.test.ts 与 chat-runtime-cancel.test.ts。
- `attachRun` 合并统一历史接口最近 100 个序号组，恢复任务卡片、首条意图及之前仍仅在本地实时显示的消息；不以独立卡片事件推进后的 maxSequence 作为唯一补读起点，也不重置用户已加载的向前分页游标。同步在消息读取成功后先提交时间线，再独立恢复审批、决策和队列；这些控制查询较慢或失败不阻止消息回显。已落库条目始终按 sequence/historyOrder 排列，实时条目保留接收顺序，并按消息时间插入其首次出现时已观察到的序号锚点之后；更新不改变原锚点，不将序号与毫秒时间戳相减。补齐落库身份后转用服务端顺序，原去重、修订和旧卡片锚点规则保留。
- pending Queue 在输入区展示为“引导/跟进”任务，可单独取消；普通发送始终加入 follow_up，行尾回车图标通过 `POST .../queue/{id}/steer` 转换同一 pending 项。后端同步更新数据库行为并重建 follow-up 内存队列、注入 steer，保留 ID、消息和附件，重复转换不重复注入；Run 不接受引导或消息不再 pending 时拒绝。前端归约避免延迟响应将终态恢复为 pending 或将 steer 降回 follow_up。入队时不会把乐观 User Message 提前写入聊天时间线，只有后端 Loop 消费后发出的正式消息事件才进入记录。Run 进入终态时会清除遗留的 pending Queue 和 Approval 操作。
- `sftp_download` 与 `sftp_upload` 展开详情共用路径排版与进度投影：下载显示“远程文件 / 本地路径”，未得到 `localPath` 时以“本地目录”显示请求的 `targetPath`；上传显示“本地文件 / 远程路径”，优先使用已有结果的规范化 `sourceFilePath/remotePath`，未得到目标文件路径时显示“远程目录”。不猜测绝对路径，完整路径保留原值与换行能力，复制仍使用原始请求参数。正常传输移除底部重复结果文字，失败、结果不确定说明及覆盖审批保持可见。前端从已有 Tool Result 的可选 `details` 保存展示事实，REST 历史和 SSE 结果共用；完成/失败/取消/不确定详情中有效的 `bytesTransferred/totalBytes` 可恢复进度、百分比及字节计数（空文件为 100%），完成事实优先于旧实时进度，进度不改变失败状态。缺少详情时保留原实时 update，不解析本地化结果文字或查询文件大小，不改变消息协议及传输执行。
- 消息 HTTP 接口以 Session 内单调递增的 `sequence` 提供双向游标分页：无游标返回最新一页，`beforeSequence` 向更早历史加载，`afterSequence` 向最新处补齐；三种模式都按升序返回，两个游标不能同时使用。前端首次只加载最新页，用户滚动接近顶部时请求更早历史，并按新增内容高度恢复原视口位置。部署入口是带稳定 ID、标题和 sequence 的 custom 消息；后端 `SqliteChatHistoryQuery` 在同一历史查询中组合正式消息、旧部署 Run 和孤立活动讨论，状态摘要只包含身份、标题和时间，不输出计划或日志；SSE 与 REST 按实际消息身份去重。新部署在结束事务中将同一条正式消息移到结束 sequence，通过独立部署 SSE 更新；旧已结束正式入口及无正式入口的数据在后端按结束时间挂接 sequence 锚点，以 historyOrder=1 随同一分页返回；原始记录和模型 transcript 不改写。limit 限制锚点分组，附属旧卡片不拆页，因此实际条目数可超过 limit；无聊天的旧入口使用锚点 0。合并和整页恢复都保留同一持久化消息的较高 sequence，避免迟到开始事件或旧页将结束卡片移回。Deploy 卡片由独立功能组件渲染，不进入通用工具/传输详情。部署展示投影在精确匹配已完成的 deployment_finish 结果与结束卡片后，将卡片替换到该工具位置并去掉重复入口；只影响 UI，不修改 Chat 消息或工具状态，取消和工具错误不替换。前端不再拉取部署历史分页合并到消息列表，conversationHistory 仅识别已有条目，首屏加载中不提前显示 SSE 卡片。规划、执行、诊断和最终文字全部保留在主时间线；阶段与日志展示在右侧 Deploy Tab。custom 内容可以为字符串，不能进入 Assistant 数组渲染；该 UI 元数据在模型输入和压缩中过滤。UI 将 Thinking、Markdown 正文与 Tool 执行卡片分别渲染。用户消息气泡下方提供复制图标，复制发送给模型的原始文本（包括文件与目录引用标签），成功后仅在图标上给出短暂完成反馈。
- 进入已有 Session 时 Chat 消息区自动定位到最新消息；用户上滚超过底部阈值后停止跟随流式内容并显示“回到最新消息”按钮，返回底部后恢复自动跟随。
- Chat 输入区可直接更新 Session 的 `autoAudit`，但活动 Run 期间禁用修改；模型选择器与发送或停止操作位于同一操作区。新 Session 输入区可在首次发送前通过系统目录选择器设置本地 `workDir`，创建请求会携带该绝对路径；Session 编辑弹窗复用同一选择器，两处都不接受手填路径。
- Session 模型偏好恢复会重新解析当前 Provider 与模型目录；恢复请求使用递增令牌隔离 Session，Abort 不会标记恢复完成，过期请求不能覆盖新 Session。历史模型已失效时结束加载并要求重新选择，目录请求失败时允许显式重试。
- Chat 输入区使用统一 Composer Menu：消息开头的 `/` 只唤起即时前端工具，合法位置的 `@` 同时提供工具与本机文件；没有匹配工具时隐藏工具分组，工具与文件均无匹配时只显示统一空状态。选择工具本身不会创建用户 Chat 消息或 Agent Tool Call；Terminal 状态提交会追加 system 模式记录，`/deploy` 在无活动部署时打开输入框上方的模块选择，明确选择后才打开 Deploy Tab；有活动部署直接定位右侧任务。真实 Session 的工具组提供 `/deploy`、Terminal Mode、沙盒开关和手动上下文压缩；沙盒入口直接切换当前 Session，状态用呼吸灯表示，已有 Terminal 自动重开；只读模式仅在编辑会话中设置，详见 [session-sandbox.md](./session-sandbox.md)。压缩与活动 Run 互斥，完成后直接合并同步 HTTP 响应中的摘要消息，空上下文显示跳过提示。文件仍可在普通文本间插入 `file`/`folder` Token；已有 Session 从其有效本地目录逐级浏览，新 Session 创建前从系统根目录浏览。发送内容仍是包含自闭合标签的普通消息字符串，历史消息只把标签渲染为行内引用，不新增独立 Reference 实体。
- Composer 的回形针按钮、拖放和剪贴板文件共用 `use-chat-attachment-uploads.ts`，支持图片及 UTF-8 文本类文档。文件准备、上传状态、附件呈现拆分为独立模块；每条消息最多四个，上传/准备中不能发送。文档粘贴不将伴随剪贴板正文写进草稿，普通文本粘贴保留；图片在浏览器等比缩放，其他可解码格式转换 PNG。只将成功且未移除的附件 ID 按选择顺序随 Run、follow_up 或 steer 提交。成功后只清理该提交批次的本地状态，不删除后端附件；Session 切换取消上传并释放对象 URL。历史和乐观用户消息复用独立附件展示组件：图片保留缩略图/弹窗，文档卡在发送前后均可打开右侧 Reader，按 Session/ID 获取文本，不使用 storagePath。文档在 Provider 消息末尾只增加本地路径与 read 提示，正文等模型调用工具才读取；纯文档允许纯文本模型。完整接口约束见 [Chat 附件联调](../frontend/chat-image-attachment-integration.md)。
- Composer 文本草稿由独立 `ChatComposerDraftStore` 按 Session ID 保存在当前页面内存中，`useChatComposerDraft` 只订阅当前 Session；切换会话或卸载后重新进入会恢复原文与 `file`/`folder` 引用，不使用浏览器存储或后端持久化，刷新后重置。提交时清空本批文本，失败仅在原 Session 草稿未被后续编辑时恢复，迟到结果不能覆盖其他会话或较新的草稿；附件继续沿原上传生命周期处理，切换会话仍取消上传并清理本地附件状态。
- 独立 `useChatComposerHistory` 为已有 Session 提供最近七条有内容的 user 文本，保留文件/目录引用，跳过纯图片和空白文本；同文的不同消息仍占独立历史项。首先复用当前时间线，主历史加载完成后不足七条时，沿既有历史接口的 before 游标向前补足或读至历史结束；只保留补读中的用户候选，以 sequence 排序，并按持久化消息 ID 与实时记录去重，实时记录优先。补读不改 Chat Runtime 的分页状态、消息列表或视口，不按 token delta 反复查询；失败保留已有候选且不阻止发送，切换 Session 或卸载停止后续分页并丢弃迟到结果，不中断已发出的 HTTP 请求。
- 空输入下单次无修饰键的 `↑` 进入历史导航，并冻结这一轮导航使用的文本列表，避免新消息或稍后补读改变当前位置；继续 `↑` 回看更早记录，`↓` 返回较新记录，越过最新一条时恢复进入导航前的空白草稿，最早一条不再向前。导航不发送消息或恢复图片/文档附件，位置与进入前草稿按 Session 保存在页面内存，切回会话可继续导航；编辑或提交后退出导航，提交失败只恢复文本，不恢复原导航位置。已有普通输入、无有效历史、禁用状态、长按重复、输入法组合及修饰键不触发导航，`/`/`@` 候选菜单的方向键优先；回填多行历史后仍可用方向键切换，手动编辑后恢复正常光标移动。外部回填时仍聚焦编辑器则将光标移到末尾，不抢占其他控件焦点。
- Composer 草稿状态与历史时间线隔离：普通输入只重渲染输入区，`ChatTimeline` 与消息行使用稳定回调和 memo 避免重复协调 Markdown、Tool 与审批卡片。`aboveInputPanel` 通过独立 keyed Fragment 隔离调用者提供的组件 key，避免使用 Session key 的模块选择器与同级 Token 编辑器发生身份冲突、卸载后遗留 DOM；不增加布局节点或引入业务依赖，回归见 `chat-composer-draft.test.tsx`。Token 编辑器以已同步值避免 React 回写后的二次 DOM 序列化；普通输入不 normalize DOM，粘贴和 Token 结构变更才 normalize。中文输入法组合期间关闭菜单并延后至 composition end 同步，因此不会用中间拼写状态触发 `/`、`@` 或文件检索。
- Markdown 同时把 fenced code 和未标注语言的缩进代码识别为块级代码，避免目录树等预格式化内容被压缩。
- 高频 delta 只保存在进程内 Ring Buffer，最终消息和业务状态写 SQLite。`ChatRunEventHub` 负责每 Run stream 的创建、淘汰和全量关闭；heartbeat 仅在存在订阅者时运行，进程内最多缓存 100 个 Run 的流以限制资源占用。
- Chat Run replay cache 保存未本地化的结构化事件；每个订阅者按自己的 Locale 在发送或重放时投影，因此同一 Run 可同时提供中英文流。Approval、后端 Assistant 错误和 Tool update 的内部消息描述符不会进入公开 payload，浏览器继续读取原有 `description`、`errorMessage` 和 `message` 字符串字段。
- Tool 内部仍使用 `AgentToolResult` 更新；Chat SSE 出口把 `details.update` 投影为白名单化的 `text/progress/status` 协议，旧 Tool 文本自动降级为 `text/replace`，原始 `partialResult` 不发送给浏览器。前端按 `toolCallId` 覆盖保存最新 update：`text` 更新折叠输出，`status` 展示当前阶段，`progress` 根据 `current/total` 渲染带单位的进度条。
- 压缩摘要作为 `message_type=compact` 的普通 `chat_messages` 消息保存，并保留 retained tail、压缩原因、尝试次数、摘要模型和 Usage。加载 Context 时以最新 compact 消息为边界，组合其摘要、retained tail 和边界后的消息；原始消息不删除。前端把摘要投影为可展开的系统时间线节点，并在自动 `compaction.completed` 事件后增量读取最新持久化消息；Compaction SSE parser 保留完整 reason、attempt、模型、Token 和 reduction 字段。`agent_session_entries` 已移除。详细流程见 [context-compaction.md](./context-compaction.md)。

- 失败处理统一见 [chat-failures.md](./chat-failures.md)。终态与 pending Queue/Approval 在同一 SQLite 事务提交；提交成功后发布 run.updated。失败提交按 Session 阻塞新 Run，查询/创建入口只重试提交，不重放 Agent。关闭等待已启动任务，超过 10 秒拒绝关闭，避免继续关闭仍在使用的数据库。

命令详情由 `chat-tool-details.tsx` 的工具类型注册表选择独立渲染器：`chat-remote-command-details.tsx` 负责 SSH 请求及已有退出码/退出信号，`chat-terminal-interaction-details.tsx` 负责 submit/key/observe，并通过动作注册表选择输入或快捷键展示；卡片不显示操作（action）和观察预期（expectation）参数行，仅在展示层过滤，原请求、复制及 SSE 数据保持不变；观察结束不推断远端进程完成。两者复用 `chat-command-details.tsx` 与局部 CSS 的请求、参数和输出排版，参数标签/值格式化在 `chat-command-parameters.ts`，未知参数保留原值。只有已有字段才显示工作目录、超时、请求权限和截断标记，不补默认值或查询新数据。命令结果从已有 SSE Tool Result 的 `content` 或历史文本块读取，输出原文、空白及滚动能力保留；状态归约、复制及待审批分支沿用原链路。上传/下载独立入口与既有路径/进度投影移到 `chat-transfer-details.tsx`，默认工具使用通用渲染器。渲染器不订阅 SSE；Chat、Terminal、Workspace/Deploy 继续使用各自已有的解析和分发入口。回归见 `tests/chat-command-details.test.tsx` 和 `tests/chat-ui-hierarchy.test.tsx`。

## 代码位置

提问工具 `ask_user_decision` 通过同一详情注册表使用独立 `chat-user-decision-details.tsx`：按题展示问题与选择/自由输入/跳过答案，复用现有 Markdown 和主题语义色，不直接显示正常回答 JSON。实时结果 content 和历史文本块共用解析，只有题数与问题文本匹配才配对；错误与未知结果保留诊断。该组件只做展示，不订阅事件、不修改待决面板或消息数据；回归见 `tests/chat-user-decision-details.test.tsx`，完整边界见 [user-decision.md](./user-decision.md)。

| 关注点 | 代码位置 |
|---|---|
| Chat 类型和错误 | `packages/ssh-agent/src/domain/chat.ts` |
| 图片/文本引用类型、校验、read 提示与 Provider 临时投影 | `packages/ssh-agent/src/domain/chat-attachment.ts`、`packages/ssh-agent/src/application/services/chat-attachment-service.ts` |
| Chat use case、活动 Run 互斥、终态和最终清理 | `packages/ssh-agent/src/application/services/chat-service.ts` |
| Chat 组件装配 | `packages/ssh-agent/src/application/services/create-chat-service.ts` |
| 单 Run 状态和幂等资源释放 | `packages/ssh-agent/src/application/chat-run-runtime.ts` |
| Agent、执行环境和 Tool 装配 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| 部署讨论提案与执行阶段工具 | `packages/ssh-agent/src/application/tools/deployment-agent-tool.ts` |
| Approval、Tool Call 和 Queue 生命周期 | `packages/ssh-agent/src/application/services/chat-approval-service.ts`、`packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/services/chat-queue-service.ts` |
| AgentEvent 业务投影与 Context 压缩 | `packages/ssh-agent/src/application/services/chat-agent-event-handler.ts`、`packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 压缩 Setting、领域错误和 SQLite Repository | `packages/ssh-agent/src/domain/context-compaction.ts`、`packages/ssh-agent/src/application/services/context-compaction-settings-service.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-context-compaction-settings-repository.ts` |
| 审批分发、共享 autoAudit 与一次性 grant | `packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts` |
| 工具自有审批准备、可用性入口和可修正错误契约 | `packages/ssh-agent/src/application/tools/remote-server-call-tool.ts`、`terminal-interaction-tool.ts`、`bubblewrap-installation-tool.ts`、`deployment-agent-tool.ts`、`tool-authorization.ts` |
| 授权到执行的命令计划及内部上下文传递 | `packages/ssh-agent/src/application/tools/remote-command-execution-plan.ts`、`packages/agent/src/types.ts`、`packages/agent/src/agent-loop.ts`；测试见 `packages/agent/test/tool-execution-context.test.ts`、`packages/ssh-agent/test/remote-command-execution-plan.test.ts` |
| Terminal Tool 执行和定义 | `packages/ssh-agent/src/application/services/terminal-interaction-service.ts`、`packages/ssh-agent/src/application/tools/terminal-interaction-tool.ts` |
| SFTP 上传和下载 Tool | `packages/ssh-agent/src/application/tools/sftp-upload-tool.ts`、`packages/ssh-agent/src/application/tools/sftp-download-tool.ts` |
| Tool update 标准类型、helper、校验和 SSE 投影 | `packages/ssh-agent/src/application/tool-update-protocol.ts` |
| 统一 UI 历史读取（不用于模型/压缩） | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-history-query.ts`，由 ChatRepository 的 listHistoryPage 端口承接；测试 `chat-message-pagination-api.test.ts` |
| Chat 持久化端口和 SQLite 实现 | `packages/ssh-agent/src/application/repositories/chat-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts` |
| Run SSE cache、进程内重放和 heartbeat 生命周期 | `packages/ssh-agent/src/application/chat-run-event-hub.ts`、`packages/ssh-agent/src/application/chat-run-event-stream.ts` |
| 后端静态消息本地化和公开投影 | `packages/ssh-agent/src/i18n/` |
| Chat 默认 timeout、HTTP 重试次数、cache 和 compaction 上限 | `packages/ssh-agent/src/application/chat-runtime-defaults.ts` |
| HTTP 路由和校验 | `packages/ssh-agent/src/api/http-handler.ts`、`packages/ssh-agent/src/api/request-validation.ts` |
| Session 字段和目录校验 | `packages/ssh-agent/src/domain/session.ts`、`packages/ssh-agent/src/application/services/session-service.ts` |
| SQLite schema | `packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| AgentHarness main lane | `packages/agent/src/harness/agent-harness.ts` |
| 服务装配和关闭 | `packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts` |
| Chat 页面、API 和 Session 设置 | `packages/ssh-agent-web/features/chat/`、`packages/ssh-agent-web/features/session/` |
| Chat SSE Client 与前端状态归约 | `packages/ssh-agent-web/features/chat/runtime/`、`packages/ssh-agent-web/features/chat/model/chat-runtime-state.ts` |
| 聊天任务记录识别与完成工具展示替换 | `packages/ssh-agent-web/features/chat/model/conversation-history.ts`、`task-completion-history.ts`；Deploy/Diagnose 自有适配器负责结果与状态匹配，共用内容拆分、唯一入口与失败保留，持久化和模型消息不改写 |
| 手动压缩 API、Composer 工具和摘要时间线 | `packages/ssh-agent-web/features/chat/api/chat-api.ts`、`packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/components/chat-message.tsx` |
| Chat 首次定位、流式跟随和返回底部状态 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/model/chat-scroll.ts` |
| Session 模型偏好恢复与竞态隔离 | `packages/ssh-agent-web/features/chat/runtime/use-chat-model-selection.ts`、`packages/ssh-agent-web/features/chat/model/chat-model-selection-restore.ts` |
| 最近七条用户消息提取与按需历史补读 | `packages/ssh-agent-web/features/chat/model/chat-composer-history.ts`、`runtime/use-chat-composer-history.ts`；回归见 `packages/ssh-agent-web/tests/chat-composer-history.test.ts`、`chat-composer-history-runtime.test.ts` |
| Session 文本草稿、提交失败恢复与用户消息导航 | `packages/ssh-agent-web/features/chat/runtime/chat-composer-draft-store.ts`、`runtime/use-chat-composer-draft.ts` 保存文本与导航，`components/chat-composer-panel.tsx`、`components/chat-token-editor.tsx` 装配交互；回归见 `packages/ssh-agent-web/tests/chat-composer-draft.test.tsx`、`chat-token-editor-keyboard.test.tsx` |
| Chat 输入区、Composer Menu、本机文件 Token、工作目录选择器与通用 Switch | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/components/chat-composer-panel.tsx`、`packages/ssh-agent-web/features/chat/components/chat-timeline.tsx`、`packages/ssh-agent-web/features/chat/components/chat-token-editor.tsx`、`packages/ssh-agent-web/features/chat/model/chat-composer-menu.ts`、`packages/ssh-agent-web/features/chat/model/chat-composer.ts`、`packages/ssh-agent-web/features/session/components/new-session-chat.tsx`、`packages/ssh-agent-web/features/session/components/local-directory-picker.tsx`、`packages/ssh-agent-web/components/toggle-switch.tsx` |
| Session 图片/文本附件上传与准备 | `packages/ssh-agent-web/features/session/api/session-attachment-api.ts`、`packages/ssh-agent-web/features/session/model/image-upload.ts`、`packages/ssh-agent-web/features/session/model/attachment-file.ts`、`packages/ssh-agent-web/features/chat/runtime/use-chat-attachment-uploads.ts`、`packages/ssh-agent-web/features/chat/model/prepare-chat-attachment.ts`、`packages/ssh-agent-web/features/chat/components/chat-attachment-uploads.tsx`；接口约束见 [session-attachment-api.md](../frontend/session-attachment-api.md) |

前端契约见 [chat-stream-integration.md](../frontend/chat-stream-integration.md)，完整设计见 [chat-stream-runtime.md](../design/chat-stream-runtime.md)，后端结构治理顺序见 [ChatService 完整拆分计划](../design/chat-service-refactoring-plan.md)。


2026-10-19 Diagnose 接入：`/diagnose` 使用独立 DiagnoseService/Coordinator/Runtime，跨 Chat Run 保存任务，三个元数据工具免审批，普通命令与只读策略保持。ChatService 只预约 idle Session、冻结任务绑定及组合 Context；结束按钮通过原 Run/follow_up 请求结论，直接退出才强制取消绑定 Run。前端 attachRun 复用原 Chat 恢复与 SSE。 详见 [Diagnose 功能路由](./diagnose.md)。

本地文件预览按类型分流：读写、上传和下载四类成功工具行使用统一的悬浮/键盘查看入口，上传/下载路径来自已确认的结果详情；点击文件名本身只展开工具详情。文本继续使用 `features/file-reader/`，图片、音频、视频使用独立 `features/media-preview/` 标签、元数据与流接口，共用 TaskContainer 展示而不混合处理生命周期。macOS 系统临时目录别名由共享文件访问边界规范后校验；见 [多媒体预览](./media-preview.md)。
