# Terminal Interaction 代码路由

只读 Session 仍以受限模式打开 PTY，但实际 `sandboxRoots` 固定为 `/tmp`；保留 `/dev/null`、账号可读范围与既有非文件操作边界。切换只读会自动重开原 Terminal Tab，准备失败不会降级，失败卡片不提供只读模式内的安装入口。见 [session-sandbox.md](../session-sandbox.md)。

适用于与业务 Session 绑定的长周期 SSH PTY、Canonical Terminal State、浏览器只读投影、Agent Terminal Tool 和审计时间线。

## 当前边界

- Terminal Mode 只有一个前端入口。Session 默认开启沙盒，启动时由协调层依次探测 Landlock 和已安装的 Bubblewrap；全部后端不可用或保护不足时失败关闭，不自动降级。用户显式关闭 Session 沙盒后，PTY 跳过能力探测与受限准备，使用 `unconfined_exec` 在默认远端目录启动 Bash，记录 `source=session_setting`；不需要单次 Full Access 例外。每次 Agent 输入仍受 Guard 和普通审批约束。切换与自动重开见 [session-sandbox.md](../session-sandbox.md)。
- Session 开启且能力可用时，后端校验并规范化当前 Session 的全部 `sandboxWritableRoots` 作为可写根，PTY 默认启动目录仍独立读取 Target `defaultCwd`；Landlock 使用 Native launcher 和账号登录 Shell，Bubblewrap 使用挂载命名空间和 `bash --login -i`。Broker 只在带随机 nonce 的确认行到达后交出 Channel，确认行不会进入屏幕或 Observation；启动输出先限量缓冲，Actor 持久化 `active` 后才释放。任一可写根解析为 `/`、目录或启动器准备失败、确认超时、取消及通道提前关闭均失败关闭，不自动回退。两种受限后端及主动关闭模式下每次 Agent `submit` 仍执行 Guard 和现有审批。Bubblewrap `--new-session` 可能影响依赖控制终端的程序，尚需 Linux PTY 实机验证。 主动关闭时使用独立 Shell 就绪 nonce，Broker 仍等待启动确认和缓冲输出，但该确认不证明文件系统强制约束。
- 切换 Session 沙盒或在开启状态修改可写目录时，active Terminal 先关闭，配置提交后按新模式自动重开并保留 geometry；未开启时不主动打开。关闭状态仅修改未来可写目录不重启无约束 PTY；相同目录列表不重开。Shell 内状态不迁移，opening/closing 或活动执行时拒绝切换。保存失败尽力恢复原模式；新 PTY 失败保留失败记录，开启设置不会因准备失败而被关闭。
- TerminalSession 保存请求模式和实际沙箱事实。v20 迁移让历史记录维持未知状态；SQLite 和浏览器入口校验实际事实。新打开的 Terminal 在状态、时间线数据、Agent Tool 描述及结果中保留 Landlock ABI 或 Bubblewrap 版本与完整规范化 `sandboxRoots`（`sandboxRoot` 保留首项兼容），浏览器顶栏不展示这些审计细节；历史上由旧入口创建的 Full Access 或自动回退记录仍可读取；`stored-terminal-sandbox.ts` 在 SQLite 读取边界统一解释 `approvedAt`、旧 `source/detectedAt` 和沙箱前 null 记录，并严格检查新旧字段、请求模式与状态约束。Session 主动关闭的新事实要求请求与实际模式均为 `full_access`，保存 `source=session_setting/configuredAt`，前端明确区分主动关闭与历史自动回退。历史事实不参与新 PTY 的权限选择。共同策略不保证网络、IPC 和文件元数据。
- Terminal Interaction MVP 已完成后端、Agent 和前端链路。一个业务 Session 最多存在一个 live TerminalSession，用户通过 Chat 输入框开头的 `/` 或合法位置的 `@` 唤起工具菜单打开或定位 Terminal Tab，通过标签页 `×` 关闭；页面顶部不再提供独立开关。活动 Chat Run 期间禁止新开或关闭，已有页面仍可定位，取消 Run 只停止 Agent，不关闭 TerminalSession。
- Chat Run 冻结 `serverInteractionMode`，一个 TerminalSession 同时只绑定一个活动 Run。两种模式都提供相同 Tool 定义，后端门禁只允许当前模式入口。头部在首次 Run 保存不可变快照；开启、关闭、断开与重启恢复通过原子状态提交追加真实 system on/off 消息，不改写头部。见 [会话头部与模式消息](../session-prompt.md)。
- `terminal_interaction` 支持 `submit`、`CTRL_C` 和 `observe`。Tool 参数使用供应商兼容的顶层 object schema，再由运行时校验 action 对应字段：submit 必须带非空 input 且不能带 key；key 必须带 CTRL_C 且不能带 input；observe 不接受 input/key。字段矛盾不会静默丢弃输入或改写动作。有效调用仍是标准 Agent Tool Call，Interaction、规范化显示文本、实际派发 bytes、Guard 结果、Approval、Observation 和交付/处理时间线均持久化。`autoAudit` 沿用原审批逻辑；Guard 在审批前和实际写入前各检查一次。
- `terminal-interaction-tool.ts` 持有 submit 的审批准备与最终决定回写，审批方案用 `onDecision` 调用 Interaction 的 approve/reject；授权策略只做分发。缺少 submit 输入、错误 key、动作与字段矛盾、无效/超限输入按共用契约返回 `terminate: false` 供模型纠正。互斥校验由审批准备和直接执行共用，在读取 autoAudit、预检及创建 Interaction/Approval 或派发 PTY 前拒绝；错误结果说明冲突字段、合法动作组合、尚未写入，并要求重新生成工具调用，既有 Agent Loop 继续将其反馈给模型。部署模式不额外禁用控制键，submit/key/observe 仍按 Terminal 原规则执行，结果不推进部署阶段；Guard 硬拒绝仍终止，Interaction/Observation 持久化故障不在审批边界降级为参数错误。
- Terminal Interaction 的 Guard 决策和失败信息使用显式领域类型，SQLite 恢复时在基础设施边界校验 JSON。`TerminalInteractionPolicy` 负责绑定运行实例、审批等待、输入规范化、Guard 与取消检查，不写状态或 PTY；每次调用的 `TerminalInteractionRecorder` 负责 Interaction/Input/Observation 状态、时间、持久化校验和审计事件，不决定权限或派发输入。Interaction Service 保留幂等结果、互斥槽、观察游标和阶段编排；独立 capture 模块负责 replay、prompt/quiet/snapshot/timeout 边界与 Agent 视图截断。
- 输入执行按“绑定 Actor/确认审批已结束 → 检查取消 → 读取已准备输入/复检 Guard → 持久化 writing 与输入事件 → 写入 PTY → 持久化 written/observing → 捕获 Observation → 持久化 completed”的顺序推进。写入前使用已保存的显示文本和 bytes，调用参数变化不会替换已审批的输入；两次 Guard 覆盖审批等待前后的不同时间点。取消在执行入口、异步 Guard 后和输入事件持久化后复检，已检测到取消的调用不进入写入。失败状态更新和 Input 更新都检查持久化结果；写入或写入后状态记录失败收敛为 `write_uncertain`，其他执行/观察失败收敛为 `failed`，取消收敛为 `cancelled`。已结束的调用重试不会自动重放输入；执行期 Guard 拒绝保存最新规则决定和阻断时间线，预检硬拒绝直接建立 rejected/blocked 记录。
- Agent 观察起点按 live TerminalSession actor 保存，跨 Chat Run 复用；首次从空起点读取已有输出，后续从上次成功标记 delivered 的 Canonical capture 接续。`observe`、`submit`、`CTRL_C` 都包含调用间隙尚未交付的内容；仅成功持久化 Observation 不推进起点，取消、Guard 拒绝、写入或交付失败也不推进。交付时采用该 Observation 的结束快照，之后到达的输出留给下一次调用；同一 tool call 的重试仍返回已持久化的结果。游标和待交付快照随 actor 回收，不在后端重启后恢复（旧 Terminal 会收敛为 lost）。
- Observation 回放发生 gap（包括超大单帧清空 ring）时返回保留的终端文本并设置 `truncated`、显式提示历史可能不完整，不因旧游标一直失败。文本增量仍基于 Canonical 文本前缀；滚屏、重绘或 resize 使前缀不再匹配时，回退为保留文本并同样提示可能不完整。`streaming` 仍返回当前屏幕快照，rawByteCount 在回放缺失时只统计可取得的 bytes，不代表完整历史字节数。
- Terminal REST 负责状态、幂等 open/close、attachment bootstrap/ready/focus/resize/detach、timeline 和 observation；SSE 使用版本化 TS envelope、Base64 output、snapshot + sequence replay、gap resync、heartbeat 和订阅者背压上限。事件地址由独立 `shared/events/client.ts` 生成，与 REST 使用不同 origin；见 [transport-channels.md](../transport-channels.md)。
- 面板的“恢复 Terminal 状态”表示浏览器 snapshot/replay 尚未完成，不表示后端 PTY 尚未打开，首次附着也经过该阶段。工作区标题、监控、Deploy、Diagnose 通过共享 Workspace 连接减少事件 origin 占用；不能通过提前标记 Live 绕过 terminal.stream.ready 和 ready API 的确认。连接容量回归见 transport-channels.test.ts，Terminal 自身协议不变。
- Terminal REST/SSE 在浏览器出口按请求 Locale 翻译后端状态与失败说明；Base64 output、ANSI bytes、Observation 和用户输入保持原样。TerminalSession 继续保存英文 failure fallback，并额外保存可选 message key/values，使刷新后可按新的 Locale 重新投影。
- Terminal open 由 Terminal Session Service 分阶段处理幂等请求、前置检查、资源创建与后台启动；在最后一次异步校验之后同步检查服务关闭及 live Terminal 状态，避免并发打开或关闭服务期间创建新运行实例。Actor 构造完成后接管 Session lease 和容量 reservation，初始化失败按资源所有者清理。`TerminalChannelOpener` 负责目标解析 → 当前 Session 策略 → 受限准备或直接 Shell 包装 → PTY 打开，以及覆盖全流程的 deadline、取消和迟到 Channel 的释放，不修改会话状态；Actor 负责激活或失败落库。目标解析、沙箱准备或 PTY 请求超时会持久化为 `failed/terminal_open_timeout` 并释放资源；超时/取消后不再进入后续准备或派发，忽略取消而迟到的 Channel 会被销毁。
- 浏览器 attach/SSE 失败会刷新权威状态；可重试错误按 UI 静态间隔重新 bootstrap，明确标记 `retryable: false` 的错误（如 `terminal_session_not_found`）停止自动重试并保留手动重试入口。仅 Terminal Session 身份或状态变化会重新挂载 attachment，普通状态刷新不会重复挂载；后端重启后不会继续展示旧 actor。关闭时如果仅剩持久化的 live Terminal Session 而运行实例缺失，后端将其收敛为 `lost` 并写入时间线，避免前端重新挂载失效的 Terminal。
- 活动 Shell 正常退出记录为 `closed/shell_exited`；通道断线或关闭异常记录为 `lost/connection_lost`。显式关闭即使底层 `channel.close()` 抛错也收敛到终态并释放 Channel、Session lease 与容量；终态 SQLite 写入失败时也销毁 Channel 并释放运行资源，不让失去状态所有者的 Shell 继续运行。
- 浏览器只读，不可向 PTY 输入。后端 Headless xterm 是唯一 Canonical Terminal State；前端 xterm 先恢复同 geometry 的 ANSI snapshot，再按 sequence 应用事件。当前聚焦页面成为 resize owner，浏览器容器变化经后端校验并写入 PTY 后再广播，前端不独立修改逻辑网格。
- Actor 将队列中相邻的 SSH 输出合并为最多 64 KiB 的批次，再写入 Canonical State 并发布一个 output sequence，避免 Arthas 等命令行重绘的细碎输出逐片等待 xterm 定时器。输入、snapshot/capture、resize 与生命周期操作会封住前一个批次，后来的输出不会跨越这些边界。ANSI 和 UTF-8 bytes 保持原顺序；超过批次限制的单个 SSH chunk 仍独立处理。
- 浏览器 `terminal-event-queue.ts` 逐条检查 sequence，合并相邻 output 到最多 64 KiB 的 xterm write；每批解析完成后记录末尾 checkpoint，输入、resize、Observation 与 stream.ready 仍依次处理，ready 只确认实际解析完成的 replay sequence。待处理（含正在写入）的队列上限为 4096 个事件及 512 KiB 输出；解析或 ready 等待超过 10 秒、序列 gap 或积压超限时丢弃旧显示队列，沿用面板错误恢复重新获取 snapshot，不重放 PTY 输入。attachment 清理同步取消队列和定时器，迟到写入不再更新 marker 或页面状态。回归见 `tests/terminal-event-queue.test.ts` 和 `test/terminal-session-actor.test.ts`；只覆盖本地事件与 Canonical State，不代表真实 SSH/Arthas 验证。
- 前端 xterm 保持完整的明亮/暗部/明暗分层/ION 离子终端 ANSI palette、主题更新和 Observation 行为。Session 顶栏由通用任务容器的 44px 标签栏承接，只显示 Terminal 名称、附着/同步/Live 阶段与关闭按钮。`TerminalPanel` 只呈现视口，通过稳定回调上报附着阶段，不持有重复顶栏；重新同步入口保留在视口错误提示中。主题切换只更新 `Terminal.options.theme`，普通状态刷新和标签选择不重建 attachment/SSE、不清空 scrollback。隐藏内容不提交零尺寸 PTY resize，geometry 仍由后端权威同步。
- Session 的通用任务容器在宽于 1100px 时作为占内容区 45% 的全高右栏，1100px 及以下位于 Chat header 下方；位置、宽度与动画归 `chat-task-layout.css` 和任务容器默认值，Terminal 功能不拥有外层网格。Sidebar 或容器尺寸变化继续使用既有 ResizeObserver 和 owner resize 链路。见 [任务容器](../task-container.md)。
- 容器放大时右侧任务页向左覆盖 Agent 对话区域，左侧服务器导航保留；收起只隐藏内容，不卸载 TerminalPanel、attachment 或 SSE。`terminal-viewport-sync.ts` 集中处理可见视口、focus 和 owner-only resize：replay ready 后才申请权限，视口隐藏或浏览器失焦时取消待发 resize 并释放 ownership，恢复时重新申请并测量。focus 和 resize 各自串行，过渡测量防抖 200ms，不堆积旧尺寸；待服务端 `terminal.resized` 更新 xterm 后才确认 geometry，若旧请求完成时布局已变则重新测量最终尺寸。失去 ownership 的旧 resize 失败和卸载后的异步响应被忽略，当前错误沿用既有 resync；不本地调用 fit 改逻辑网格，不发送零尺寸。回归见 `tests/terminal-viewport-sync.test.ts`。
- Terminal Mode 工具是即时 UI Action，沿用 Composer 的 `/`/`@` 入口和触发文本清理。未打开时调用现有 open 并展示 Terminal Tab；已有 Tab 时仅选中，不重复打开或关闭，即使 Agent 运行、连接或沙盒重开中也能定位。新开、重试和标签 `×` 关闭继续受运行及过渡限制；关闭通过现有 close，权威确认结束后保留原 disconnected/exiting 反馈再移除页面和收起容器。失败 Tab 支持重试、现有安装处理和收起，无 live 终端的失败页关闭不发 close。流程不创建 Chat 消息或 Tool Call，后端模式 system 记录保留。
- 前端通过同一 Terminal SSE 和现有 Observation REST，在 xterm 视口投影非交互式 Observation Lens。`terminal.input` 与 `terminal.observation.captured` 建立随 scrollback/reflow 移动的起止 marker；只有 REST 返回的 `agentViewText` 包含有效内容时才渲染 Lens，空白、仅截断标记或查询失败均不展示 Magic Mask。delivered 第一帧直接显示严格范围，processing 只在范围内播放有机极光和无规则星尘，finished 至少展示满 800ms 后淡出；滚出视口时显示方向提示，刷新恢复无法可靠定位时明确降级为屏幕快照而不伪造精确边界。SSE 重放、resync、Terminal 终态和 attachment 重建会清理过期 marker、timer 和效果；后端协议及领域结构不变。
- 后端直接依赖 `@xterm/headless` 与 `@xterm/addon-serialize`，前端直接依赖同一稳定版本线的 `@xterm/xterm` 与 `@xterm/addon-fit`。
- 快照试验证明相同 geometry 下可以恢复 wrap、CJK 宽字符、颜色、cursor、scrollback 和 alternate screen，并能在恢复后继续同步 resize。
- `addon-serialize` 使用 proposed buffer API，后端 Canonical Terminal adapter 必须集中启用并隔离该依赖边界。
- `SessionLifecycleCoordinator` 已接入 Chat Run、Command Operation、Attachment upload、Session update/delete 和 TerminalSession lease；删除屏障建立后禁止新使用者进入。
- PTY 复用共享 Connection Pool Channel slot，并额外限制每个 Connection generation 的长期 PTY 数量；slot 和两级 reservation 直到 actor 持久化终态并 dispose 后才释放。
- actor 是 Headless Terminal、event sequence、replay、attachment、resize owner、geometry、run binding 和 idle 判断的唯一写者。
- 资源策略为受限级联：仅无 attachment、无活动 Tool/Run 消费者且达到 idle TTL 时自动关闭。后端重启把遗留 live Terminal 收敛为 `lost`，写入中 Interaction 收敛为 `write_uncertain`，不自动重放输入。
- 产品、状态机和冻结契约见 [Terminal Interaction Layer 技术设计](../../design/terminal-interaction-layer.md) 与 [前后端联合实现设计](../../design/terminal-interaction-implementation-design.md)；有差异时以源码和本文为准。

- `useTerminalMode` 用同步 ref 操作锁阻止同 render 重复请求；状态读取绑定 Session 身份与递增读序号，忽略旧 Session、卸载及乱序响应，过渡轮询不重叠。open 响应异常后重新读状态以恢复已提交的 PTY；close 异常后重新读权威状态，无法确认结束时保留页面及错误。后端状态机和 REST/SSE 契约不变。
- `use-terminal-task.ts` 管理 Terminal 的 Tab 展示与关闭规则，功能页以稳定的 Session Terminal 身份接入。沙盒自动关闭/重开保留同一个 Tab，新 TerminalSession id 只触发连接重新附着。`terminal-task.tsx` 组合页内内容，不依赖通用容器业务分支。回归见 `tests/use-terminal-task.test.ts`、`tests/use-terminal-mode.test.ts`。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 后端 xterm 直接依赖 | `packages/ssh-agent/package.json` |
| 前端 xterm 直接依赖 | `packages/ssh-agent-web/package.json` |
| ANSI snapshot 兼容性与语义等价测试 | `packages/ssh-agent/test/terminal-snapshot-spike.test.ts` |
| 领域类型和服务端权威默认值 | `packages/ssh-agent/src/domain/terminal.ts`、`packages/ssh-agent/src/application/terminal/terminal-defaults.ts` |
| SQLite schema、Repository 和重启收敛 | `packages/ssh-agent/src/infrastructure/sqlite/migrations.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-terminal-repository.ts`、`stored-terminal-sandbox.ts` |
| Session 生命周期屏障、Terminal 生命周期和沙箱能力不足时的失败关闭 | `packages/ssh-agent/src/application/services/session-lifecycle-coordinator.ts`、`packages/ssh-agent/src/application/services/terminal-session-service.ts` |
| Terminal 通道准备、整体 deadline、取消与迟到资源清理 | `packages/ssh-agent/src/application/terminal/terminal-channel-opener.ts` |
| Agent Tool、Guard/Approval、输入和 Observation | `packages/ssh-agent/src/application/services/terminal-interaction-service.ts`、`packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts`、`packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/services/chat-approval-service.ts`、`packages/ssh-agent/src/application/terminal/terminal-observation-capture.ts`、`packages/ssh-agent/src/application/tools/terminal-interaction-tool.ts` |
| Interaction 的输入策略/执行检查与逐次状态记录 | `packages/ssh-agent/src/application/terminal/terminal-interaction-policy.ts`、`packages/ssh-agent/src/application/terminal/terminal-interaction-recorder.ts` |
| 执行顺序、审批/Guard、取消、不重放输入、并发打开及启动资源清理回归 | `packages/ssh-agent/test/terminal-interaction-service.test.ts`、`packages/ssh-agent/test/terminal-session-service.test.ts` |
| 稳定 Tool 定义、执行门禁与 Run 绑定协调 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`、`packages/ssh-agent/src/application/services/chat-service.ts` |
| Tool schema、矛盾字段在副作用前拒绝、模型重新生成和原生 Node ESM 运行时回归 | `packages/ssh-agent/test/terminal-interaction-tool.test.ts`、`packages/ssh-agent/test/chat-tool-authorization-policy.test.ts`、`packages/ssh-agent/test/chat-agent-runtime-factory.test.ts`、`packages/ssh-agent/test/terminal-node-runtime.test.ts` |
| Canonical State、replay、runtime registry 和单写者 actor | `packages/ssh-agent/src/application/terminal/terminal-canonical-state.ts`、`packages/ssh-agent/src/application/terminal/terminal-replay-ring.ts`、`packages/ssh-agent/src/application/terminal/terminal-runtime-registry.ts`、`packages/ssh-agent/src/application/terminal/terminal-session-actor.ts` |
| PTY 应用端口、ssh2 adapter 和启动确认缓冲 | `packages/ssh-agent/src/application/ssh-channel-broker.ts`、`packages/ssh-agent/src/infrastructure/ssh/ssh2-terminal-channel-broker.ts`、`packages/ssh-agent/src/infrastructure/ssh/terminal-startup-capture.ts` |
| REST/SSE、请求校验和错误映射 | `packages/ssh-agent/src/api/terminal-routes.ts`、`packages/ssh-agent/src/api/terminal-request-validation.ts`、`packages/ssh-agent/src/api/http-handler.ts` |
| Terminal 公开消息本地化 | `packages/ssh-agent/src/i18n/message.ts`、`packages/ssh-agent/src/i18n/projection.ts`、`packages/ssh-agent/src/i18n/public-error.ts` |
| Composer 工具入口、Terminal 状态描述、即时切换与触发器测试 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/components/chat-composer-panel.tsx`、`packages/ssh-agent-web/features/chat/components/chat-token-editor.tsx`、`packages/ssh-agent-web/features/chat/model/chat-composer-menu.ts`、`packages/ssh-agent-web/features/session/components/new-session-chat.tsx`、`packages/ssh-agent-web/tests/chat-composer-menu.test.ts` |
| 异步打开失败提示和安装入口 | `packages/ssh-agent-web/features/terminal/components/terminal-open-failure.tsx`、`packages/ssh-agent-web/tests/terminal-open-failure.test.tsx` |
| 只读 xterm、动态主题、沙箱状态提示、连接状态、Observation Lens、响应式分栏、owner resize 和时间线 | `packages/ssh-agent-web/features/terminal/`、`packages/ssh-agent-web/app/globals.css` |
| 浏览器 attachment 自动重试判定 | `packages/ssh-agent-web/features/terminal/model/terminal-retry.ts`、`packages/ssh-agent-web/features/terminal/components/terminal-panel.tsx`、`packages/ssh-agent-web/shared/api/client.ts` |
| 镜像输出批处理、事件顺序、积压/超时恢复与回归 | `packages/ssh-agent-web/features/terminal/runtime/terminal-event-queue.ts`、`packages/ssh-agent-web/tests/terminal-event-queue.test.ts` |
| 视口可见性、ownership、串行 resize 与回归 | `packages/ssh-agent-web/features/terminal/runtime/terminal-viewport-sync.ts`、`packages/ssh-agent-web/tests/terminal-viewport-sync.test.ts` |

PTY 启动不读取工作区默认远端目录：受限和 Session 主动关闭两条路径均保留 SSH 初始目录，Shell 启动文件仍可按账号配置改变目录。可写权限只来自 Session 的独立目录列表，不随当前目录变化。
