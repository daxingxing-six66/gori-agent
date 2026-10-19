# 会话运行标识

左侧会话列表在每行右侧通过独立活动投影展示 Agent 状态；左侧导航圆点与运行状态分离。切换会话、工作区或页面不影响观察；标识只读，不控制 Run、工具、审批或队列，也不持有 Terminal/Deploy 生命周期。

活动流与 Workspace、Chat、Terminal 的 SSE 统一使用独立事件 origin，与普通请求的连接额度隔离；状态归约不处理端口或连接预算，见 [transport-channels.md](./transport-channels.md)。

## 展示契约

| 状态 | 触发事实与表现 |
|---|---|
| `running` | 已持久化的 pending/running Chat Run；小尺寸旋转图标，覆盖思考、输出、工具执行和排队续接 |
| `waiting_approval` | 当前 Run 存在未解决的人工 Tool Approval；静态审批图标 |
| `waiting_input` | 当前 Run 存在未回答的用户决策；静态消息图标 |
| `attention` | Run 终态或部署结算未能持久化，收到 `run.persistence_failed`；静态异常标识，提交恢复后跟随真实终态更新 |
| `completed` | 本次观察到的 Run 已成功结束且结果尚未查看；圆形勾选图标 |
| `failed` | 本次观察到的 Run 已异常结束且结果尚未查看；危险色警示图标 |
| `cancelled` | 用户停止且 Run 已取消，结果尚未查看；中性圆形减号，区别于失败 |
| `idle` | 完整快照中没有该 Session，或其当前结束结果已查看；右侧不显示活动图标，左侧导航圆点保留 |
| `unknown` | 首次连接或断线后尚未取得完整快照；暂不显示右侧状态，不继续用旧状态显示运行动画 |

等待态按独立 ID 集合计数；并行审批必须全部解决才恢复运行。展示优先级为 attention、等待回答、等待审批、运行。自动审批的 resolved 事件不产生等待态。当前页选中态与运行态分离；图标使用主题语义色、原生 SVG title 和本地化无障碍名称，无按钮底座；减少动态设置下停止旋转。

`SidebarSessionRow` 使用固定右侧槽容纳状态与管理操作，不随标题长度移动。鼠标悬浮或键盘焦点进入该行时，编辑/删除优先显示，隐藏状态但不停止事件订阅；鼠标和焦点离开后恢复状态。触屏设备保留可直接操作的按钮。行布局和操作优先级归组件局部 CSS，WorkspaceSidebar 只装配导航与编辑/删除回调。

普通点击会话名称时，行组件只发送 acknowledge 动作（再次点击当前选中会话同样生效）。Store 仅把当前 completed/failed/cancelled 的准确 Run 标记已读；运行、审批/回答等待及未解决的持久化异常继续展示。编辑/删除、被阻止的导航及修饰键打开其他标签页不触发已读；新一轮 Run 的结果仍可重新提示。

正在查看的会话成功完成时，结果自动已读，运行图标直接消失，不闪现成功勾选。Provider 仅根据当前路由的 sessionId 和页面可见性发送查看会话变更，自动已读规则统一归 Store：增量和首次/重连快照都在通知行组件前处理 completed，进入已有成功结果的会话也立即生效；切走会话或浏览器页面进入后台后不再自动已读，回到可见会话时再消除成功标识。失败、停止、待审批、待输入和未解决异常不会因停留在页面而自动清除，点击会话的显式已读规则保持不变。

## 分层与入口

| 职责 | 入口 |
|---|---|
| 结构化展示契约 | `packages/ssh-agent/src/domain/session-activity.ts` |
| 通用事实观察出口 | `packages/ssh-agent/src/application/chat-run-event-hub.ts` 的 `observe(types, listener)` |
| 状态规则、等待集合和过期 Run 隔离 | `packages/ssh-agent/src/application/session-activity/session-activity-projector.ts` |
| 观察与传输装配、资源释放 | 同目录 `session-activity-service.ts` |
| 全局快照、增量、heartbeat 和订阅取消 | 同目录 `session-activity-stream.ts` |
| 业务服务装配 | `services/create-chat-service.ts` 创建独立投影，注入 ChatService；ChatService 只发布事实、暴露入口和关闭资源 |
| 前端协议校验 | `packages/ssh-agent-web/features/session-activity/model/session-activity.ts` |
| 会话状态仓库 | 同 feature 的 `runtime/session-activity-store.ts` |
| 当前浏览器的已读结果与存储降级 | 同 feature 的 `runtime/session-activity-read-state.ts`；按 Session ID + Run ID 记录，独立于后端事实 |
| 连接、重试与旧连接隔离 | 同 feature 的 `runtime/session-activity-connection.ts` |
| 根级订阅、当前可见会话上报和 React 消费 | 同 feature 的 `components/session-activity-provider.tsx`，由 `app/layout.tsx` 挂载；导航不重建活动流 |
| 只读标识与局部样式 | 同 feature 的 `components/session-activity-indicator.tsx`、`session-activity.css` |
| 会话行与操作优先级 | `components/sidebar-session-row.tsx`、`sidebar-session-row.css`；状态只传 sessionId，选中态归导航样式 |
| 侧栏接入 | `components/workspace-sidebar.tsx` 装配会话行与既有管理回调 |
| 文案 | 中英文独立 `session-activity.ts` catalog，由两种语言聚合目录静态导入 |

## 事件和资源边界

- 业务触发点继续发布既有 `run.updated`、`approval.requested/resolved`、`decision.requested/resolved` 与 `run.persistence_failed`；初次 Run 插入成功后发布 pending 事实。规则不散落到工具、审批组件和聊天 Hook。
- `ChatRunEventHub` 按事件类型分发进程内观察；token delta、工具输出和队列变化不进入活动归约，也不为活动投影额外订阅每个 Run 的 SSE。观察者异常只记录 delivery 诊断，不中断 Agent。
- `GET /api/session-activity/events` 是全局只读 SSE，覆盖所有工作区；浏览器根级只建立一条连接，不逐会话或逐工作区创建请求，也不轮询数据库。首帧 `activity.snapshot` 返回 `{ activities }`；变化帧 `activity.updated` 返回 `{ sessionId, runId, activity }`。终态用 completed/failed/cancelled 明确投影；null 继续兼容显式清除。
- 投影只接收本进程实际运行事实，终态后释放等待集合及活动 Run 索引，保留最多 256 个会话的最近结束结果；新 Run 替换该会话自己的结果。旧 Run 的终态/审批事件不能覆盖新 Run；无展示变化不广播。成功停止当前 Loop 并处理队列时 Run 未进入终态，因此保持运行标识。
- 初始快照不查询所有历史 Run 并批量回填结果；未参与本次运行的旧会话保持原样。浏览器刷新/重连恢复本进程仍保留的结果，后端重启不会给旧会话批量添加完成/失败标识。
- 前端监听器按 Session ID 注册，增量变化只通知目标行；重复状态与相同重连快照不通知其他行。终态还需匹配当前 Run ID，迟到旧 Run 不能盖掉新状态；只有断线导致所有状态失去权威性时才通知全部订阅者。
- 已读结果只影响前端展示，Store 继续保留服务端 Run 身份与真实状态，以校验迟到事件。已读按当前浏览器保存到 localStorage，刷新、重复事件或重连快照不会重新显示同一 Run 的图标；其他 Session 与新 Run 不受影响。最多保留 256 个会话的已读记录；存储损坏、不可用或写满时降级到内存，不阻断点击。此操作不请求后端、不取消 Agent、不修改数据库或其他浏览器的展示。
- 当前可见会话成功完成复用相同 Run 已读记录；切走后再完成的新 Run 仍会提示。路由与 visibilitychange 仅更新查看状态，不订阅每行 DOM、不轮询、不修改 Chat 生命周期；Provider 卸载时解除可见性监听并清空查看状态。
- 快照与增量只包含 Session、Workspace、Run ID 及状态；没有消息、命令、审批正文、模型凭据或文件路径，不写额外数据库记录。进程重启沿用已有 Chat 中断恢复，旧 Run 不作为活动任务恢复。
- 每次连接同步发送当前完整快照，不重放过期增量。断线或非法协议后前端转 unknown，按 1、2、4、8、16、30 秒上限退避重连；新快照替换旧仓库，迟到旧连接回调忽略。语言只影响本地标识文案，不重建无语言字符串的事件连接。
- SSE heartbeat 每 30 秒发送注释，仅在存在订阅时保留单个计时器。慢订阅者最多缓存 64 帧，超出关闭并由客户端重连取快照；Request abort、reader cancel 和服务关闭释放监听器与计时器。断开观察不取消 Agent。

## 验证

- `packages/ssh-agent/test/session-activity.test.ts`：多会话、并行等待、重复事件、旧 Run、三类终态、结果缓存上限、历史会话隔离、持久化异常、投影隔离、快照、慢消费者及清理。
- `packages/ssh-agent/test/session-activity-api.test.ts`：HTTP 请求处理器、内存 SQLite、临时本地目录与 faux 模型下的审批/决策等待、重连恢复、队列续接及断线不影响 Run；不连接真实 SSH 或模型服务。真实 TCP 的通道隔离与关闭由 `transport-channels.test.ts` 覆盖。
- `packages/ssh-agent-web/tests/session-activity.test.tsx`：类型边界、目标会话独立通知、三类结束结果已读、当前会话成功自动已读及无中间完成帧、首次/重连快照、离开后新 Run 继续提示、活动和异常状态不自动清除、幂等取消订阅、连接与退避、非法协议恢复、过期回调、清理及双语标识展示；`sidebar-session-row.test.tsx` 覆盖右侧槽、管理操作、当前会话点击、修饰键导航与各状态隔离。
- `packages/ssh-agent-web/tests/session-activity-provider.test.tsx`：路由切换不重建流、页面后台不自动已读、恢复可见性、非会话页面及卸载清理。
- `packages/ssh-agent-web/tests/session-activity-read-state.test.ts`：刷新恢复、Run/Session 作用域、记录上限、畸形存储与浏览器存储失败降级。
- API 回归预置 5 个已完成历史会话，仅对一个会话启动 faux Run，验证初始不批量标记、增量不涉及其他会话、重连只恢复该目标的完成结果。
