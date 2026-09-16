# Terminal Interaction Layer 技术设计

状态：MVP 已按本文冻结结论完成实现；本文保留为产品与架构契约，具体代码路由以 AI Repository 为准。

更新时间：2026-08-28

前后端技术与代码细节见 [terminal-interaction-implementation-design.md](./terminal-interaction-implementation-design.md)。

本文档把 Terminal Interaction Layer（TIL）与当前真实代码库对齐。后续即使丢失会话上下文，也应先阅读本文，再从文中链接进入源码。源码始终是当前实现事实；本文描述的是已确认目标、拟实施结构和仍需冻结的实现细节。

## 1. 目标

在一个持久化业务 Session 内，由用户显式开启一个长周期、有状态的远程 PTY TerminalSession。Agent 通过受控 Tool 向这个终端提交完整输入、发送有限语义按键或观察当前状态；用户在前端只读查看同一个终端，并能核对 Agent 实际输入和模型实际收到的不可变 Observation。

核心验收行为：

1. 普通模式使用无状态的 `remote_server_call`。
2. 用户开启 Terminal Mode 后，`remote_server_call` 从 Agent Tool 集合中移除，由 `terminal_interaction` 替换。
3. Agent 无权开启、关闭或重建 TerminalSession。
4. TerminalSession 跨 Chat Run 保持，Chat Run 结束不关闭 PTY。
5. 同一个业务 Session 同时最多一个活动 TerminalSession；一个 TerminalSession 恰好持有一个 PTY Channel。
6. Agent 与用户基于同一个后端 Canonical Terminal State；Live Terminal 可以比 Agent Observation 更新，但同一 sequence/geometry 下语义必须一致。
7. MVP 不提供 Terminal Panel 拖拽改宽；浏览器窗口或 viewport 改变时保持正常字体比例，并通过前后端同步 PTY resize 实现自动换行和 TUI 重绘。
8. 用户可以看到 Agent 输入、Observation 捕获位置、交付状态和模型当前上下文包含的 Observation。

## 2. 非目标

MVP 不实现：

- Agent 自动开启或关闭 Terminal Mode。
- 用户向 PTY 写入命令或与 Agent 竞争 stdin。
- tmux、screen 或服务重启后的 PTY 恢复。
- SSH transport 丢失后把旧 TerminalSession 迁移到新 Connection。
- Agent 直接操作 Connection、Channel、Credential 或 resize。
- 任意原始字节输入。
- 精确展示模型内部正在阅读哪个 token、字符或屏幕行。
- 用 Terminal Mode 替代 SFTP 文件传输。

## 3. 已冻结决策

### 3.1 业务关系

```text
Business Session  1 ─── 0..1 active TerminalSession
TerminalSession   1 ─── 1 PTY Channel
SSH Connection    1 ─── N Channels
Chat Run          N ─── 0..1 TerminalSession instance
```

- `0..1` 表示同时最多一个活动实例。
- TerminalSession 关闭或丢失后，同一业务 Session 可以由用户重新开启，但必须生成新的 `terminalSessionId`。
- Chat Run 在创建时绑定明确的 TerminalSession instance，不能在运行中静默切换到新实例。

### 3.2 Tool 集合互斥

```text
普通模式
├── read
├── write
├── bash
├── remote_server_call
├── sftp_upload
└── sftp_download

Terminal Mode
├── read
├── write
├── bash
├── terminal_interaction
├── sftp_upload
└── sftp_download
```

- `remote_server_call` 与 `terminal_interaction` 不能同时暴露。
- SFTP 保留，因为它是文件传输路径，不是第二条远程命令执行路径。
- Tool 集合在 Chat Run 创建时冻结。
- 活动 Chat Run 期间不能切换 Terminal Mode。
- TerminalSession 丢失后不回退到 `remote_server_call`。

### 3.3 输入所有权

- MVP 中只有 Agent 可以写 PTY stdin。
- 用户前端只读。
- 一个 TerminalSession 最多一个 in-flight TerminalInteraction。
- 一次文本提交是完整、原子的输入；不允许通过多个 Tool Call 拼接同一条输入。
- 控制键通过受限语义枚举表达，MVP 首先只支持 `CTRL_C`。

### 3.4 Canonical State 与 resize

- 后端 Headless Terminal 是唯一 Canonical Terminal State。
- 浏览器 xterm 是权威状态的显示副本，不独立决定 terminal geometry。
- 前端保持字体比例不变，根据容器像素尺寸和 cell 尺寸计算 `cols/rows`。
- 浏览器只请求 resize；后端确认并排序后同步更新 PTY、Headless Terminal 和所有 attachment。
- Observation 固化捕获时的 `rows/cols` 和 terminal sequence range。

### 3.5 Observation 与时间线

- Live Terminal State 可变，TerminalObservation 不可变。
- Tool Result 必须从已持久化 Observation 生成。
- UI 可以准确表达“Agent 收到并正在处理 Observation #N”。
- UI 不能声称知道模型内部正在阅读具体哪一行或哪一个 token。
- Agent Input、Observation Marker 和状态标签不写入 xterm buffer。

### 3.6 进程内协议

- 协议概念仍然存在：结构、状态机、时序、幂等、错误和边界语义都必须明确。
- 同一 TypeScript 进程内不使用完整 JSON Envelope；使用 TypeScript 类型、领域构造器和运行时不变量。
- Agent Tool 参数、HTTP、SSE 和持久化 JSON 等不可信边界使用 TypeBox/运行时校验。

### 3.7 Approval

- Terminal Mode 只切换远程交互能力，不构成 TerminalSession 生命周期内的长期命令授权。
- `submit` 保持现有 Session `autoAudit` 逻辑：`autoAudit=false` 时逐条人工审批；`autoAudit=true` 时自动批准，但仍持久化 Approval 审计记录。
- `observe` 没有远程写入，不需要 Approval。
- MVP 白名单中的 `CTRL_C` 不需要 Approval，但必须持久化 TerminalInputEvent。
- Guard 优先于人工或自动 Approval，并在实际写入 PTY 前复检。

### 3.8 Chat Run cancel

- TerminalSession 与业务 Session 绑定，不属于任何单个 Chat Run。
- Chat Run 无权主动关闭、重建或中断 TerminalSession，也不能在取消时隐式发送 `CTRL_C`。
- Chat Run cancel 只取消 Agent Loop 和当前 TerminalInteraction 的等待。
- 已经写入 PTY 的远端操作继续运行；TerminalSession 保持 `active`。
- 用户可以显式开启或关闭 TerminalSession；系统也可以按已冻结的 idle TTL 规则关闭无人使用的 TerminalSession。SSH transport 丢失和后端关闭属于被动 `lost`，不是 Chat Run 行为。

### 3.9 Terminal Snapshot

- 新 attachment、浏览器刷新和 `terminal.resync_required` 通过“Snapshot + Ring Buffer Replay”恢复 Live Terminal，不从 TerminalSession 起点重放全部 raw output。
- Snapshot 由后端 Canonical Headless Terminal 在确定 sequence `N` 上按需生成，不写 SQLite。
- MVP 首选 `@xterm/addon-serialize` 生成可重新写入 xterm 的 ANSI 状态，并通过版本化、Base64 编码的外部协议传输。
- 浏览器必须先按 Snapshot 原始 `rows/cols` 恢复状态，再重放 `N+1` 之后的事件；成为 resize owner 后才能请求新 geometry。
- ring buffer 无法覆盖 `N+1` 时必须重新 bootstrap，不能带缺口进入 Live 状态。
- `@xterm/addon-serialize` 必须通过实现前技术 spike；若不满足一致性门槛，回退为后端自定义完整 ANSI framebuffer serializer，不能退化为纯文本或只消费未来 output。

### 3.10 Observation Boundary

- 采用 expectation 驱动的组合边界，不把 prompt、quiet 或 timeout 单独视为远端命令完成证明。
- `finite` 使用保守 prompt detection、`800ms` quiet、`30s` max wait、output limit，生成 transcript delta。
- `interactive` 使用保守 prompt detection、`500ms` quiet、`15s` max wait、output limit，生成 transcript 并保留当前 screen 上下文。
- `streaming` 使用固定 `1500ms` snapshot window 和 `3s` max wait，生成当前 screen；持续输出不能无限延长 snapshot window。
- prompt candidate 需要额外 `150ms` settle window，期间没有新的 Canonical Terminal mutation 才能形成 `prompt` 边界。
- 单次 Interaction 最多观察 `256 KiB` raw output；Agent Tool 文本最多保留最终 `64 KiB`，截断必须显式标记。
- max wait、quiet、snapshot 和 output limit 只结束当前 TerminalInteraction wait，不发送控制键、不停止远端进程、不改变 TerminalSession 生命周期。

### 3.11 Resource Limit 与 idle TTL

- 采用“资源硬上限 + idle TTL”方案；默认每进程最多 `16` 个、每个 Connection generation 最多 `4` 个 `opening/active/closing` TerminalSession。
- 每个 TerminalSession 的 raw ring buffer 默认 `2 MiB`、Headless Terminal scrollback 默认 `2000` 行、attachment 最多 `4` 个、单个 SSE subscriber 待发送数据最多 `512 KiB`。
- idle TTL 默认 `2h`。只有同时不存在 live attachment、active Chat Run binding 和 in-flight TerminalInteraction 时才开始计时。
- PTY output 不刷新 idle TTL，避免无人消费的持续日志永久占用资源；用户 attachment、Chat Run binding 和 TerminalInteraction 会刷新消费活动时间。
- idle reaper 关闭 TerminalSession 前必须在 Session actor 内重新检查状态并以 compare-and-set 把 `active` 转为 `closing`，避免与 attach、Run 创建或 Interaction 竞争。
- TerminalSession 进入 `closing` 后，Session 的有效执行模式自动变为 `command`；后续 Chat Run 使用 `remote_server_call`。
- 不在活动 Chat Run 内热替换 Tool。active terminal-mode Run 持有 run binding lease，因此 TTL 不得关闭其 TerminalSession；Run 的 Tool 集合继续保持冻结。

### 3.12 Session 删除受限级联

- 删除 Session 时，活动 Chat Run 或 active Command Operation 继续阻止删除。
- 如果只有 `opening/active/closing` TerminalSession，删除流程自动关闭并释放 PTY 后再删除 Session，不要求用户先单独关闭 Terminal Mode。
- 删除开始后建立 Session deletion barrier，阻止新的 Run、Command Operation、Terminal open/attach/Interaction 和 Session update 进入。
- 删除流程不取消 Agent、不发送 `CTRL_C`，也不把普通 Command Operation 标记为 cancelled；这些资源存在时直接返回冲突。
- Terminal 关闭或 destroy 完成、runtime reservation 释放后，才允许删除 Session 数据。
- Terminal 已关闭但数据库删除失败时，Session 保留并处于有效 `command` 模式；不能自动重开 TerminalSession。

### 3.13 Focused Tab Resize Ownership

- 采用“当前聚焦页面成为 resize owner”方案。前端只有在 `document.visibilityState === "visible"` 且 `document.hasFocus()` 时才能申请 ownership。
- 后端按 TerminalSession actor 收到 focus claim 的顺序授予唯一 owner；新的有效 claim 替换旧 owner，并递增 `ownershipEpoch`。
- resize request 必须携带当前 `attachmentId + ownershipEpoch`；旧 owner 的迟到请求必须以 `terminal_resize_not_owner` 拒绝。
- MVP 不提供 Terminal Panel 拖拽手柄，也不提供用户手动抢占 owner 的控件。ResizeObserver 只响应浏览器窗口、viewport 和固定响应式布局造成的容器尺寸变化。
- attachment 必须完成 Snapshot restore 和 replay、进入 `LIVE` 后才能申请 ownership；获得后才允许按当前容器请求 resize。
- owner detach 或 SSE 断开时释放 ownership；在另一个 visible/focused tab 发出 claim 前保持最后 geometry，不自动选择后台 follower。
- 不使用周期性 focus claim 争抢 ownership。多设备同时聚焦时以最近一次离散 focus/visibility claim 为准，这是 MVP 接受的小概率 last-writer-wins 行为。

### 3.14 Agent Tool 调用边界与持久化

- 对 Agent 来说，`terminal_interaction` 是普通 Tool：assistant message 产生 Tool call，Tool 内部调用 Terminal harness，随后返回标准 `content/details` result。
- 所有 Tool 的原始 input 和最终 output 都继续通过现有 AgentMessage/Chat Message 机制长期持久化，不为 Terminal Tool 建立另一套 Agent 可见消息协议。
- assistant message 中持久化 Tool name、toolCallId 和原始 arguments；tool-role message 中持久化最终 result `content/details`。成功、拒绝、blocked、uncertain 和普通失败都必须产生明确 result。
- Terminal 领域表不替代 Chat Tool 记录。它保存规范化 input、实际 PTY bytes、Guard/Approval、terminal sequence 和 Observation 等执行事实。
- 两层通过 `runId + toolCallId + interactionId + observationId` 关联。Tool Result 必须从已持久化 Observation 生成，然后再由 Chat Message 持久化真正交给 Agent 的 result。
- 如果进程在 Tool result 形成前崩溃，只能保留 input 和真实的 Interaction 恢复状态，不能补造一条已经交给 Agent 的 output；delivery 仍以真实 tool-role `message_end` 为准。

## 4. 当前代码事实

### 4.1 Chat Runtime

- [`ChatService`](../../../packages/ssh-agent/src/application/services/chat-service.ts) 每个 Chat Run 新建一个 `Agent`，并一次性注入 Tool。
- 同一业务 Session 同时最多一个活动 Chat Run。
- Agent 全局配置允许 parallel Tool，但单个 Tool 可以用 `executionMode: "sequential"` 强制整批顺序执行。
- Chat Run SSE 由 [`ChatRunEventStream`](../../../packages/ssh-agent/src/application/chat-run-event-stream.ts) 管理，只保留进程内有限事件。
- [`ChatService`](../../../packages/ssh-agent/src/application/services/chat-service.ts) 在每个 `message_end` 把完整 `AgentMessage` 追加到 `chat_messages.message_json`；现有机制已经覆盖 assistant Tool call arguments 和 tool-role result。
- Agent Loop 已经在 Tool Result 后开启下一次 `turn_start`，无需修改 Agent 核心循环即可标记 Observation 进入下一次模型请求。
- 当前 Tool 名称是 [`remote_server_call`](../../../packages/ssh-agent/src/application/tools/remote-server-call-tool.ts)。

### 4.2 SSH Runtime

- [`Ssh2ConnectionPool`](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-pool.ts) 按完整 Connection Key 复用物理连接。
- `withChannelSlot()` 的许可覆盖一次 Channel 操作的完整生命周期；长期 PTY 会长期占用一个 Channel slot。
- 默认每个 Connection 最多 8 个 Channel，Channel 获取默认等待 15 秒。
- 物理连接意外断开后 Pool 可以创建新 generation，但运行中的旧 Channel 不会恢复。
- [`Ssh2ChannelBroker`](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-channel-broker.ts) 当前组合 Exec 和 SFTP adapter，尚无 Shell/PTTY adapter。
- `ssh2` 当前类型提供 `client.shell(ptyOptions, callback)` 和 `channel.setWindow(rows, cols, height, width)`。

### 4.3 Session 与持久化

- [`Session`](../../../packages/ssh-agent/src/domain/session.ts) 是持久化业务实体，绑定不可变 `workspaceId`。
- 现有 `terminalContextCursor` 是旧设计遗留，不用于本方案的双向终端上下文同步。
- Session 删除当前只阻止 active command operations；设计需要加入 active TerminalSession 检查。
- SQLite 当前持久化 Chat Run、消息、Approval、Queue 和 command operation，但没有 TerminalSession、Interaction 或 Observation 表。

### 4.4 HTTP 与前端

- [`node-http-server.ts`](../../../packages/ssh-agent/src/server/node-http-server.ts) 当前只处理 HTTP Request/Response，没有 WebSocket upgrade。
- 当前 Chat 和 Workspace 实时事件都使用 SSE。
- [`ChatConsole`](../../../packages/ssh-agent-web/features/chat/components/chat-console.tsx) 是真实 Session 页面入口。
- 前端 Chat Runtime 已按 `toolCallId` 归约 Tool 状态，但没有 Terminal 领域状态。
- `@pi/ssh-agent-web` 当前没有 xterm 依赖。

## 5. 目标架构

```text
ChatService
  └── createTerminalInteractionTool(run binding)
          │
          ▼
TerminalInteractionService
  ├── TerminalSessionRegistry       sessionId -> live runtime
  ├── TerminalInteractionExecutor  one in-flight interaction
  ├── ObservationEngine
  ├── TerminalRepository
  └── TerminalEventStream
          │
          ▼
TerminalChannelBroker
          │
          ▼
Ssh2TerminalChannelBroker
  └── Ssh2ConnectionPool.withChannelSlot()
          │
          ▼
ssh2 Client.shell(PTY) -> ClientChannel

Browser Terminal Runtime
  ├── REST lifecycle/attach/resize
  ├── Terminal SSE
  ├── @xterm/xterm renderer
  └── audit timeline
```

Session deletion、Chat Run 创建和 Terminal 生命周期入口通过 `SessionLifecycleCoordinator` 建立 Session 级 barrier/lease；它只负责跨领域操作排序，不持有 PTY Channel 或复制 TerminalSession 状态。

边界要求：

- `ChatService` 不持有 PTY Channel。
- `TerminalSession` 不放进 `ChatService.ActiveRuntime`。
- Connection Pool 不理解 Observation、Agent Run 或 Terminal Mode。
- SSH adapter 不理解 Tool、Guard、Approval 或前端 timeline。
- 前端不读取 Credential，也不提交 Workspace/Connection 参数。

## 6. 领域模型

### 6.1 TerminalSession

```ts
type TerminalSessionStatus = "opening" | "active" | "closing" | "closed" | "failed" | "lost";

interface TerminalSession {
  id: string;
  sessionId: string;
  workspaceId: string;
  status: TerminalSessionStatus;
  connectionGeneration?: number;
  rows: number;
  cols: number;
  term: string;
  lastEventSequence: number;
  lastConsumerActivityAt: number;
  idleDeadlineAt?: number;
  createdAt: number;
  activatedAt?: number;
  closedAt?: number;
  closeReason?: TerminalSessionCloseReason;
}
```

TerminalSession 持久化 metadata；真实 Channel、Headless Terminal、队列、subscriber 和 ring buffer 仅存在于进程内 runtime。

### 6.2 TerminalInteraction

```ts
type TerminalInteractionAction =
  | { type: "submit"; input: string; expectation: TerminalExpectation }
  | { type: "key"; key: "CTRL_C"; expectation: TerminalExpectation }
  | { type: "observe"; expectation: TerminalExpectation };

type TerminalInteractionStatus =
  | "created"
  | "guarded"
  | "running"
  | "observed"
  | "blocked"
  | "cancelled"
  | "failed";
```

每个 Interaction 关联：

- `terminalSessionId`
- `sessionId`
- `agentRunId`
- `toolCallId`
- `action`
- `expectation`
- `status`
- 输入和 Observation sequence boundary
- failure 和时间戳

### 6.3 TerminalObservation

```ts
type TerminalObservationKind = "transcript" | "screen";
type TerminalBoundaryReason = "prompt" | "quiet" | "snapshot" | "timeout" | "output_limit" | "channel_closed";

interface TerminalObservation {
  id: string;
  interactionId: string;
  terminalSessionId: string;
  agentViewText: string;
  kind: TerminalObservationKind;
  fromSequence: number;
  toSequence: number;
  rows: number;
  cols: number;
  boundaryReason: TerminalBoundaryReason;
  truncated: boolean;
  capturedAt: number;
  deliveredAt?: number;
  processingStartedAt?: number;
}
```

`agentViewText` 是实际进入 Tool Result 的文本，不允许之后重新生成或覆盖。

### 6.4 TerminalAttachment

```ts
interface TerminalAttachment {
  id: string;
  terminalSessionId: string;
  resizeOwner: boolean;
  ownershipEpoch?: number;
  state: "bootstrapping" | "live";
  attachedAt: number;
  lastDeliveredSequence: number;
}
```

Attachment 只存在于进程内。只有已进入 `live` 且由 visible/focused 页面发出有效 focus claim 的 attachment 才能成为 resize owner；其他 attachment 是只读 follower。

## 7. 生命周期

### 7.1 Terminal Mode

```text
OFF
  └── user open -> OPENING
                      ├── success -> ACTIVE
                      └── failure -> FAILED/OFF

ACTIVE
  ├── user close -> CLOSING -> CLOSED/OFF
  ├── idle TTL eligible -> CLOSING -> CLOSED/OFF
  ├── session delete without active Run/Operation -> CLOSING -> SESSION DELETED
  ├── session delete with active Run/Operation -> reject
  ├── connection lost -> LOST/OFF
  └── backend shutdown -> LOST/OFF
```

- Terminal Mode 不以独立持久化布尔值作为事实来源；活动 TerminalSession instance 就是当前可用能力。
- Session 的有效执行模式由 TerminalSession 状态派生：仅 `active` 为 `terminal`；没有 TerminalSession 或状态为 `closing/closed/failed/lost` 时为 `command`。`opening` 是暂态，期间不能创建 Chat Run。
- TerminalSession 因 idle TTL 进入 `closing` 时，后端通过 Terminal SSE/Session 状态广播新的有效模式；前端必须自动把 Mode UI 切回普通模式。
- 服务重启不自动建立 PTY。启动恢复把数据库中遗留的 `opening/active/closing` 标成 `lost`，用户必须重新开启。

### 7.2 Chat Run binding

创建 Run 时请求增加：

```ts
serverInteractionMode: "command" | "terminal";
```

后端行为：

- `command`：注入 `remote_server_call`，`terminalSessionId = null`。
- `terminal`：必须找到当前 active TerminalSession，将其 ID 写入 Chat Run，并注入 `terminal_interaction`。
- 请求 `terminal` 但没有 active TerminalSession：返回 `409 terminal_session_unavailable`，不能静默降级。
- Run 开始后绑定不变。
- terminal-mode Run 创建时必须通过 TerminalSession actor 获取 run binding lease；Run 终态释放 lease。idle reaper 只能关闭没有 run binding lease 的 TerminalSession。
- Run 创建与 TTL close 竞争时由 actor 串行决定：Run 先获得 lease 则取消本轮 idle close；`closing` 先提交则 terminal-mode Run 返回 `409`。不能把已经提交的 terminal-mode Run 静默改成 command-mode Run。
- “自动更新执行模式”只影响尚未创建的 Run。已经运行的 Agent 不热替换 `terminal_interaction`/`remote_server_call`。

### 7.3 TerminalSession 与 Connection generation

- open 时解析一次 [`SshTargetSnapshot`](../../../packages/ssh-agent/src/application/services/ssh-target-resolver.ts)。
- TerminalSession 记录 shell Channel 所属 connection generation。
- Client close、Channel close、Workspace/Credential 失效都会结束 TerminalSession。
- Pool 后续重连只服务新 Channel；旧 TerminalSession 不跟随 generation。

## 8. SSH Channel 设计

### 8.1 应用层端口

在 [`ssh-channel-broker.ts`](../../../packages/ssh-agent/src/application/ssh-channel-broker.ts) 增加独立接口，不把 Terminal 方法混入 `RemoteCommandBroker`：

```ts
interface TerminalChannelBroker {
  open(input: OpenTerminalChannelInput): Promise<TerminalChannel>;
}

interface TerminalChannel {
  readonly connectionGeneration: number;
  readonly closed: Promise<TerminalChannelClose>;
  write(data: Uint8Array): Promise<void>;
  resize(rows: number, cols: number): Promise<void>;
  close(): Promise<void>;
}
```

输出通过 open input 的 `onData(chunk)` 回调进入 TerminalSession actor，避免 application 层引用 `ssh2.ClientChannel`。

### 8.2 复用 Channel slot

无需立刻修改 Connection Pool 的公开模型。`Ssh2TerminalChannelBroker.open()` 可以：

1. 启动一个长期 `pool.withChannelSlot()` Promise。
2. 在 `operation(context)` 内调用 `client.shell({rows, cols, term}, callback)`。
3. shell 成功后 resolve 一个应用层 `TerminalChannel` handle。
4. `operation` 自身等待 Channel close。
5. Channel close 后 `withChannelSlot()` 完成并释放 slot。

必须捕获长期 Promise 的 rejection，不能产生 unhandled rejection。若 open 尚未成功，错误拒绝 open；若已经返回 handle，错误通过 `closed` 和 TerminalSession 状态传播。

### 8.3 写入和关闭

- `write()` 必须处理 Node stream backpressure。
- 输入事件只有在写入完成语义确定后才能标记为 written。
- transport 在 write 期间丢失时，输入结果标记为 uncertain；不得重放。
- `close()` 发送 Channel close 并等待终态；超时后 destroy。
- `CTRL_C` 编码为单字节 `0x03`，不使用 shell 字符串伪造。

## 9. TerminalSession actor 与事件顺序

每个 live TerminalSession 使用一个串行 actor/队列处理所有状态变化：

- PTY output chunk
- Agent input
- semantic key
- observe capture
- resize
- attach/detach
- channel close

事件序列示例：

```text
1840 terminal.resized 80x30
1841 terminal.output <bytes>
1842 terminal.output <bytes>
1843 terminal.input Agent > dashboard
1844 terminal.output <echo>
1900 terminal.observation #17
```

不允许 output handler 直接并发修改 Headless Terminal。每个 output chunk 必须在 Headless Terminal 的 `write` callback 完成后，才成为已应用的 Canonical State 事件。

## 10. Agent Tool 契约

Tool 对外名称：`terminal_interaction`。

Tool factory 名称：`createTerminalInteractionTool()`。

Agent 不提交 `sessionId`、`terminalSessionId`、Connection 或 Channel 参数；这些全部来自 Run binding。

### 10.1 参数

```ts
type TerminalInteractionToolInput =
  | {
      action: "submit";
      input: string;
      expectation: "finite" | "interactive" | "streaming";
    }
  | {
      action: "key";
      key: "CTRL_C";
      expectation: "interactive";
    }
  | {
      action: "observe";
      expectation: "finite" | "interactive" | "streaming";
    };
```

约束：

- `submit.input` 是一次完整提交，不包含最后的 Enter。
- 内部换行允许存在，Guard 检查完整字符串。
- 后端统一把内部换行编码成终端换行，并追加最终 Enter。
- `key` 不接受任意字符串或字节。
- Tool 使用 `executionMode: "sequential"`。
- TerminalInteractionService 仍执行 one-in-flight 校验，不能只依赖 Agent Tool 调度。

### 10.2 Tool Result

Tool content 只包含已持久化的 `agentViewText`。details 包含：

```ts
interface TerminalInteractionToolDetails {
  terminalSessionId: string;
  interactionId: string;
  observationId: string;
  kind: "transcript" | "screen";
  fromSequence: number;
  toSequence: number;
  rows: number;
  cols: number;
  boundaryReason: TerminalBoundaryReason;
  truncated: boolean;
}
```

## 11. Guard 与 Approval

### 11.1 已确认

- `submit` 在真正写入 Channel 前检查完整 input。
- 与 `remote_server_call` 相同，先 preflight，再在 dispatch 前复检，避免审批等待期间 Guard 变化。
- `observe` 不写入远端，不经过 command Guard。
- `CTRL_C` 走受限 semantic key policy，不作为 shell command 交给 Guard。
- Guard blocked 时不写 PTY，也不创建成功的 TerminalInputEvent。

### 11.2 已冻结的 Approval 规则

采用方案 C：

| Terminal action | Guard | Approval |
|---|---|---|
| `submit` | 完整文本 preflight，实际写入前复检 | `autoAudit=false` 人工审批；`autoAudit=true` 自动批准并记录审计 |
| `observe` | 不检查 | 不审批 |
| `key: CTRL_C` | 受限 semantic key 白名单 | 不审批，但记录 TerminalInputEvent |

Approval pending 期间 TerminalSession 和 PTY output 继续运行，但待审批 input 不得写入。用户批准后重新执行 Guard，并从实际写入时刻建立 Observation sequence boundary。用户拒绝时不写入字节，Interaction 进入 blocked/cancelled 终态，并沿用当前 Chat Runtime 对拒绝后自动延续的收敛规则。

## 12. Observation Engine

### 12.1 状态层级

```text
PTY raw bytes
      │
      ▼
Canonical Terminal State (@xterm/headless)
      │
      ├── transcript extraction
      └── screen snapshot
      │
      ▼
immutable TerminalObservation.agentViewText
```

Raw bytes 不是 Agent Observation。Agent 不应直接接收 ANSI 控制序列。

### 12.2 Observation kind

- `finite`：优先生成 interaction 输入之后的 transcript delta。
- `interactive`：生成 transcript，并保留当前 prompt/screen 必要上下文。
- `streaming`：生成当前 screen snapshot，适用于 dashboard、top、tail 等持续刷新程序。
- `observe`：不写输入，捕获当前 screen 或自上次 Agent Observation 以来的 transcript；具体由 expectation 决定。

### 12.3 Boundary

MVP 采用 expectation 驱动的组合边界方案 C：

- prompt detection
- output quiet window
- streaming snapshot window
- max wait timeout
- output limit
- channel close

初始默认值：

| expectation | prompt settle | quiet window | snapshot window | max wait | result kind |
|---|---:|---:|---:|---:|---|
| `finite` | `150ms` | `800ms` | 不适用 | `30s` | transcript delta |
| `interactive` | `150ms` | `500ms` | 不适用 | `15s` | transcript + current screen context |
| `streaming` | 不适用 | 不适用 | `1500ms` | `3s` | current screen |

这些数值是 MVP 的服务端配置默认值，不由 Agent 在 Tool 参数中任意扩大。Arthas 联调可以基于测量调整默认值，但不能改变本节的边界语义。

Prompt detection 只用于加速返回，不能证明命令成功或远端前台进程已经退出。只有位于当前活动 cursor 行、符合已知 shell/Arthas prompt 形态，并在 `150ms` settle window 内没有新 Canonical Terminal mutation 的 candidate 才能触发 `boundaryReason="prompt"`。如果 detector 不能确认，则继续等待 quiet、limit 或 timeout。

Quiet window 从最后一次已应用到 Canonical State 的相关 output mutation 重新计时。`streaming` 的 snapshot window 是固定墙钟窗口，不能被持续 output 反复重置，否则 dashboard 一类程序会让 Tool 永不返回。

单次 Interaction 从输入实际写入后的 sequence 开始，最多观察 `256 KiB` raw output；`observe` 则从上次已交付给该 Agent Run 的 Observation sequence 开始。达到上限立即以 `boundaryReason="output_limit"` 捕获，但 PTY 和远端进程继续运行。Agent `agentViewText` 最多保留最终 `64 KiB`，必须在合法 UTF-8/Unicode 边界截断、增加明确的 earlier-output-omitted 标记并设置 `truncated=true`。screen Observation 仍以捕获时的可见 Canonical Screen 为准。

`observe` 的具体收敛规则：

- `finite`/`interactive`：存在尚未交付且已经满足 quiet/prompt 条件的输出时立即捕获；否则等待下一项对应边界。
- `streaming`：从 observe 开始等待一个固定 snapshot window，然后捕获当前 screen。
- 没有新输出时由 max wait 收敛，可以返回当前 screen，并标记 `boundaryReason="timeout"`。

同一 actor step 中多个边界同时成立时，使用固定优先级：`channel_closed`、`output_limit`、`prompt`、`snapshot`、`quiet`、`timeout`。`boundaryReason` 必须进入 Observation 和 Tool details。

任何边界都只表示“本次观察在此结束”。PTY 没有单条命令 exit event，因此 UI 和 Tool Result 不能把 `quiet`、`prompt` 或 `timeout` 表述为“命令执行完成”。sequence range 证明的是时间顺序，不证明范围内所有 output 都由刚才的 input 导致；同一 PTY 中的后台输出可能混入。

### 12.4 持久化顺序

```text
capture canonical state
  -> build agentViewText
  -> persist Observation
  -> return Tool Result derived from persisted row
  -> ChatService receives tool_execution_end
  -> mark delivered
  -> next turn_start
  -> mark processingStartedAt
```

如果 Observation 持久化失败，Tool 必须失败，不能把未审计文本交给模型。

## 13. Resize 设计

### 13.1 前端计算

前端使用 `ResizeObserver` 观察 Terminal Panel：

1. 保持字体 family、font size 和 cell 比例不变。
2. 根据容器有效像素和 cell 尺寸计算 `cols/rows`。
3. 约 200ms debounce。
4. 只有整数 `cols/rows` 变化时提交。
5. 在后端确认前不把本地 xterm 作为新权威状态。

MVP 页面不提供 Terminal Panel 拖拽手柄，Terminal 区域由固定响应式布局决定。ResizeObserver 主要响应浏览器窗口或 viewport 变化；不能让用户在页面内任意拖动 Terminal UI 制造高频 geometry 变化。

尺寸必须有后端边界，例如最小 `40x12`；最大值和默认值在实现前通过 UI 与性能测试冻结。

### 13.2 Resize owner

- 页面 attachment 完成 bootstrap 并进入 `LIVE` 后，监听 `focus`、`pageshow` 和 `visibilitychange`。
- 只有同时满足 `document.visibilityState === "visible"` 与 `document.hasFocus()` 的页面才发送一次 focus claim；blur/hidden 本身不触发另一个后台页面自动接管。
- SSE 重连或重新 bootstrap 完成后，页面必须重新评估 visible/focused 状态并补发 claim，不能依赖重连期间可能没有再次触发的 DOM focus event。
- TerminalSession actor 接受最新有效 claim，设置唯一 owner，递增 `ownershipEpoch`，广播 `terminal.resize_owner_changed`。
- 新 owner 必须先接受当前 Canonical geometry，再根据自己的固定 Terminal 容器计算并提交 resize。
- follower 不能提交 resize，只应用后端广播。其容器不匹配 Canonical geometry 时保持字体比例，通过 viewport 滚动显示；页面重新获得 focus 并被授予 ownership 后才重新适配。
- owner SSE 断开或显式 detach 后释放 ownership。没有新的 focused claim 时保持最后 geometry，不把 ownership 自动交给后台 follower。
- focus claim 是浏览器提供的协作信号，不是安全授权；真正权限仍由后端 attachment 身份和 actor 状态决定。

多标签页和多设备同时聚焦属于 MVP 接受的小概率竞争。后端只在离散 focus/visibility 事件上执行 last-writer-wins，不使用周期性 heartbeat 反复抢占，因此稳定聚焦的两个页面不会持续 resize 抖动。

### 13.3 后端顺序

一次 resize 在 TerminalSession actor 中执行：

1. 校验 session active、attachment state、`attachmentId + ownershipEpoch` 和尺寸范围。
2. 分配 terminal event sequence。
3. 更新 Headless Terminal geometry。
4. 调用 `channel.setWindow(rows, cols, pixelHeight, pixelWidth)`；像素值可以为 0，MVP 只依赖字符 geometry。
5. 更新 TerminalSession metadata。
6. 广播 `terminal.resized`。

所有订阅端必须在处理后续 output sequence 前先应用 resize event。

ownership handoff 与 resize 使用同一个 actor queue。旧 owner 即使在失焦前已经发送请求，只要请求在新 ownership epoch 之后到达，就必须被拒绝，不能按网络到达延迟覆盖新 owner geometry。

## 14. 浏览器 attach、bootstrap 与 Live Stream

### 14.1 MVP transport

MVP 推荐继续使用当前基础设施：

- REST：open、close、attach、detach、resize、status、snapshot 和 timeline query。
- SSE：TerminalSession status、resize、PTY output 和 timeline delta。
- PTY output 在 SSE 中使用 Base64。

原因：用户不能写 stdin，唯一浏览器到服务端的实时控制是低频 resize；当前服务器已有 HTTP/SSE，但没有 WebSocket upgrade。MVP 不需要仅为 resize 引入 WebSocket。未来允许人工输入时再评估独立 WebSocket。

### 14.2 无间隙 bootstrap

attach 流程：

1. 后端在 TerminalSession actor 中创建 `bootstrapping` attachment；此时不授予 resize ownership。
2. actor 等待此前 output/resize 全部应用到 Headless Terminal，在 sequence `N` 捕获 snapshot 和当前 geometry。
3. attach 响应返回 `attachmentId`、ownership、snapshot 和 `snapshotSequence=N`；`N` 之后的事件继续进入 ring buffer。
4. 前端以 snapshot 的 `rows/cols` 创建全新 xterm 实例并写入 snapshot，等待 xterm 完成应用。
5. 前端连接 SSE，请求从 `N+1` 按 sequence 重放，并在重放完成前缓存后到达的 live event。
6. replay 追平服务端声明的 sequence 后，前端调用 attachment `ready`；后端确认后双方进入 `LIVE`，visible/focused 页面此时可以发送 focus claim。
7. 后端授予 resize ownership 后，该页面才根据当前容器请求新的 geometry；不能在 snapshot 恢复前先 resize。
8. ring buffer 已丢失 `N+1` 或 replay 中发现 sequence gap 时，后端发送 `terminal.resync_required`；前端销毁未完成的显示副本并重新 bootstrap。

前端恢复状态机固定为：

```text
DETACHED
  -> ATTACHING
  -> RESTORING_SNAPSHOT
  -> REPLAYING
  -> LIVE
```

任一恢复阶段失败都不能把不完整的 xterm 标记为 Live。

### 14.3 Snapshot format

MVP 固定优先使用 `@xterm/addon-serialize` 从后端 Headless Terminal 生成 ANSI snapshot，再以 Base64 返回。外部结构至少包含：

```ts
interface TerminalSnapshotV1 {
  format: "xterm-ansi";
  formatVersion: 1;
  encoding: "base64";
  data: string;
  sequence: number;
  rows: number;
  cols: number;
}
```

`formatVersion` 版本化本系统的恢复契约，不等同于 npm package version。后端必须限制 snapshot 包含的 scrollback，避免长期 Session 生成无界响应。Snapshot 仅用于恢复浏览器 Live Terminal，不是 Agent Observation，也不持久化到数据库；服务重启后 PTY 本身不可恢复，因此持久化 snapshot 不会使旧 TerminalSession 继续可用。

恢复时必须使用 snapshot 捕获时的相同 `rows/cols`。浏览器应用 ANSI snapshot 和 replay 后，才能根据 resize owner 规则切换到新的 geometry；否则 snapshot 中的换行、cursor 和 screen 内容可能在恢复过程中被重新解释。

`@xterm/addon-serialize` 是首选实现，但仍是需要验证的依赖边界。实现前技术 spike 是阻断门槛，至少覆盖：

- 普通 shell、长行换行、CJK 宽字符、颜色和文本属性。
- cursor 位置、clear/erase、scroll region 和受限 scrollback。
- alternate screen 的进入、活动状态恢复和退出。
- Arthas dashboard 等原地刷新的 TUI。
- snapshot 捕获前后发生 resize。
- snapshot `N` 与并发 output、replay `N+1` 的无重复、无缺口衔接。
- 多 attachment owner/follower 和慢消费者 resync。
- 高输出量下的 snapshot 大小、生成耗时和 actor 阻塞时间。

验证不能只比较纯文本。测试应在相同 geometry 下比较原 Canonical Terminal 与恢复实例的可见 cell 内容、样式、cursor、active buffer 和 terminal mode，并补充浏览器视觉核对。

如果 spike 不通过，回退到后端从 Canonical State 生成完整 ANSI framebuffer snapshot。纯文本 snapshot 只能用于 Observation，不足以恢复 Live Terminal；“只重放未来 raw bytes”也不是可接受降级。

### 14.4 Ring buffer 与慢消费者

- raw output 默认只保存在内存 ring buffer，不写 SQLite。
- buffer 使用字节上限而不是只限制事件条数。
- subscriber 落后超过 buffer 时收到 `terminal.resync_required`，然后重新 bootstrap。
- 慢浏览器不得阻塞 PTY output、Headless Terminal 或 Agent Observation。

## 15. 前端产品结构

真实页面在 [`ChatConsole`](../../../packages/ssh-agent-web/features/chat/components/chat-console.tsx) 中融合：

```text
Session Chat Page
├── Header
│   ├── Run status
│   └── Terminal Mode toggle/status
├── Chat Timeline
│   └── terminal_interaction Tool Card
├── Read-only Terminal Panel
│   ├── xterm Live Terminal
│   ├── connection/geometry status
│   └── resize owner state
└── Terminal Audit Timeline
    ├── Agent Input
    ├── Observation Marker
    ├── delivered/processing state
    └── Observation Detail
```

Terminal Mode 继续复用现有 `autoAudit` 开关。前端说明文案必须明确：开启后会自动批准本地 `write`/`bash`、普通模式的 `remote_server_call`，以及 Terminal Mode 的 `terminal_interaction.submit`；Guard 仍然生效。当前 ChatConsole 中“远程命令仍需确认”的 tooltip 与后端现有 `remote_server_call` 自动审批行为不一致，进入实现时应一并校正。

建议新增前端目录：

```text
packages/ssh-agent-web/features/terminal/
├── api/terminal-api.ts
├── model/terminal.ts
├── model/terminal-runtime-state.ts
├── runtime/terminal-event-stream.ts
├── runtime/use-terminal-runtime.ts
└── components/
    ├── terminal-panel.tsx
    ├── terminal-viewport.tsx
    ├── terminal-mode-control.tsx
    ├── terminal-timeline.tsx
    └── terminal-observation-detail.tsx
```

依赖预计为：前端使用 `@xterm/xterm`；后端使用 `@xterm/headless` 和 snapshot 所需 addon。实际实现时必须固定精确版本、审查依赖和 lockfile，不在本文中预先猜测版本。

## 16. 时间线语义

### 16.1 能够证明的事实

- Agent 提交了什么 input 或 semantic key。
- input 是否通过 Guard/Approval。
- input 是否写入 Channel，或结果是否 uncertain。
- Observation 捕获了哪个 terminal sequence range。
- Observation 的 `agentViewText`、geometry 和 boundary reason。
- Tool Result 什么时候交给 Agent Loop。
- 下一次模型请求是否包含这条 Observation。

### 16.2 不能证明的事实

- 模型内部当前处理哪个 token。
- 模型正在关注屏幕哪一行。
- 模型是否理解了某段输出。

### 16.3 UI 状态

```text
captured   -> Observation 已持久化
delivered  -> terminal_interaction Tool Result 已生成并进入 Agent 消息
processing -> 下一次 turn_start 已发生，该 Observation 已进入模型请求上下文
finished   -> 下一次 assistant response 已结束或产生下一次 TerminalInteraction
```

UI 标签使用“Agent 正在处理 Observation #N”，不使用“Agent 正在读取第 N 行”。

Chat Tool Card 与 Terminal Timeline 使用 `toolCallId + interactionId + observationId` 双向跳转。

## 17. HTTP/SSE 外部契约草案

### 17.1 REST

```text
GET    /api/sessions/:sessionId/terminal
POST   /api/sessions/:sessionId/terminal/open
POST   /api/sessions/:sessionId/terminal/close

POST   /api/sessions/:sessionId/terminal/attachments
DELETE /api/sessions/:sessionId/terminal/attachments/:attachmentId
POST   /api/sessions/:sessionId/terminal/attachments/:attachmentId/ready
POST   /api/sessions/:sessionId/terminal/attachments/:attachmentId/focus
POST   /api/sessions/:sessionId/terminal/attachments/:attachmentId/resize
GET    /api/sessions/:sessionId/terminal/attachments/:attachmentId/events

GET    /api/sessions/:sessionId/terminal/timeline
GET    /api/sessions/:sessionId/terminal/observations/:observationId
```

open request 至少包含 `requestId`、初始 `rows/cols`。所有变更接口都需要严格 key 校验和运行时类型验证。

### 17.2 SSE events

```text
terminal.stream.ready
terminal.status
terminal.output
terminal.resized
terminal.resize_owner_changed
terminal.input
terminal.observation.captured
terminal.observation.delivered
terminal.observation.processing
terminal.resync_required
```

外部消息包含协议版本或兼容字段；进程内方法不需要复用 SSE Envelope。

## 18. 持久化草案

### 18.1 terminal_sessions

关键字段：

- `id`
- `session_id`
- `workspace_id`
- `status`
- `connection_generation`
- `rows`、`cols`、`term`
- `last_event_sequence`
- `last_consumer_activity_at`、`idle_deadline_at`
- `close_reason`
- `created_at`、`activated_at`、`closed_at`

数据库使用 partial unique index 保证一个业务 Session 最多一条 `opening/active/closing` TerminalSession。

### 18.2 terminal_interactions

关键字段：

- `id`
- `terminal_session_id`
- `session_id`
- `agent_run_id`
- `tool_call_id`
- `action_json`
- `expectation`
- `status`
- `input_sequence`
- `observation_id`
- `failure_json`
- 时间戳

`agent_run_id + tool_call_id` 唯一，用于 Tool 幂等和审计关联。

### 18.3 terminal_inputs

关键字段：

- `id`
- `interaction_id`
- `display_text`
- `input_kind`
- `encoded_bytes`
- `status: prepared | written | uncertain | blocked`
- `terminal_sequence`
- `guard_revision`
- `matched_guard_rule_id`
- 时间戳

这里的 Terminal Input 是 Agent 调用 `terminal_interaction` 产生的远端执行审计事实：`submit` 保存规范化后的完整 Tool `input` 和实际写入 PTY 的 bytes；`key: CTRL_C` 保存语义标签与 `0x03`；`observe` 不产生 Input。它不是用户键盘输入、模型 prompt 或 PTY output。Agent 原始 Tool arguments 已存在于 `chat_messages`；`terminal_inputs` 保存的是 harness 规范化并准备 dispatch 的事实，Interaction metadata 不再重复保存完整文本。

### 18.4 terminal_observations

关键字段与 `TerminalObservation` 一致，`interaction_id` 唯一。`agent_view_text` 作为实际 Tool content 的审计事实持久化。

### 18.5 terminal_timeline_events

持久化 Session lifecycle、Agent input、Observation marker、delivery 和 processing 状态；不持久化每个 raw output chunk。前端刷新通过该表恢复审计时间线。

## 19. 失败、取消和重启

### 19.1 Chat Run cancel

已冻结：

- 取消当前 Interaction 的 Observation wait。
- 不自动发送 `CTRL_C`。
- 不自动关闭 TerminalSession。
- 远端前台程序继续运行，用户可在下一 Run 中让 Agent observe 或显式发送 `CTRL_C`。
- 尚未写入的 input 不再写入；正在写入且结果无法确认时标记 `uncertain`，不得重放。
- 取消时尚未形成的 Observation 不自动生成。
- 已持久化的 Observation 保留，并根据实际 Tool/Agent 事件准确标记为 delivered 或 captured-not-delivered。
- 前端必须分别展示“Agent Run 已停止”和“TerminalSession 仍在运行”，不能把 Run cancel 投影成 Terminal disconnected。

### 19.2 Channel/transport loss

- TerminalSession -> `lost`。
- in-flight Interaction -> `failed` 或 `uncertain`，取决于 input 是否可能已经写入。
- 不自动重放 input。
- 当前 terminal-mode Run 后续 Tool Call 返回 terminal unavailable；不切换 Tool。
- 用户重新开启创建新 TerminalSession，通常应开始新的 Chat Run。

### 19.3 服务重启

- 遗留 `opening/active/closing` TerminalSession 标记为 `lost`，原因 `service_restarted`。
- 遗留 running Interaction 标记为 failed/uncertain。
- 不恢复 PTY、Headless Terminal 或 raw ring buffer。
- 历史 Observation 和 timeline 仍可读取。

### 19.4 Session 删除

已冻结采用受限级联：

```text
DELETE Session(expectedRevision)
  -> acquire Session deletion barrier
  -> validate Session revision
  -> reject if active Chat Run or active Command Operation exists
  -> recheck and close opening/active/closing TerminalSession
  -> wait for Channel close or bounded destroy
  -> release Terminal runtime reservations
  -> delete Session and cascaded history
  -> release deletion barrier
```

deletion barrier 是 Session 生命周期协调器中的进程内互斥状态。持有期间必须拒绝新的 Chat Run、Command Operation、Terminal open/attach/Interaction 和 Session update，避免在检查资源之后重新创建依赖项。当前单进程 MVP 在应用层排序即可；未来支持多后端实例时必须提升为数据库可见的 deletion state/lease。

具体规则：

- active Chat Run：返回 `session_has_active_chat_run`，用户先停止 Run。
- active Command Operation：保留当前 `session_has_active_operations`，不自动取消，也不把不确定的远端结果伪装成成功删除。
- TerminalSession `opening`：取消或等待 open 收敛，再进入关闭流程；不能删除数据库后让迟到的 open 返回 live handle。
- TerminalSession `active`：提交 `closing`，关闭 PTY；关闭 PTY 可能使远端前台进程收到 hangup，删除确认 UI 必须明确这个后果。
- TerminalSession 已因 TTL 或用户操作处于 `closing`：等待同一个 close Promise，不重复关闭。
- graceful close 使用有界等待；超时后 destroy Channel。只有确认进程内 handle 和 process/connection reservation 已释放后才能继续删除。

如果 Terminal 已关闭而 Session delete 因 revision conflict 或持久化错误失败，Session 继续存在，有效模式为 `command`。用户基于最新 revision 重试删除；系统不能自动重开 TerminalSession。服务在 close 后、delete 前崩溃时同样保留 Session，下次启动按现有恢复规则把遗留 Terminal 状态收敛为 `lost/closed`，然后允许幂等重试。

## 20. 错误分类草案

新增 Terminal 领域错误，不应把所有错误折叠成现有 command execution failure：

```text
terminal_session_not_found
terminal_session_already_active
terminal_session_unavailable
terminal_session_lost
terminal_session_closing
terminal_capacity_exceeded
terminal_connection_capacity_exceeded
terminal_attachment_capacity_exceeded
terminal_interaction_busy
terminal_interaction_cancelled
terminal_input_blocked
terminal_input_uncertain
terminal_resize_not_owner
terminal_resize_invalid
terminal_snapshot_unavailable
terminal_resync_required
terminal_observation_limit_exceeded
terminal_persistence_failed
```

HTTP status、Tool Error termination 和 retryable 语义在实现前逐项冻结。

Session 管理领域增加 `session_deletion_in_progress`，用于 deletion barrier 已建立后到达的新请求；活动 Run 和 Operation 继续使用现有冲突错误。

## 21. 运行时装配

[`create-sqlite-management-backend.ts`](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) 需要新增并按顺序关闭：

```text
Terminal repositories
TerminalChannelBroker
TerminalEventHub
TerminalInteractionService
TerminalSessionService
Terminal Tool factory
HTTP routes
```

关闭顺序要求：

1. 停止接受 open/interaction/resize。
2. 取消 Observation wait。
3. 关闭所有 TerminalSession Channel。
4. 持久化终态。
5. 关闭 Terminal event subscribers。
6. 最后关闭 Connection Pool 和数据库。

## 22. 分阶段实现

### Phase 1：Terminal Channel 与 Headless State

- 应用层 TerminalChannelBroker port。
- ssh2 shell + PTY adapter。
- TerminalSession actor。
- Headless Terminal canonical state。
- open/close、output、resize 的后端测试。

### Phase 2：Session lifecycle、持久化与 REST/SSE

- Terminal tables/repositories。
- open/close/status/attach/bootstrap/resize API。
- Terminal SSE、ring buffer、resync。
- 服务重启和 Connection loss 收敛。

### Phase 3：Agent Tool 与 Observation

- `terminal_interaction` Tool。
- Tool 集合互斥和 Chat Run binding。
- Guard/Approval。
- Observation Engine、持久化优先和 timeline correlation。

### Phase 4：真实前端

- xterm read-only panel。
- Terminal Mode control。
- attachment、snapshot、SSE 和 resize owner。
- Terminal timeline、Observation detail 和 Chat Tool Card 跳转。

### Phase 5：Arthas 验收

```text
open Terminal Mode
-> start arthas
-> choose JVM
-> thread -n 5
-> dashboard
-> observe refreshed screen
-> CTRL_C
-> return to arthas prompt
-> Chat Run ends, TerminalSession remains active
```

## 23. 测试策略

### 23.1 单元测试

- TerminalSession state machine。
- actor ordering。
- resize ownership 和 event ordering。
- focused attachment claim、ownership epoch 和迟到 resize rejection。
- input encoding、Guard 和 semantic key policy。
- Observation boundary 和 truncation。
- Tool schema/result。
- persistence recovery。
- Session deletion barrier、受限级联和 close 后 delete 失败收敛。

### 23.2 集成测试

- faux TerminalChannelBroker，不访问真实服务器或模型。
- Chat Run 在两种模式下注入互斥 Tool。
- TerminalSession 丢失后不 fallback。
- Observation 持久化失败时 Tool 不返回文本。
- refresh bootstrap 无 sequence gap。
- follower resize 被拒绝。
- 多 tab focus handoff 不产生旧 epoch resize。
- Session delete 与 Run 创建、Terminal open、TTL close 的竞争排序。

### 23.3 真实 SSH 测试

- 最终前端和真实 SSH 验收使用现有 Session `terminal-interaction-test`，复用其中已安装的 Java 应用与 Arthas；测试只解析现有 Session 配置，不把凭据写入源码、fixture、日志或本文档。
- `ssh2 client.shell()` PTY。
- Channel 长期占用和 release。
- Shell echo、ANSI、alternate screen。
- `setWindow()` 后 Shell wrap 与 Arthas dashboard 重绘。
- transport loss、Credential/Workspace invalidation。
- Arthas 完整验收链路。

### 23.4 前端测试

- mode toggle 在 active Run 时禁用。
- snapshot -> replay 顺序。
- 浏览器 viewport ResizeObserver debounce、focused owner/follower 和无拖拽手柄。
- resync_required 后完整重建。
- Observation marker 不写入 xterm buffer。
- Chat Tool Card 与 terminal timeline 双向定位。

## 24. 资源与可观测性

### 24.1 MVP 默认资源上限

实现时所有后端 Terminal 默认值统一放入独立只读静态常量文件 `packages/ssh-agent/src/application/terminal/terminal-defaults.ts`。前端只在 `packages/ssh-agent-web/features/terminal/model/terminal-ui-defaults.ts` 保存浏览器专属默认值；服务端 geometry、限制和 timing 通过 API/SSE 下发，前端不得复制。Service、Actor、Route、component 和测试中禁止散落生产默认数字。

| 资源 | 默认值 | 超限行为 |
|---|---:|---|
| 每业务 Session `opening/active/closing` TerminalSession | `1` | `terminal_session_already_active` |
| 每进程 `opening/active/closing` TerminalSession | `16` | `terminal_capacity_exceeded` |
| 每个 Connection generation TerminalSession | `4` | `terminal_connection_capacity_exceeded` |
| 每 TerminalSession raw ring buffer | `2 MiB` | 淘汰最旧事件，落后 attachment resync |
| Headless Terminal scrollback | `2000` 行 | 丢弃更早 scrollback，不影响当前 screen |
| 每 TerminalSession attachment | `4` | `terminal_attachment_capacity_exceeded` |
| 每 SSE subscriber pending bytes | `512 KiB` | 终止该增量流并要求重新 bootstrap |
| Terminal open deadline | `30s` | `failed`，`terminal_open_timeout`，释放 runtime 与 Channel reservation |
| idle TTL | `2h` | 通过 actor 进入 `closing`，原因 `idle_timeout` |

进程和 Connection capacity 必须在打开 SSH Channel 前原子预留，并持续计入 `closing`，直到 Channel 关闭和 runtime 终结后才释放。open 任一步骤失败都释放已经取得的 reservation。长期资源不进入等待容量释放的队列；达到上限时快速失败。

每个 Connection 的 TerminalSession 上限独立于 Connection Pool 总 Channel 上限。当前默认 8 个 Channel 时只允许 4 个长期 PTY，给其他 Session 的 exec、SFTP 等短期 Channel 留出空间；总 Channel 限制仍由 Connection Pool 最终执行。

### 24.2 idle TTL eligibility

TerminalSession 只有同时满足以下条件时才进入 idle 计时：

- 没有 live attachment。
- 没有 active Chat Run binding lease。
- 没有 in-flight TerminalInteraction。

用户 attach、Chat Run 成功绑定或 TerminalInteraction 开始会清除当前 `idleDeadlineAt` 并刷新 `lastConsumerActivityAt`。最后一个 consumer 离开后设置 `idleDeadlineAt = now + 2h`。PTY raw output 不算 consumer activity，否则无人消费的 `tail -f` 或 dashboard 会永久规避回收。

idle reaper 可以每 `60s` 扫描一次候选，但 deadline 只表示“允许尝试关闭”。真正关闭必须回到 TerminalSession actor 中重新检查 status、attachment、run lease、Interaction 和 deadline，并以 compare-and-set 执行 `active -> closing`。检查失败则放弃本次回收，不允许先关闭 Channel 再修正状态。

`closing` 提交后按以下顺序收敛：

```text
persist active -> closing with idle_timeout
  -> publish terminal.status + effective mode command
  -> reject new attach/interaction/terminal run binding
  -> close PTY Channel
  -> persist closing -> closed
  -> release process/connection reservations
```

### 24.3 自动执行模式更新

有效执行模式是 TerminalSession 状态的投影，不额外维护一个可能失真的 Session 布尔值：

```text
TerminalSession active               -> terminal
opening                              -> transitional, Run creation disabled
closing/closed/failed/lost/不存在     -> command
```

前端监听 Terminal SSE/Session 状态并自动更新 Mode UI。TTL 与 Run 创建通过 actor 和 run binding lease 排序，因此不会关闭正在被 Chat Run 使用的 TerminalSession。

如果 `closing` 已先提交，而前端仍用旧状态提交 `serverInteractionMode="terminal"`，后端返回 `409 terminal_session_unavailable` 并携带当前有效模式。前端刷新状态后可以重新提交普通模式 Run；后端不能把已提交的 terminal-mode Run 静默降级，也不能在活动 Agent 内替换 Tool。

### 24.4 指标

至少记录：

- process/connection terminal reservation 使用量和 capacity rejection。
- attachment 数量、慢消费者和 resync 数量。
- raw ring buffer 使用量、eviction、snapshot 大小和 subscriber pending bytes。
- open/close/idle_timeout/lost 数量与 TerminalSession 持续时间。
- Interaction latency、boundary reason、timeout 和 output bytes。
- resize rate、effective mode transition 和 Run/TTL race 结果。

长期 PTY 会长期占用 Connection Channel slot，因此硬上限和可观测性不是可选优化。

## 25. 实现前验证项

MVP 的产品语义和总体架构问题已经冻结，可以进入技术/代码细节设计。实现前仍需通过技术 spike、测试或依赖审查确定的数值与实现门槛包括：

- `@xterm/addon-serialize` 的兼容性和自定义 ANSI serializer 回退条件。
- xterm 精确依赖版本、scrollback 实际内存、snapshot 大小和性能。
- PTY graceful close timeout、geometry 最大值和各 HTTP error status。
- Arthas 联调后对 Observation 时间默认值的测量调整。

这些项目不能推翻已冻结语义；如果验证结果要求改变领域边界或用户行为，必须重新进入设计讨论。

## 26. 文档维护

- 本文在功能代码实现前是设计讨论基线。
- 开始实现新 Terminal 功能区域时，必须在 `docs/ssh-agent/ai-repo/` 新增聚焦的 feature document，在 `index.md` 增加入口，并在 `manifest.json` 映射真实源文件。
- 每次修改已映射的 Terminal 源码后，按根目录 `AGENTS.md` 要求重新核对 feature document 并刷新 digest。
- 进度记录只能描述历史，不替代本文或源码。

## 27. 变更记录

- 2026-08-27：基于原始 MVP 设计、当前真实代码和本轮讨论建立首版技术设计基线。
- 2026-08-27：冻结 Approval 方案 C；`submit` 复用 Session `autoAudit`，`observe` 和白名单 `CTRL_C` 免审批。
- 2026-08-27：冻结 Chat Run cancel 方案 A；只取消 Agent/Interaction，不发送 `CTRL_C`，不影响长期 TerminalSession。
- 2026-08-28：冻结 Terminal Snapshot；采用按需 ANSI Snapshot、原 geometry 恢复、Ring Buffer Replay 和 gap 强制 resync，serialize addon 需通过实现门槛，不通过则回退自定义 ANSI serializer。
- 2026-08-28：冻结 Observation Boundary 方案 C；按 expectation 组合 prompt、quiet、snapshot、max wait 和 output limit，所有边界只结束 Interaction wait，不代表远端进程完成。
- 2026-08-28：冻结 Resource 方案 B；采用资源硬上限和 `2h` idle TTL，通过 consumer lease、`closing` 状态和派生 effective mode 保证自动回收与模式切换一致性。
- 2026-08-28：冻结 Session 删除方案 B 受限级联；活动 Run/Operation 阻止删除，Terminal 自动有界关闭，deletion barrier 阻止并发重建依赖资源。
- 2026-08-28：冻结 Resize owner 方案 B；visible/focused tab 以离散 claim 获得 ownership，epoch 拒绝旧 owner 请求，MVP 不提供 Terminal Panel 拖拽调整。
- 2026-08-28：冻结实现参数清单；所有默认值集中到后端权威静态常量和前端 UI 静态常量文件，明确 Terminal Input 是 Agent Tool 提交并写入 PTY 的审计事实。
- 2026-08-28：冻结 Agent Tool 持久化边界；`terminal_interaction` 沿用普通 Tool call/result 和现有 Chat Message 长期持久化，Terminal 领域表只补充 harness 执行事实。
