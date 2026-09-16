# Agent Terminal Interaction：前后端联合实现设计

状态：产品、架构和实现参数已冻结，MVP 已在当前代码库完成实现与端到端验证

适用范围：SSH Agent MVP

产品与架构基线：[terminal-interaction-layer.md](./terminal-interaction-layer.md)

## 1. 文档目的

本文把已经冻结的产品和架构结论展开为可直接进入开发的技术设计。它回答以下问题：

- 现有后端、Agent Runtime、SSH Pool、SQLite、HTTP/SSE 应在什么位置接入；
- 需要新增或修改哪些文件；
- 领域类型、状态机、数据库表、REST/SSE 契约和并发边界是什么；
- Agent Tool 如何审批、执行、观察，并与 Chat Run 生命周期解耦；
- 前端如何只读展示同一个远端 PTY，并实现聚焦页面 resize owner；
- 如何分阶段交付和验证，避免前后端跨会话分别实现后产生协议漂移。

本文不授权代码实现。所有 TypeScript 和 SQL 片段都是拟定契约，不是现有实现。

## 2. 已冻结结论

以下结论不再作为实现阶段的开放问题：

1. 一个业务 `Session` 同一时间最多有一个 `opening | active | closing` 的 `TerminalSession`，一个 `TerminalSession` 只占用一个 PTY Channel。
2. Terminal 是独立业务领域；底层复用 Connection Pool 和 Channel slot，上层独立管理生命周期、观察、订阅和 Agent Tool。
3. Terminal Mode 只能由用户手动开启或关闭，Agent 无权开启或关闭。
4. Chat Run 创建时冻结服务器交互模式：
   - Command Mode：提供 `remote_server_call`；
   - Terminal Mode：移除 `remote_server_call`，提供 `terminal_interaction`；
   - 两种模式都保留本地工具和 SFTP 工具；
   - Run 运行期间不热切换 Tool 集合。
5. 用户只能只读查看 Terminal；MVP 不向浏览器开放键盘、粘贴或命令发送。
6. 后端 headless xterm 是唯一 Canonical Terminal State。浏览器是远程投影，不构造第二份权威语义状态。
7. PTY resize 使用前后端同步方案。MVP 不提供 Terminal UI 拖动手柄；浏览器窗口、viewport 或固定响应式布局改变时可触发 resize。
8. 当前可见且聚焦的页面可以声明 resize owner。最新离散声明成功的页面成为 owner；失焦或隐藏后主动释放，不自动选举后台页面。
9. `submit` 沿用 `Session.autoAudit` 审批逻辑并执行 guard 预检和写入前复检；`observe` 与 `CTRL_C` 不逐条审批。
10. Chat Run 取消只终止 Agent 和正在等待的 interaction，不关闭 PTY，也不自动发送 `CTRL_C`。
11. Chat Run 无权关闭 TerminalSession；用户可以手动关闭，系统还会按已冻结的 idle TTL 回收，进程关闭或连接丢失则进入 `lost`。
12. Session 删除采用受限级联：活动 Chat Run 或 Command Operation 阻止删除；仅有 Terminal 时先关闭 Terminal，再删除 Session。
13. 原始 Terminal 输出仅保存在进程内；Observation、Input 审计事实和 Timeline 持久化到 SQLite。
14. MVP 继续使用 REST + SSE，不引入 WebSocket。
15. `terminalContextCursor` 是旧设计遗留，MVP 不使用。
16. 对 Agent 而言 `terminal_interaction` 是普通 Tool；所有 Tool 的原始 input 和最终 result 都由现有 Chat Message 机制长期持久化，Terminal 领域表只补充 harness 执行事实。

## 3. 现有代码接入点

### 3.1 后端

| 现有文件 | 当前职责 | Terminal 接入方式 |
| --- | --- | --- |
| `src/application/services/chat-service.ts` | 创建 Run、装配 Tool、审批、Agent 事件持久化、取消 | 冻结 Run 交互模式；按模式装配 Tool；接入 Terminal 审批和 Observation 时间线 |
| `src/application/ssh-channel-broker.ts` | 应用层 SSH Channel 端口 | 在同一端口文件增加独立 `TerminalChannelBroker` 接口，不混入 `RemoteCommandBroker` |
| `src/infrastructure/ssh/ssh2-channel-broker.ts` | 现有短命令 Channel 适配器 | 仅作为错误处理和 Pool 调用范式参考；PTY 由新的长生命周期 adapter 实现 |
| `src/infrastructure/ssh/ssh2-connection-pool.ts` | Connection generation、Channel slot、资源限制 | PTY 的整个生命周期持有 slot；复用 generation 销毁语义 |
| `src/application/services/session-service.ts` | Session CRUD | 删除前进入生命周期屏障，并执行受限级联 |
| `src/application/services/command-operation-service.ts` | 短命令操作 | 在创建操作前持有 Session 使用租约，防止与删除竞态 |
| `src/application/chat-run-event-stream.ts` | Chat Run SSE 历史和订阅 | 不直接复用；Terminal 需要按字节限制和 gap 恢复的事件流 |
| `src/infrastructure/sqlite/migrations.ts` | SQLite schema migration | 在当前最新版本后追加 migration，不修改历史 migration |
| `src/api/http-handler.ts` | 顶层 REST/SSE 路由 | 委托新的 Terminal route handler，避免继续膨胀单文件 |
| `src/runtime/create-sqlite-management-backend.ts` | 依赖装配 | 创建 Repository、Registry、Service、Route，并定义关闭顺序 |
| `src/server/ssh-agent-server.ts` | Server 生命周期 | 支持异步 drain/close，先关闭 Terminal 再关闭数据库和 HTTP |

### 3.2 前端

| 现有文件 | 当前职责 | Terminal 接入方式 |
| --- | --- | --- |
| `features/chat/components/chat-console.tsx` | Chat 主界面 | 增加固定响应式 Chat + Terminal 布局，不增加拖动手柄 |
| `features/chat/runtime/use-chat-runtime.ts` | Chat Run 创建和 SSE | 创建 Run 时提交冻结后的交互模式；关联 Terminal Tool 时间线 |
| `features/chat/model/chat.ts` | Chat/Tool 类型 | 保留 Tool result `details`，存储 Terminal Observation 引用 |
| `features/chat/model/chat-runtime-state.ts` | Chat reducer/hydration | 不丢弃 Terminal Tool details；处理 Run 模式冲突 |
| `features/chat/components/chat-message.tsx` | Tool card | 展示 Terminal action、Observation 摘要和时间线定位入口 |
| `features/session/components/session-delete-dialog.tsx` | Session 删除确认 | 展示 Terminal 将被关闭的后果；处理活动 Run/Operation 阻塞 |

## 4. 目标模块和文件布局

### 4.1 后端新增文件

```text
packages/ssh-agent/src/
  domain/
    terminal.ts
  application/
    repositories/
      terminal-repository.ts
    services/
      session-lifecycle-coordinator.ts
      terminal-session-service.ts
      terminal-interaction-service.ts
    terminal/
      terminal-defaults.ts
      terminal-runtime-registry.ts
      terminal-session-actor.ts
      terminal-event-stream.ts
      terminal-observation-engine.ts
      terminal-replay-ring.ts
    tools/
      terminal-interaction-tool.ts
  infrastructure/
    sqlite/
      sqlite-terminal-repository.ts
    ssh/
      ssh2-terminal-channel-broker.ts
  api/
    terminal-contracts.ts
    terminal-request-validation.ts
    terminal-routes.ts
```

### 4.2 后端修改文件

```text
packages/ssh-agent/src/domain/ids.ts
packages/ssh-agent/src/domain/chat.ts
packages/ssh-agent/src/domain/errors.ts
packages/ssh-agent/src/application/repositories/chat-repository.ts
packages/ssh-agent/src/application/management-api.ts
packages/ssh-agent/src/application/services/chat-service.ts
packages/ssh-agent/src/application/services/session-service.ts
packages/ssh-agent/src/application/services/command-operation-service.ts
packages/ssh-agent/src/application/ssh-channel-broker.ts
packages/ssh-agent/src/infrastructure/sqlite/migrations.ts
packages/ssh-agent/src/infrastructure/sqlite/rows.ts
packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts
packages/ssh-agent/src/api/contracts.ts
packages/ssh-agent/src/api/http-handler.ts
packages/ssh-agent/src/api/request-validation.ts
packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts
packages/ssh-agent/src/server/environment.ts
packages/ssh-agent/src/server/node-http-server.ts
packages/ssh-agent/src/server/ssh-agent-server.ts
packages/ssh-agent/src/server/main.ts
packages/ssh-agent/src/index.ts
packages/ssh-agent/package.json
package-lock.json
```

### 4.3 前端新增文件

```text
packages/ssh-agent-web/features/terminal/
  api/
    terminal-api.ts
  components/
    terminal-panel.tsx
    terminal-viewport.tsx
    terminal-mode-control.tsx
    terminal-status-bar.tsx
    terminal-timeline.tsx
    terminal-observation-detail.tsx
  model/
    terminal.ts
    terminal-ui-defaults.ts
    terminal-runtime-state.ts
  runtime/
    terminal-event-stream.ts
    use-terminal-runtime.ts
```

### 4.4 前端修改文件

```text
packages/ssh-agent-web/features/chat/components/chat-console.tsx
packages/ssh-agent-web/features/chat/components/chat-message.tsx
packages/ssh-agent-web/features/chat/api/chat-api.ts
packages/ssh-agent-web/features/chat/model/chat.ts
packages/ssh-agent-web/features/chat/model/chat-runtime-state.ts
packages/ssh-agent-web/features/chat/runtime/use-chat-runtime.ts
packages/ssh-agent-web/features/session/components/session-delete-dialog.tsx
packages/ssh-agent-web/app/globals.css
packages/ssh-agent-web/package.json
package-lock.json
```

命名可以在实现时小幅调整，但领域边界不能退回到 `ChatService`、`http-handler.ts` 或 React 单组件内部。

## 5. 领域模型

### 5.1 标识符

沿用当前代码的字符串 ID 风格，在 `domain/ids.ts` 增加：

```ts
export type TerminalSessionId = string;
export type TerminalInteractionId = string;
export type TerminalInputId = string;
export type TerminalObservationId = string;
export type TerminalAttachmentId = string;
```

### 5.2 TerminalSession

```ts
export type TerminalSessionStatus =
  | "opening"
  | "active"
  | "closing"
  | "closed"
  | "failed"
  | "lost";

export interface TerminalGeometry {
  readonly rows: number;
  readonly cols: number;
}

export interface TerminalSession {
  readonly id: TerminalSessionId;
  readonly sessionId: SessionId;
  readonly workspaceId: WorkspaceId;
  readonly status: TerminalSessionStatus;
  readonly revision: number;
  readonly geometry: TerminalGeometry;
  readonly eventSequence: number;
  readonly ownershipEpoch: number;
  readonly connectionGeneration: number | null;
  readonly term: "xterm-256color";
  readonly activatedAt: string | null;
  readonly lastConsumerActivityAt: string;
  readonly idleDeadlineAt: string | null;
  readonly closingAt: string | null;
  readonly closedAt: string | null;
  readonly closeReason: TerminalCloseReason | null;
  readonly failureCode: string | null;
  readonly failureMessage: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}
```

`lastConsumerActivityAt` 由明确的 consumer 活动刷新：attachment 创建/恢复、Chat Run 成功绑定、TerminalInteraction 开始，以及 owner 的 focus/resize。最后一个 attachment、run binding 和 in-flight interaction 离开后设置 `idleDeadlineAt = now + idleTtl`。远端 PTY 自己产生输出不刷新 TTL。

### 5.3 TerminalInteraction

```ts
export type TerminalInteractionAction =
  | { readonly type: "submit"; readonly input: string }
  | { readonly type: "key"; readonly key: "CTRL_C" }
  | { readonly type: "observe" };

export type TerminalInteractionStatus =
  | "prepared"
  | "awaiting_approval"
  | "approved"
  | "writing"
  | "observing"
  | "completed"
  | "rejected"
  | "cancelled"
  | "failed"
  | "write_uncertain";

export type TerminalObservationExpectation =
  | "finite"
  | "interactive"
  | "streaming";
```

每次 Tool call 对应一个 Interaction。`agentRunId + toolCallId` 唯一，重试只能读取既有结果，不能重复写入 PTY。

### 5.4 有效服务器交互模式

```ts
export type ServerInteractionMode = "command" | "terminal";

export interface ChatRunServerInteraction {
  readonly mode: ServerInteractionMode;
  readonly terminalSessionId: TerminalSessionId | null;
}
```

Session 不保存一个可以漂移的独立布尔值。有效模式由 Terminal 状态派生：

| 当前 Terminal 状态 | 有效模式 | 是否允许创建 Chat Run |
| --- | --- | --- |
| 无、`closed`、`failed`、`lost` | `command` | 是 |
| `opening` | 过渡态 | 否，返回 `terminal_transition_in_progress` |
| `active` | `terminal` | 是 |
| `closing` | `command` | 是；只允许创建 Command Mode Run |

前端创建 Run 时必须显式提交它当前展示的 `serverInteractionMode`。后端将请求值与有效模式比较；不一致返回冲突，不静默降级，也不替换 Tool。

### 5.5 状态转换

```text
none/closed/failed/lost
        │ user open
        ▼
     opening ───── open failed ────► failed
        │ shell ready
        ▼
      active ───── channel lost / backend shutdown ───► lost
        │ user close / TTL / deletion barrier
        ▼
      closing ───── cleanup done ──► closed
```

规则：

- `opening | active | closing` 在同一个 Session 上最多一条；由数据库部分唯一索引和应用层生命周期屏障双重保证。
- `failed | lost | closed` 是终态，不能复活；再次打开创建新的 TerminalSession ID。
- 远端 shell 正常退出进入 `closed`；连接 generation 被销毁或 backend shutdown 进入 `lost`。
- 状态变更使用 compare-and-set，旧 actor 不得覆盖新状态。

## 6. Session 生命周期协调器

### 6.1 问题

当前 Session 删除只需面对较短的操作。Terminal、Chat Run 和删除会跨越多个异步边界：如果只在请求开始检查一次，就可能出现“删除检查通过后，另一请求又创建 Run 或输入”的竞态。

### 6.2 方案

新增进程内 `SessionLifecycleCoordinator`。MVP 是单进程，因此不引入分布式锁。

```ts
export interface SessionUseLease {
  release(): void;
}

export interface SessionDeletionBarrier {
  release(): void;
}

export interface SessionLifecycleCoordinator {
  acquireUse(sessionId: SessionId, kind: SessionUseKind): SessionUseLease;
  acquireDeletionBarrier(sessionId: SessionId): Promise<SessionDeletionBarrier>;
  getUsage(sessionId: SessionId): SessionUsageSnapshot;
}
```

`acquireUse` 在删除屏障存在时失败。删除屏障串行化以下过程：

1. 阻止新的 Command Operation、Chat Run、Terminal open、Tool input、attachment 创建和 Session update；
2. 查看现有长短生命周期使用者；
3. 若存在活动 Chat Run，释放屏障并返回 `409 session_has_active_chat_run`；若存在 Command Operation，返回现有 `409 session_has_active_operations`；
4. 若只存在 Terminal，执行关闭并等待资源释放；
5. 删除 Session；
6. 释放屏障。

如果 Terminal 已关闭，但 Session delete 因 revision conflict 或持久化错误失败，Session 保留且有效模式为 `command`。释放屏障后用户可基于最新 revision 重试；系统不能自动重开 Terminal。close 后、delete 前进程崩溃也按相同原则在启动恢复时收敛。

租约持有范围：

- Chat Run：从 `createRun` 通过全部校验并准备持久化前开始，直到 `executeRun` finally；
- Command Operation：从创建记录前开始，直到运行结束；
- Session update：从 revision 校验前到事务提交/回滚；
- TerminalSession：从 `opening` 持有到 `closed | failed | lost`；
- Terminal Tool input：使用 TerminalSession 的长期租约，不另行阻止删除；actor 串行化 close 与 input；
- attachment：不阻止 Session 删除，删除屏障会主动断开。

### 6.3 关键竞态

| 竞态 | 结果 |
| --- | --- |
| 删除先取得屏障，Run 随后创建 | Run 返回 `session_deletion_in_progress` |
| Run 先取得租约，删除随后开始 | 删除返回 `session_has_active_chat_run` |
| 删除与 Terminal open 并发 | 先取得协调器权利的一方完成，另一方冲突 |
| close 与 submit 并发 | actor 按收到顺序处理；close 后的 submit 返回 `terminal_session_closing` |
| TTL 与用户动作并发 | actor 在执行 TTL close 前重新读取 activity/lease；新动作使本轮回收失效 |

## 7. Terminal 打开、关闭和恢复

### 7.1 打开

打开是异步操作：HTTP 请求不能持有到 SSH shell 完成或超时。

```http
POST /api/sessions/:sessionId/terminal/open
```

```ts
interface OpenTerminalRequest {
  readonly requestId: string;
  readonly rows?: number;
  readonly cols?: number;
}
```

建议 MVP 默认值：`rows=36`、`cols=120`；合法范围：`12..120` 行、`40..320` 列。后端是最终校验者。

处理顺序：

1. 严格解析 body，拒绝未知字段；
2. 获取 Session 使用租约，检查 Session/SSH target，并确认没有 active Chat Run；Command Operation 不影响用户切换未来 Run 的 Mode；
3. 原子预留进程级容量；Connection generation 级容量在 broker 取得 generation 后、打开 shell 前快速检查；
4. 在事务内以 `requestId` 幂等创建 `opening` 记录；
5. 返回 `202`；
6. 后台创建 actor、headless xterm、replay ring 和 SSH PTY Channel；
7. `shell` ready 后 compare-and-set 为 `active`，发布状态事件；
8. 失败则先把可证明的失败状态写为 `failed`，随后在 finally 释放已取得的 Channel handle 和 reservation；持久化本身失败也必须释放资源并记录结构化错误。

重复相同 `requestId` 返回同一 TerminalSession。Session 已有另一个非终态 Terminal 时返回 `409 terminal_session_already_active`。

### 7.2 关闭

```http
POST /api/sessions/:sessionId/terminal/close
```

```ts
interface CloseTerminalRequest {
  readonly requestId: string;
  readonly terminalSessionId: string;
}
```

必须带 `terminalSessionId`，防止旧页面关闭后来新建的 Terminal。

关闭顺序：

1. actor 串行化 `BeginClose`；
2. compare-and-set `active | opening -> closing`；
3. 停止接受新的 input、Run binding、attachment 和 ownership claim；
4. 取消正在等待 observation 的 Tool call，但不发送 `CTRL_C`；
5. 通知订阅者 `closing`；
6. 对 shell channel 执行 graceful close；
7. 建议等待上限 5 秒，未完成则 `destroy()`；
8. compare-and-set 写为 `closed` 并发送最后一个 `terminal.status`；
9. dispose Channel handle，释放通用 slot 和 connection Terminal reservation；随后由 registry 释放 process reservation，再释放 headless xterm、ring、租约并关闭 SSE。

关闭请求返回 `202`，前端根据 SSE 或 status polling 等待终态。

用户 close 仍必须尊重 run binding lease：存在 active Chat Run 时返回 `session_has_active_chat_run`，用户先停止 Run，再重新关闭 Terminal。关键不变量是 Chat Run 自己无权关闭 Terminal；Run cancel 只释放 binding，不隐式触发 close。TTL 同样必须等待无 run binding，Session delete 遇到 active Run 也必须拒绝。

### 7.3 进程恢复

原始输出和 PTY 不能跨后端重启恢复。启动时：

1. 将数据库中遗留的 `opening | active | closing` compare-and-set 为 `lost`；
2. 记录 `backend_restarted` Timeline 事件；
3. Session 有效模式恢复为 `command`；
4. 用户可手动打开新的 TerminalSession；
5. 不伪造旧输出，不尝试自动重连 shell。

## 8. SSH PTY Channel 端口

### 8.1 应用层端口

```ts
export interface TerminalChannelCallbacks {
  readonly onData: (chunk: Uint8Array) => void;
}

export interface OpenTerminalChannelRequest {
  readonly target: SshTargetSnapshot;
  readonly geometry: TerminalGeometry;
  readonly term: "xterm-256color";
  readonly signal: AbortSignal;
  readonly callbacks: TerminalChannelCallbacks;
}

export interface TerminalChannelHandle {
  readonly connectionGeneration: number;
  readonly closed: Promise<TerminalChannelExit>;
  write(data: Uint8Array): Promise<void>;
  resize(geometry: TerminalGeometry): Promise<void>;
  setReadPaused(paused: boolean): void;
  close(): Promise<void>;
  dispose(): void;
}

export interface TerminalChannelBroker {
  open(request: OpenTerminalChannelRequest): Promise<TerminalChannelHandle>;
}
```

`signal` 来自 TerminalSession runtime 自己的 lifetime controller，不复用已经返回的 HTTP request signal。用户 close、opening cancel 或 backend shutdown 可以 abort 仍在等待 Connection/Channel 的 open；active Channel 的正常关闭走 handle.close/dispose。

### 8.2 ssh2 映射

- 使用 `client.shell({ term, rows, cols, height: 0, width: 0 }, callback)`；
- resize 使用 `ClientChannel.setWindow(rows, cols, 0, 0)`；
- `setWindow` 没有远端确认，因此 `terminal.resized` 表示后端已按 actor 顺序调用，不表示服务器已确认；
- input write 必须处理 Node stream backpressure，`write()` 返回 false 时等待 `drain`；
- PTY stdout 和可能存在的 channel stderr 都由 infrastructure 合并到 `onData`，再进入同一个 actor mailbox；
- channel close、error、exit 只允许完成一次。
- `setReadPaused` 只控制 SSH readable stream 的 pause/resume，不改变远端 PTY 状态；actor 用它实现有界背压。

### 8.3 Channel slot 生命周期

现有 Connection Pool 的 `withChannelSlot` 是一个 scope。PTY 不能在 `open()` 返回时释放 scope，因此 infrastructure 需要创建一个由 channel 终态 resolve 的 lifetime Promise：

```text
withChannelSlot(target, async client => {
  channel = await openShell(client)
  exposeHandle(channel)
  await channelLifetime
})
```

`TerminalChannelHandle.close` 在 infrastructure 内执行最多 5 秒的 graceful close，超时后 destroy，并完成 `closed`。actor 持久化终态后在 finally 调用幂等 `dispose()`；只有此时 `channelLifetime` 才结束并释放通用 Channel slot 与 Connection Terminal reservation。Connection generation 被销毁时先通过 `closed` 通知 actor `lost`，随后同样等待 actor dispose。若 open 尚未把 handle 交给 actor就失败，broker 必须自行 dispose。不得为 PTY 绕过现有 Channel 配额。

进程级 16 个 Terminal reservation 由 `TerminalRuntimeRegistry` 在创建数据库记录前原子预留，并在所有终态路径释放。每 Connection generation 4 个 PTY 的限制由 `Ssh2TerminalChannelBroker` 在 `withChannelSlot` 得到 `connection key + generation` 后，用进程内计数器预留；预留失败立即退出 operation 并释放通用 Channel slot。Terminal 专属容量不排队，达到上限快速失败。计数器在 lifetime finally 中释放，不能依赖正常 close 单一路径；process/connection Terminal reservation 持续计入 `closing`，直到 actor 持久化终态并 dispose handle。

## 9. TerminalSession Actor

### 9.1 单写者原则

每个活跃 TerminalSession 对应一个 actor。只有 actor 可以修改：

- headless xterm；
- replay ring；
- Terminal event sequence；
- geometry；
- resize owner 和 ownership epoch；
- attachment 集合；
- interaction boundary；
- TerminalSession 运行状态。

REST handler、SSH 回调、ChatService 和 TTL scheduler 只能投递命令，不能直接改状态。

### 9.2 命令集合

```ts
export type TerminalActorCommand =
  | { readonly type: "ssh_data"; readonly bytes: Uint8Array }
  | { readonly type: "ssh_exit"; readonly exit: TerminalChannelExit }
  | { readonly type: "submit"; readonly interactionId: string; readonly encodedBytes: Uint8Array; readonly expectation: TerminalObservationExpectation }
  | { readonly type: "key"; readonly interactionId: string; readonly encodedBytes: Uint8Array; readonly expectation: TerminalObservationExpectation }
  | { readonly type: "observe"; readonly interactionId: string; readonly expectation: TerminalObservationExpectation }
  | { readonly type: "cancel_interaction"; readonly interactionId: string; readonly reason: "run_cancelled" | "terminal_closing" | "backend_shutdown" }
  | { readonly type: "attach"; readonly attachmentId: string }
  | { readonly type: "attachment_ready"; readonly attachmentId: string; readonly replayedThroughSequence: number }
  | { readonly type: "detach"; readonly attachmentId: string }
  | { readonly type: "claim_resize_owner"; readonly attachmentId: string }
  | { readonly type: "release_resize_owner"; readonly attachmentId: string }
  | { readonly type: "resize"; readonly attachmentId: string; readonly ownershipEpoch: number; readonly geometry: TerminalGeometry }
  | { readonly type: "bind_run"; readonly runId: string }
  | { readonly type: "unbind_run"; readonly runId: string }
  | { readonly type: "idle_tick"; readonly now: number }
  | { readonly type: "close"; readonly reason: TerminalCloseReason }
  | { readonly type: "shutdown" };
```

可使用 Promise tail/mailbox 实现串行调度，不需要引入通用 actor framework。

### 9.3 输出处理顺序

每个 SSH chunk 的处理必须是：

1. 写入 headless xterm 并等待其 write callback；
2. 增加 `eventSequence`；
3. 以该 sequence 写入 byte-bounded replay ring；每个 frame 保存 sequence、事件类型和原始 bytes；
4. 更新 observation engine 的活动指标；
5. 生成 `terminal.output` 事件；
6. 推送给所有 live subscriber；
7. 根据安全水位决定是否 pause SSH stream。

这样 sequence 表示“Canonical State 已经应用的事件”，浏览器不会看到超前于后端语义状态的输出。

### 9.4 背压

限制：

- 每个 subscriber 待发送原始字节最多 512 KiB；
- 超限后不无限缓存，发送 `terminal.resync_required`，随后关闭该 SSE；
- actor 汇总 subscriber queue 和 headless write queue；超过高水位时 pause SSH stream，回落后 resume；
- 单个慢浏览器不能无限增长进程内存，也不能阻塞其他 subscriber。

Replay ring 必须覆盖所有带 sequence 的 Terminal stream frame，而不只是 output bytes，否则 output 之间的 resize/owner/status sequence 无法重放。容量按 output payload 2 MiB 和 frame metadata 4096 条双重限制；任一限制淘汰最旧 frame。attachment 需要的任意 sequence 已被淘汰时必须完整 resync。

## 10. Canonical State、快照和附着

### 10.1 Canonical State

后端使用 `@xterm/headless` 按真实 PTY geometry 消费原始 ANSI 输出。浏览器的 xterm 只接收：

1. 一份与当前 geometry 对应的 ANSI snapshot；
2. snapshot sequence 之后的原始输出增量；
3. 后端确认的 resize 事件。

浏览器不能为了适应容器宽度自行调用本地 `xterm.resize()`。它只能测量建议 geometry 并请求后端 resize；收到 `terminal.resized` 后再应用相同 rows/cols。

### 10.2 快照能力阻断性验证

开发第一步必须完成一个 dependency spike：

- `@xterm/headless` 能否与 `@xterm/addon-serialize` 在 Node 环境生成可供浏览器 xterm 重放的 ANSI snapshot；
- snapshot 是否覆盖 cursor、wrapped lines、alternate screen、颜色和宽字符；
- 版本是否与前端 `@xterm/xterm` 兼容；
- serialize 期间如何暂存输出并保持 sequence 连续。

若 addon 不满足要求，后端实现自有 ANSI serializer，但仍以 headless buffer/cursor 为来源。MVP 不接受 text-only snapshot，也不接受“只显示 attach 后的新输出”。

依赖必须作为各自 package 的直接依赖并固定精确版本；不能因为根 lockfile 中已有传递版本就默认采用它。

### 10.3 Bootstrap 协议

问题：snapshot 生成期间远端仍可能输出。如果先返回 snapshot、后订阅 SSE，中间输出会丢失；如果先订阅、再写 snapshot，顺序会倒置。

方案：attachment 具有 `bootstrapping -> live -> disconnected` 状态。

```text
Client                  REST/SSE                 Actor
  │ POST attachments       │                      │
  │────────────────────────► register attachment  │
  │                         │ capture N + snapshot│
  │◄──────────────────────── snapshot@N           │
  │ GET events?after=N     │                      │
  │────────────────────────► capture replayTo=M   │
  │◄════════════════════════ stream.ready(M)       │
  │◄════════════════════════ output N+1..M          │
  │ apply through M        │                      │
  │ POST ready(M)          │                      │
  │────────────────────────► mark live             │
  │◄════════════════════════ live M+1...            │
```

`stream.ready` 是控制事件，不消耗 Terminal sequence。只有具有 Canonical sequence 的状态/输出事件使用 SSE `id`。

初始 attachment 不拥有 resize 权。浏览器完成 `ready` 后，若页面仍 `visible && focused`，才调用 focus endpoint 声明 owner。

### 10.4 断线与 gap

- SSE 断线时 attachment 标记 `disconnected` 并立即释放 resize ownership；
- 保留 30 秒 reconnect grace，期间保留 attachment 和 sequence；
- EventSource 重连携带最后 `Last-Event-ID`；服务端从 replay ring 补发；
- 若所需 sequence 已被 ring 淘汰，发送 `resync_required` 并关闭流；前端删除旧 attachment，重新 bootstrap；
- bootstrap 超过 15 秒未收到 ready，后端移除 attachment；
- 不自动把 owner 交给后台 attachment。

## 11. REST 契约

所有 endpoint 都位于现有 `/api` 空间。HTTP 入参继续使用严格手写 parser：要求 object、精确字段、字符串长度、整数范围和 union 值；不把 TypeBox schema 直接用于 HTTP boundary。前端对 REST JSON 和每个 SSE envelope 使用 runtime guard，不能用 TypeScript assertion 代替不可信边界校验。持久化 JSON 从 SQLite 读取时同样验证。

### 11.1 获取状态

```http
GET /api/sessions/:sessionId/terminal
```

```ts
interface TerminalStatusResponse {
  readonly terminal: TerminalSessionView | null;
  readonly effectiveServerInteractionMode: "command" | "terminal";
  readonly transitionInProgress: boolean;
  readonly capabilities: {
    readonly minRows: number;
    readonly maxRows: number;
    readonly minCols: number;
    readonly maxCols: number;
  };
}
```

### 11.2 打开和关闭

```http
POST /api/sessions/:sessionId/terminal/open
POST /api/sessions/:sessionId/terminal/close
```

成功均返回 `202` 和最新 `TerminalSessionView`。

### 11.3 创建 attachment

```http
POST /api/sessions/:sessionId/terminal/attachments
```

```ts
interface CreateTerminalAttachmentRequest {
  readonly requestId: string;
}

interface CreateTerminalAttachmentResponse {
  readonly attachmentId: string;
  readonly terminalSessionId: string;
  readonly status: "bootstrapping";
  readonly snapshot: {
    readonly format: "xterm-ansi";
    readonly formatVersion: 1;
    readonly encoding: "base64";
    readonly data: string;
    readonly sequence: number;
    readonly rows: number;
    readonly cols: number;
  };
  readonly owner: false;
  readonly ownershipEpoch: null;
}
```

附件创建端点按 `requestId` 幂等，避免前端 effect 重放创建重复 attachment。

### 11.4 订阅和 ready

```http
GET /api/sessions/:sessionId/terminal/attachments/:attachmentId/events?afterSequence=:n
POST /api/sessions/:sessionId/terminal/attachments/:attachmentId/ready
```

```ts
interface TerminalAttachmentReadyRequest {
  readonly replayedThroughSequence: number;
}
```

服务端只接受刚才 `stream.ready` 声明的 sequence，防止浏览器跳过事件。

### 11.5 focus 与 owner

```http
POST /api/sessions/:sessionId/terminal/attachments/:attachmentId/focus
```

```ts
type TerminalFocusRequest =
  | { readonly focused: true }
  | { readonly focused: false };

interface TerminalFocusResponse {
  readonly owner: boolean;
  readonly ownershipEpoch: number | null;
}
```

`focused: true` 只有在 attachment 为 live 时成功。actor 接受后使该 attachment 成为 owner，并把 `ownershipEpoch + 1`。`focused: false` 只有当前 attachment 是 owner 时释放。

### 11.6 resize

```http
POST /api/sessions/:sessionId/terminal/attachments/:attachmentId/resize
```

```ts
interface ResizeTerminalRequest {
  readonly ownershipEpoch: number;
  readonly rows: number;
  readonly cols: number;
}
```

检查顺序：attachment live、当前 owner、epoch 相同、Terminal active、geometry 合法。重复提交当前 geometry 返回成功但不增加 Terminal sequence。

### 11.7 detach

```http
DELETE /api/sessions/:sessionId/terminal/attachments/:attachmentId
```

返回 `204`。重复 detach 也返回 `204`。若是 owner，先释放 ownership。

### 11.8 Timeline 与 Observation

```http
GET /api/sessions/:sessionId/terminal/timeline?before=:cursor&limit=:limit
GET /api/sessions/:sessionId/terminal/observations/:observationId
```

- Timeline 默认 100，最大 200，按最新向前分页；
- Observation endpoint 返回 Agent 实际收到的完整持久化文本，而不是重新从当前 Terminal 计算；
- 权限范围仍由 Session 归属控制，不允许跨 Session 读取 ID。

## 12. SSE 契约

### 12.1 Envelope

跨进程 HTTP/SSE 使用 JSON；进程内 actor 命令直接使用 TypeScript discriminated union，不重复序列化 JSON envelope。

```ts
interface TerminalSseEnvelope<TType extends string, TData> {
  readonly version: 1;
  readonly terminalSessionId: string;
  readonly type: TType;
  readonly sequence: number | null;
  readonly emittedAt: string;
  readonly data: TData;
}
```

SSE `id` 等于 `sequence`。`sequence=null` 的控制事件不写 `id`。

### 12.2 事件集合

| SSE event | sequence | data |
| --- | --- | --- |
| `terminal.stream.ready` | null | `replayedThroughSequence`、heartbeat interval |
| `terminal.status` | 是 | old/new status、reason、effectiveServerInteractionMode |
| `terminal.output` | 是 | `bytesBase64` |
| `terminal.resized` | 是 | rows、cols、owner attachment、epoch |
| `terminal.resize_owner_changed` | 是 | owner attachment 或 null、epoch |
| `terminal.input` | 是 | inputId、interactionId、状态、byteLength，不含敏感明文 |
| `terminal.observation.captured` | 是 | observationId、interactionId、boundary、摘要 |
| `terminal.observation.delivered` | 是 | observationId、runId、toolCallId |
| `terminal.observation.processing` | 是 | observationId、runId、turn index |
| `terminal.observation.finished` | 是 | observationId、runId、assistant message ID |
| `terminal.resync_required` | null | requiredAfter、oldestAvailable、latest |

SSE 每 15 秒发送 comment heartbeat。状态控制和原始输出使用同一 actor sequence，从而保持前端单调应用。

### 12.3 前端应用规则

1. `sequence <= lastAppliedSequence`：重复事件，忽略；
2. `sequence === lastAppliedSequence + 1`：应用；
3. `sequence > lastAppliedSequence + 1`：停止渲染增量并重新 bootstrap；
4. Base64 解码为 bytes 后直接写浏览器 xterm；
5. xterm write callback 完成后才更新 `lastAppliedSequence`；
6. `terminal.resized` 先调用本地 xterm resize，再确认该 sequence 已应用。

## 13. SQLite 持久化

实现时在当前最新 schema 后追加新 migration，例如 v10；版本号以合并时实际最新值为准。

### 13.1 terminal_sessions

```sql
CREATE TABLE terminal_sessions (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id) ON DELETE CASCADE,
  open_request_id TEXT NOT NULL,
  close_request_id TEXT,
  status TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 0,
  connection_generation INTEGER,
  term TEXT NOT NULL,
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  last_event_sequence INTEGER NOT NULL DEFAULT 0,
  ownership_epoch INTEGER NOT NULL DEFAULT 0,
  last_consumer_activity_at TEXT NOT NULL,
  idle_deadline_at TEXT,
  close_reason TEXT,
  activated_at TEXT,
  closing_at TEXT,
  closed_at TEXT,
  failure_code TEXT,
  failure_message TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (session_id, open_request_id)
);

CREATE UNIQUE INDEX terminal_sessions_one_live_per_session
ON terminal_sessions(session_id)
WHERE status IN ('opening', 'active', 'closing');
```

Repository 的 durable transition 使用 `WHERE id = ? AND status = ? AND revision = ?` 并原子 `revision = revision + 1`。actor 中的每个 output chunk 不写 SQLite；`last_event_sequence` 在状态、resize、input、Observation 和终态等 durable boundary 更新，close/lost 时写入最终 sequence，避免长期 PTY 把 SQLite 变成 byte-stream sink。

### 13.2 terminal_interactions

```sql
CREATE TABLE terminal_interactions (
  id TEXT PRIMARY KEY,
  terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  agent_run_id TEXT NOT NULL REFERENCES chat_runs(id) ON DELETE CASCADE,
  tool_call_id TEXT NOT NULL,
  action_json TEXT NOT NULL,
  expectation TEXT NOT NULL,
  status TEXT NOT NULL,
  input_sequence INTEGER,
  observation_id TEXT,
  guard_decision_json TEXT,
  approval_required INTEGER NOT NULL,
  failure_json TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  completed_at TEXT,
  UNIQUE (agent_run_id, tool_call_id)
);
```

### 13.3 terminal_inputs

```sql
CREATE TABLE terminal_inputs (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL UNIQUE REFERENCES terminal_interactions(id) ON DELETE CASCADE,
  terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  display_text TEXT NOT NULL,
  input_kind TEXT NOT NULL,
  encoded_bytes BLOB NOT NULL,
  byte_length INTEGER NOT NULL,
  status TEXT NOT NULL,
  terminal_sequence INTEGER,
  guard_revision INTEGER,
  matched_guard_rule_id TEXT,
  created_at TEXT NOT NULL,
  written_at TEXT
);
```

`display_text` 和 `encoded_bytes` 持久化是为了证明 Agent 的意图与真正写入的 bytes。`status` 为 `prepared | written | uncertain | blocked`。实时 SSE 只返回摘要、状态和长度；显式打开 Terminal Audit Timeline 时，受当前 Session 范围约束的 timeline query 返回 `display_text`，从而让用户核对 Agent 实际提交内容。`encoded_bytes` 不向浏览器返回。后续若产品要求敏感信息保护，再复用 credential cipher 方案，不在 MVP 擅自引入不可搜索加密。

Terminal Input 的精确定义：

- `submit`：`display_text` 是 Agent 调用 `terminal_interaction` 时提交的完整 `input`，经过 CRLF/LF 规范化，但不包含后端追加的最终 Enter；`encoded_bytes` 是实际写入 PTY 的 bytes，包含内部终端换行和最终 `0x0d`。
- `key: CTRL_C`：`display_text="CTRL_C"`，`encoded_bytes=0x03`。
- `observe`：不创建 `terminal_inputs` 记录。
- 它不是用户键盘输入、模型 prompt 或 PTY output。

`terminal_interactions.action_json` 只保存 action 类型和非输入元数据，不再重复保存完整 submit 文本。Agent 原始 Tool 参数已经作为 assistant message 持久化到 `chat_messages.message_json`；`terminal_inputs.display_text` 保存规范化后的 dispatch 文本，`encoded_bytes` 保存实际写入 bytes。这两份内容分别证明“Agent 请求了什么”和“Terminal harness 实际发送了什么”，允许内容相同但语义不同。命令中可能出现的密钥会同时进入对应的 Chat 记录和 Terminal 执行审计，因此日志、SSE 和普通状态接口不得输出这些字段。

### 13.4 terminal_observations

```sql
CREATE TABLE terminal_observations (
  id TEXT PRIMARY KEY,
  interaction_id TEXT NOT NULL UNIQUE REFERENCES terminal_interactions(id) ON DELETE CASCADE,
  terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  start_sequence INTEGER NOT NULL,
  end_sequence INTEGER NOT NULL,
  kind TEXT NOT NULL,
  rows INTEGER NOT NULL,
  cols INTEGER NOT NULL,
  boundary_reason TEXT NOT NULL,
  agent_view_text TEXT NOT NULL,
  raw_byte_count INTEGER NOT NULL,
  truncated INTEGER NOT NULL,
  captured_at TEXT NOT NULL,
  delivered_at TEXT,
  processing_at TEXT,
  finished_at TEXT
);
```

`agent_view_text` 是 Tool 返回给 Agent 的精确文本。Timeline 页面查看时直接读取此列，保证“当时 Agent 看到了什么”不会因当前屏幕变化而改变。

Tool execute 从这条已持久化记录构造 result；随后 tool-role AgentMessage 将相同 `content` 和关联 `details` 追加到 `chat_messages.message_json`。`terminal_observations` 是 Terminal harness 的不可变结果事实，`chat_messages` 是 Agent 实际收到的会话事实。

### 13.5 terminal_timeline_events

```sql
CREATE TABLE terminal_timeline_events (
  id TEXT PRIMARY KEY,
  terminal_session_id TEXT NOT NULL REFERENCES terminal_sessions(id) ON DELETE CASCADE,
  session_id TEXT NOT NULL REFERENCES sessions(id) ON DELETE CASCADE,
  timeline_sequence INTEGER NOT NULL,
  terminal_event_sequence INTEGER,
  type TEXT NOT NULL,
  interaction_id TEXT,
  observation_id TEXT,
  agent_run_id TEXT,
  data_json TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (terminal_session_id, timeline_sequence)
);
```

Timeline sequence 是持久化事件的稠密序列；Terminal event sequence 允许空，因为并非每个内存 output 都持久化。

### 13.6 chat_runs 扩展

```sql
ALTER TABLE chat_runs
ADD COLUMN server_interaction_mode TEXT NOT NULL DEFAULT 'command';

ALTER TABLE chat_runs
ADD COLUMN terminal_session_id TEXT REFERENCES terminal_sessions(id);
```

历史 Run 自动是 `command`。新 Run 的 mode 和 TerminalSession ID 在创建时冻结。SQLite migration 必须先创建 `terminal_sessions`，再添加引用列。

### 13.7 不持久化内容

以下内容只属于进程内 runtime：

- replay ring 中的 raw output 和 sequenced frame；
- ANSI snapshot；
- headless xterm buffer；
- attachments 和 subscriber queues；
- resize owner；
- run binding 和等待中的 timer；
- SSH Channel handle。

不能用 SQLite 模拟 Terminal byte stream。

### 13.8 启动恢复和遗留 Interaction

启动恢复必须与 TerminalSession 的 `lost` 收敛在同一事务边界或确定顺序内执行：

| 遗留 Interaction 状态 | 恢复结果 | 原因 |
| --- | --- | --- |
| `prepared | awaiting_approval | approved`，尚未开始写 | `cancelled` | 后端重启后不能继续旧 Tool call |
| `writing` | `write_uncertain` | 无法证明远端收到多少 bytes |
| `observing` 且已有 Observation | 保留 Observation，Interaction `completed` | 审计事实已经完成，delivery 状态保持真实值 |
| `observing` 且无 Observation | `cancelled` | PTY 已丢失，不能补造观察 |

恢复不重放 Input，不重算历史 Observation，不把 captured-not-delivered 伪装成 delivered。关联 Chat Run 的现有恢复逻辑继续负责 Run 终态。

## 14. Agent Tool 设计

### 14.1 Agent 边界与持久化层级

对 Agent Runtime 来说，`terminal_interaction` 与 `read`、`bash`、`remote_server_call` 等 Tool 没有特殊调用协议：

```text
assistant message with tool call(name + arguments)
  -> Agent invokes terminal_interaction.execute()
  -> TerminalInteractionService / actor / PTY / Observation harness
  -> Tool returns { content, details }
  -> tool-role AgentMessage
  -> next model turn
```

所有 Tool 都沿用现有 Chat 持久化不变量：

- assistant `message_end` 持久化完整 Tool call name、toolCallId 和原始 arguments；
- tool-result `message_end` 持久化完整 result `content/details`；成功、Guard blocked、审批拒绝、write uncertain 和普通执行失败都必须形成明确的 Tool result；
- 两者写入现有 `chat_messages.message_json`，按 Session message sequence 长期保存；
- `terminal_interaction` 不建立另一套 Agent 可见消息协议，也不要求 Agent 直接操作 TerminalSession actor；
- Tool 返回前先持久化 Terminal Observation，Tool result 必须从该持久化记录生成；随后现有 Chat 流再持久化真正交给 Agent 的 result message。

Terminal 领域表保存第二层“执行事实”：Interaction 状态、Guard/Approval、规范化 input、实际 PTY bytes、terminal sequence 和 Observation。两层通过 `runId + toolCallId + interactionId + observationId` 关联：

| 层级 | 主持久化 | 表达的事实 |
| --- | --- | --- |
| Agent 会话 | `chat_messages.message_json` | Agent 请求了哪个 Tool、传入什么参数、最终收到什么 result |
| Terminal harness | `terminal_interactions/inputs/observations/timeline` | 请求如何被校验、编码、写入 PTY，以及 result 如何从 Canonical State 形成 |

两层允许保存相关内容，但不能互相替代。Chat 记录保证模型上下文和跨 Run 对话恢复；Terminal 记录保证执行审计、幂等、防止重复写入和 Timeline 定位。

进程在 Tool result 形成前崩溃是唯一不能声称存在 output 的情况：保留已经持久化的 Tool input 和 TerminalInteraction 终态/uncertain 状态，但不能补造一条“Agent 已收到”的 result。只有真实发生 tool-result `message_end` 才表示 output 已进入 Agent 会话。

### 14.2 Tool schema

Tool 名称：`terminal_interaction`。

```ts
type TerminalInteractionToolInput =
  | {
      readonly action: "submit";
      readonly input: string;
      readonly expectation: "finite" | "interactive" | "streaming";
    }
  | {
      readonly action: "key";
      readonly key: "CTRL_C";
      readonly expectation: "finite" | "interactive" | "streaming";
    }
  | {
      readonly action: "observe";
      readonly expectation: "finite" | "interactive" | "streaming";
    };
```

Tool schema 使用 TypeBox discriminated union，`executionMode: "sequential"`。不使用 `any`，不使用动态 import。

约束：

- `submit.input` 按 UTF-8 最大 32 KiB；
- `submit.input` 不包含最后的 Enter，后端统一追加；
- 接受 tab、LF/CRLF；拒绝其他 C0/C1 控制字符；
- 规范化 CRLF/LF，并把逻辑换行写成 PTY `\r`；
- 最后一行同样发送 Enter，因此 `submit` 表示完整提交，不是逐字符模拟；
- `CTRL_C` 固定写入 byte `0x03`；
- Tool 不提供任意 key sequence。

### 14.3 Run 创建和 Tool 冻结

`ChatService.createRun` 新增请求字段：

```ts
interface CreateChatRunRequest {
  // existing fields
  readonly serverInteractionMode: "command" | "terminal";
}
```

创建流程：

1. 取得 Session lifecycle use lease；
2. 读取当前有效模式；
3. 请求 `terminal` 但没有 active TerminalSession 时返回 `409 terminal_session_unavailable`；其他 mode 不一致返回 `409 server_interaction_mode_conflict`；
4. Terminal Mode 时通过 actor 原子取得当前 TerminalSession 的 run binding lease；若 TTL close 已先进入 queue，则返回 unavailable；
5. 持久化 Run mode 和绑定 ID；持久化失败必须释放 binding lease；
6. 创建 Tool 数组：
   - 共用：read、write、bash、SFTP upload/download；
   - command：`remote_server_call`；
   - terminal：`terminal_interaction`；
7. Run 结束时解除 binding，但不关闭 TerminalSession。

现有 Agent core 已支持等待异步 event listener 和 `beforeToolCall`，因此 MVP 不需要修改 Agent core。

`terminal_interaction` 使用 sequential execution，但 `TerminalInteractionService` 仍必须在 actor 中执行 one-in-flight 校验。不能只依赖 Agent Tool scheduler，因为 REST 取消、Run 终止和未来其他调用者都可能与 Tool 生命周期交错。

相同 `agentRunId + toolCallId` 再次进入时：已完成则从持久化 Observation 重建相同 Tool result；仍在执行则等待同一个 in-flight promise；blocked/cancelled/uncertain/failed 则返回原终态，不创建第二次写入。不同 Tool call 在已有 Interaction 未结束时返回 `terminal_interaction_busy`。

### 14.4 submit 审批与 guard 时序

完整路径：

```text
Agent Tool call
  -> create/get prepared interaction(action_json) by runId+toolCallId
  -> guard preflight(full input)
  -> if session.autoAudit=false: existing approval flow
  -> immediately before write: guard recheck
  -> persist input as prepared
  -> actor writes the exact persisted encoded_bytes
  -> persist written/write_uncertain
  -> observation boundary
  -> persist exact Agent view
  -> return ToolResult from persisted observation
```

为什么 guard 仍需要复检：不是因为 Agent 会分段输入，而是因为“审批等待期间规则或 Terminal 状态可能改变”。例：preflight 允许，用户等待十秒后修改 guard rule；如果不复检，旧决策仍可写入。复检是状态时效性保护，不是 shell command parser。

审批规则：

| action | guard | Chat approval |
| --- | --- | --- |
| `submit` | 预检 + 写入前复检 | `autoAudit=false` 时走既有审批；true 时自动放行 |
| `key: CTRL_C` | 不做命令 guard | 不审批 |
| `observe` | 不做命令 guard | 不审批 |

用户拒绝审批时，将 prepared interaction 标记 `rejected`，不得在 Agent 自动重试时重新写入。

Guard 或审批拒绝时可以持久化一条 `terminal_inputs.status="blocked"` 审计记录和 Timeline item，但不得分配“成功写入”的 Terminal event sequence，也不得发送 `terminal.input` written 事件。`CTRL_C` 直接创建 input kind `semantic_key`、display text `CTRL_C` 和 encoded byte `0x03`。

### 14.5 写入不确定性

SSH stream write 没有端到端执行确认。只要写入开始后连接中断，就可能无法判断远端收到多少 bytes。

规则：

- 写入前失败：`failed`，可以由 Agent 发起新的 Tool call；
- write callback/drain 完成：`written`；
- 写入开始后、确认前断线：`write_uncertain`；
- `write_uncertain` 绝不自动 replay；
- Tool result 明确告诉 Agent“输入可能已部分或全部到达，请先 observe/人工确认”。

### 14.6 Chat Run 取消

Run cancel/abort：

1. Agent 停止；
2. 未写入的 interaction 标记 `cancelled`；
3. 已写入但尚未捕获 Observation 的 interaction 取消等待并标记 `cancelled`，不为了取消临时生成 Observation；
4. 已经持久化的 Observation 保留，并按真实 Agent 事件保持 captured 或 delivered 状态；
5. 不发送 `CTRL_C`；
6. 不关闭 TerminalSession；
7. 不移除用户 attachment；
8. Run binding 释放后 Terminal 继续 active。

## 15. Observation Engine

### 15.1 目标

Tool 返回的不是原始 ANSI，也不是浏览器当前 DOM，而是从 Canonical headless terminal 提取的、可持久化的文本视图。

### 15.2 边界参数

| expectation | prompt settle | quiet window | snapshot window | max wait | 用途 |
| --- | ---: | ---: | ---: | ---: | --- |
| `finite` | 150 ms | 800 ms | 不适用 | 30 s | 一般完整命令 |
| `interactive` | 150 ms | 500 ms | 不适用 | 15 s | TUI、prompt、分页器 |
| `streaming` | 不适用 | 不适用 | 固定 1500 ms | 3 s | log/tail 等持续输出 |

额外规则：

- 单 interaction 原始窗口最大 256 KiB；
- Tool 返回 Agent 的文本最大 64 KiB，保留尾部并写明截断；
- quiet/max boundary 只表示观察窗口结束，不证明远端进程完成；
- `observe` 也创建新的持久化 Observation。

finite/interactive 的 quiet timer 从最后一次相关 Canonical mutation 重新计时；streaming 的 1500 ms snapshot window 是固定墙钟窗口，不能被持续输出延后。同一 actor step 多个条件同时成立时固定优先级为：`channel_closed -> output_limit -> prompt -> snapshot -> quiet -> timeout`。达到 256 KiB 时正常捕获 `boundaryReason="output_limit"`，不终止 PTY。64 KiB tail 必须在合法 UTF-8/Unicode 边界截断并增加 earlier-output-omitted 标记。

### 15.3 文本提取

headless xterm 负责 ANSI、cursor、wrap、alternate screen 和宽字符语义。Observation engine 从公开 buffer API 提取：

- `finite`：interaction 起始 sequence 后形成的逻辑行，并附当前 cursor line；
- `interactive`：新增逻辑行 + 当前完整 screen；
- `streaming`：当前完整 screen，避免无界历史；
- wrapped physical rows 合并成 logical line；
- 样式去除，空白做确定性裁剪，不破坏列内字符；
- 保留命令 echo，但不宣称每个字符都由本次 input 产生；并发后台输出仍可能混入。

`observe` 的起点从 Repository 查询该 Agent Run 最近一条已 delivered Observation 的 `endSequence`；当前 Run 内可缓存该值，但缓存不是事实来源。没有历史 Observation 时以 observe 调用时的当前 sequence 为起点，并按 expectation 等待或捕获 screen。这里不新增或复用 `terminalContextCursor`。

建议 Tool result 格式：

```text
[terminal observation]
terminalSessionId: ...
interactionId: ...
sequence: 120..148
boundary: quiet_800ms
processCompletionKnown: false

<transcript or current screen>

[truncated: kept final 65536 UTF-8 bytes]
```

### 15.4 Timeline 四阶段

Timeline 只表达系统可证明的阶段：

1. `observation.captured`：Observation 已持久化；
2. `observation.delivered`：Agent Tool result message 已提交给 Agent loop；
3. `observation.processing`：后续模型 turn 已开始，该 Observation 已进入模型输入上下文；
4. `observation.finished`：包含该 Observation 的后续 assistant response 已结束，或产生了下一次 TerminalInteraction。

不能声称“模型当前 token 正读取到某一行”。UI 文案必须是“已捕获 / 已交付 / 模型正在处理包含该观察的上下文”。

现有 Agent event listener 会被 await，因此 `ChatService.handleAgentEvent` 可以按事件顺序持久化：

- `tool_execution_end`：把本次 Observation 标记 delivered；
- 下一次 `turn_start`：把此前 delivered 且未 processing 的 Observation 标记 processing；
- 对应的后续 `message_end/agent_end` 或下一次 Terminal Tool call：标记 finished；
- Run runtime 保存待标记 Observation ID 集合。

## 16. resize ownership

### 16.1 owner 声明

前端页面满足以下条件时才声明：

```text
document.visibilityState === "visible"
&& document.hasFocus()
&& attachment.status === "live"
```

触发点是离散事件：`focus`、`blur`、`visibilitychange`、SSE rebootstrap 完成。不发送周期性抢占心跳。

最新被 actor 接受的 `focused:true` 成为 owner，并增加 epoch。旧 owner 随后发送的 resize 因 epoch 不匹配被拒绝。

### 16.2 前端 resize 流程

1. `ResizeObserver` 观察 Terminal panel 容器；
2. 只有 owner 才使用 FitAddon 的测量能力计算建议 rows/cols；
3. debounce 100 ms，过滤未变化 geometry；
4. 发送 attachmentId + ownershipEpoch + rows/cols；
5. 后端 actor 分配 sequence，先更新 headless geometry，再按同一顺序调用 `setWindow` 并持久化 metadata；
6. 后端发布 `terminal.resized`；
7. 所有浏览器收到事件后用相同 geometry resize 本地 xterm。

MVP 不提供用户拖动 Terminal panel 分隔条。Chat/Terminal 区域是固定响应式布局，只有浏览器窗口或响应式断点改变会产生测量变化。

## 17. 前端运行时设计

### 17.1 状态模型

```ts
export interface TerminalRuntimeState {
  readonly status: "idle" | "opening" | "bootstrapping" | "live" | "reconnecting" | "closing" | "failed";
  readonly terminal: TerminalSessionView | null;
  readonly attachmentId: string | null;
  readonly lastAppliedSequence: number | null;
  readonly replayedThroughSequence: number | null;
  readonly owner: boolean;
  readonly ownershipEpoch: number | null;
  readonly timeline: readonly TerminalTimelineItem[];
  readonly error: TerminalClientError | null;
}
```

xterm instance、FitAddon、EventSource 和 timers 放在 React refs/runtime class 中，不放入 reducer state。

### 17.2 页面启动

```text
mount session page
  -> GET terminal status
  -> no active terminal: show manual “Open Terminal Mode”
  -> opening/closing: show transition and poll/SSE status
  -> active: create attachment
  -> instantiate browser xterm with disableStdin
  -> write snapshot, set snapshot sequence
  -> open SSE and apply replay
  -> POST ready
  -> if visible+focused: claim owner
```

React Strict Mode 下 effect 可能重复运行，因此 create attachment 使用 requestId 幂等，cleanup 必须 detach 并 close EventSource。

### 17.3 只读保证

浏览器 xterm 配置 `disableStdin: true`。不注册 `onData`，拦截 paste/drop，不展示输入光标或可编辑提示。即使前端出现 bug，后端也没有用户输入 endpoint；只有 Agent Tool 可以写 PTY。

### 17.4 布局

建议布局：

- 宽屏：Chat 主列 + 右侧 Terminal 固定比例面板；
- 窄屏：Chat 上、Terminal 下，Terminal 有固定最小高度；
- Terminal Mode 未开启时不渲染 xterm，只显示开启入口和说明；
- 不增加拖动手柄；
- 字体保持等宽和固定字号，不做 CSS 非等比缩放；
- xterm 根据后端 geometry 渲染，浏览器容器允许滚动或留白，不用 CSS 强制文本自动换行改变逻辑网格。

这保证用户和 Agent 的 Terminal 语义一致。所谓“响应式”是布局和远端 geometry 同步变化，不是浏览器对同一字符流另行软换行。

### 17.5 Chat Tool card

当前前端 Tool result hydration 会丢弃结构化 details，Terminal 实现必须扩展：

```ts
interface ToolResultMessage {
  // existing fields
  readonly details?: unknown;
}
```

Terminal Tool details 通过 runtime guard 收窄为：

```ts
interface TerminalToolResultDetails {
  readonly type: "terminal_interaction";
  readonly terminalSessionId: string;
  readonly interactionId: string;
  readonly observationId: string;
  readonly kind: "transcript" | "screen";
  readonly fromSequence: number;
  readonly toSequence: number;
  readonly rows: number;
  readonly cols: number;
  readonly boundaryReason: TerminalBoundaryReason;
  readonly truncated: boolean;
}
```

Tool card 展示 action、sequence 范围、boundary、截断状态，并提供“在 Terminal Timeline 中定位”。完整 Observation 从专用 endpoint 获取，避免把大文本重复塞入所有 Chat UI state。

### 17.6 开关和删除体验

- “Open Terminal Mode” 仅在无活动 Run、Terminal 无过渡状态时可点击；
- 开启后下一个 Run 使用 `terminal_interaction`，当前已存在 Run 不改变；
- mode toggle 在 active Chat Run 期间禁用；用户停止 Run 后才能手动打开或关闭 Terminal；
- Session 删除对话框显示：删除将先关闭 Terminal，活动 Run/Command Operation 必须先结束；
- `autoAudit` 总说明继续覆盖本地 `write`/`bash`、Command Mode 的 `remote_server_call` 和 Terminal Mode 的 `submit`；Terminal 面板需明确 observe/CTRL_C 本来就不审批，不能描述成被自动审批。

## 18. API 错误模型

新增统一 `TerminalError`，保持当前 HTTP handler 的显式映射风格：

```ts
export interface TerminalErrorDetails {
  readonly terminalSessionId?: string;
  readonly status?: TerminalSessionStatus;
  readonly ownershipEpoch?: number;
  readonly retryAfterMs?: number;
}

export class TerminalError extends Error {
  readonly code: string;
  readonly status: number;
  readonly retryable: boolean;
  readonly details: TerminalErrorDetails;
}
```

| code | HTTP | retryable | 场景 |
| --- | ---: | --- | --- |
| `terminal_session_already_active` | 409 | false | Session 已有非终态 Terminal |
| `terminal_session_not_found` | 404 | false | ID 不属于当前 Session |
| `terminal_session_unavailable` | 409 | 视状态 | Terminal Mode Run 无 active Terminal |
| `terminal_session_lost` | 409 | false | 绑定的 Terminal 已 lost |
| `terminal_session_closing` | 409 | true | input/attach/resize 时 closing |
| `terminal_transition_in_progress` | 409 | true | opening 时创建 Run |
| `server_interaction_mode_conflict` | 409 | true | 前端 mode 与后端有效 mode 不一致 |
| `terminal_capacity_exceeded` | 429 | true | 进程级 Terminal 配额已满 |
| `terminal_connection_capacity_exceeded` | 429 | true | Connection generation PTY 配额已满 |
| `terminal_attachment_capacity_exceeded` | 429 | true | attachment 配额已满 |
| `terminal_attachment_not_live` | 409 | true | bootstrap 未完成 |
| `terminal_interaction_busy` | 409 | true | 已有 in-flight Interaction |
| `terminal_interaction_cancelled` | 409 | false | Run/close 已取消 Interaction |
| `terminal_resize_not_owner` | 409 | true | 非 owner 或旧 epoch resize |
| `terminal_ownership_epoch_mismatch` | 409 | true | 旧 owner/旧请求 |
| `terminal_resize_invalid` | 400 | false | geometry 越界 |
| `terminal_resync_required` | 409 | true | replay 已不可用，需要重新附着 |
| `terminal_input_too_large` | 400 | false | 超过 32 KiB |
| `terminal_input_invalid` | 400 | false | 非法控制字符或 schema |
| `terminal_input_blocked` | 403 | false | Guard 或审批拒绝 |
| `terminal_input_uncertain` | 502 | false | 可能部分写入，禁止自动重放 |
| `terminal_snapshot_unavailable` | 503 | true | 无法生成恢复 snapshot |
| `terminal_persistence_failed` | 500 | true | 审计事实未能持久化 |
| `session_deletion_in_progress` | 409 | true | 删除屏障已建立 |
| `session_has_active_chat_run` | 409 | true | 活动 Run 阻止关闭或删除 |
| `session_has_active_operations` | 409 | true | 活动 Command Operation 阻止删除 |

前端按 `code` 分支，不匹配英文 message。

## 19. 资源限制、TTL 和关闭顺序

### 19.1 默认限制

所有 Terminal 默认值禁止散落在 Service、Actor、Route、React component 或测试中：

- 后端权威默认值统一定义在 `packages/ssh-agent/src/application/terminal/terminal-defaults.ts`，导出一个只读 `TERMINAL_DEFAULTS` 常量对象；geometry、资源上限、TTL、Observation window、snapshot/replay、attachment、open/close/shutdown timeout 都从这里读取。
- 环境变量只覆盖解析后的 runtime config，不修改常量；缺省值始终来自 `TERMINAL_DEFAULTS`。
- 前端只在 `packages/ssh-agent-web/features/terminal/model/terminal-ui-defaults.ts` 定义浏览器专属默认值，例如 resize debounce 和固定布局尺寸。
- 服务端拥有的限制不在前端复制。需要前端预校验的 geometry/capability 由 Terminal status/bootstrap 响应返回有效值，SSE heartbeat interval 由 `terminal.stream.ready` 返回。
- 测试直接导入这些常量或显式构造测试 config，不能复制生产数字。

存在两个物理文件是因为后端和浏览器是两个独立 bundle；服务端参数仍只有一个权威来源，不形成两套默认值。

| 资源 | 默认上限 |
| --- | ---: |
| 进程内 active/opening/closing TerminalSession | 16 |
| 每 Connection generation PTY Channel | 4 |
| 每 Terminal raw ring | 2 MiB |
| 每 Terminal replay frame metadata | 4096 条 |
| headless xterm scrollback | 2000 行 |
| 每 Terminal attachments | 4 |
| 每 subscriber pending bytes | 512 KiB |
| Terminal open deadline | 30 秒 |
| idle TTL | 2 小时 |

这些值作为环境配置开放，但需要后端 hard cap 防止误配导致极端内存占用。建议环境变量统一前缀，例如 `SSH_AGENT_TERMINAL_*`。

### 19.2 TTL eligibility

只有同时满足以下条件才可回收：

- 没有 live/bootstrapping attachment；
- 没有 active Chat Run binding；
- 没有 in-flight interaction；
- `idleDeadlineAt !== null && now >= idleDeadlineAt`。

TTL scheduler 可每分钟扫描一次候选项，但最终 eligibility 必须由 actor 在执行 close 前再次检查。关闭原因持久化为 `idle_timeout`。

actor 一旦接受 TTL close，立即发布 `terminal.status` 和新的 `effectiveServerInteractionMode="command"`。前端自动把 Mode UI 切回普通模式；`closing` 期间 terminal-mode Run 返回 `terminal_session_unavailable`，但 command-mode Run 可以创建。Session deletion barrier 存在时仍拒绝所有新 Run。

### 19.3 进程关闭

当前 backend/server 的部分 `close()` 是同步接口。Terminal 引入后必须改成可等待的异步关闭链：

```text
stop accepting new HTTP work
  -> establish global shutdown state
  -> abort active Chat Runs according to existing shutdown policy
  -> stop Observation waits and close all Terminal channels in parallel
  -> persist TerminalSession as lost(reason=backend_shutdown)
  -> drain Command schedulers as existing policy requires
  -> close SSH pool
  -> close SQLite
  -> close HTTP server
```

不允许数据库先关闭、actor 再尝试写 `closed/lost`。总关闭超时建议 10 秒；单 Terminal graceful 5 秒，超时 destroy。

### 19.4 可观测性

至少记录以下结构化指标或日志字段：

- process/connection Terminal reservation 当前值、上限和 rejection；
- TerminalSession open/active/close/lost 数量、原因和持续时间；
- attachment 数、owner handoff、resize rate、bootstrap/reconnect/resync 次数；
- replay ring bytes、frame 数、eviction 和 subscriber pending bytes；
- snapshot bytes、生成耗时和失败原因；
- Interaction action、latency、boundary reason、output bytes、timeout、blocked 和 uncertain；
- effective mode transition、Run binding、TTL/Run race 和 deletion barrier 结果。

日志关联键固定带 `sessionId`、`terminalSessionId`，涉及 Tool 时再带 `agentRunId`、`toolCallId`、`interactionId` 和 `observationId`。日志默认不输出完整 input、encoded bytes 或 Observation 文本。

## 20. HTTP handler 和依赖装配

### 20.1 路由拆分

现有 `http-handler.ts` 已承担大量路由。Terminal 端点由 `terminal-routes.ts` 解析路径和调用 Service：

```ts
export interface TerminalRouteHandler {
  handle(request: Request, segments: readonly string[]): Promise<Response | null>;
}
```

顶层 handler 在 Session/Chat 路由附近委托；返回 `null` 表示不匹配。Terminal request parser 和 response DTO 留在 Terminal API 模块，避免继续扩展通用 `contracts.ts` 为单体文件。

### 20.2 装配顺序

```text
SQLite database
  -> repositories
  -> ConnectionPool + TerminalChannelBroker
  -> SessionLifecycleCoordinator
  -> TerminalRuntimeRegistry + EventStream
  -> TerminalSessionService + TerminalInteractionService
  -> ChatService / CommandOperationService / SessionService
  -> TerminalRouteHandler + root HTTP handler
  -> server
```

`SqliteManagementBackend` 对外增加 Terminal services，并把 `close()` 改为 `Promise<void>`。所有调用者必须 await。

## 21. 测试设计

### 21.1 后端单元测试

建议新增：

```text
packages/ssh-agent/test/
  terminal-domain.test.ts
  session-lifecycle-coordinator.test.ts
  terminal-session-actor.test.ts
  terminal-replay-ring.test.ts
  terminal-observation-engine.test.ts
  terminal-event-stream.test.ts
  terminal-interaction-tool.test.ts
  sqlite-terminal-repository.test.ts
  terminal-http-routes.test.ts
  ssh2-terminal-channel-broker.test.ts
```

最低覆盖：

- 一 Session 一个 live Terminal 的数据库和 service 双重约束；
- open/close requestId 幂等；
- actor 命令严格顺序；
- write backpressure 和 uncertain write 不 replay；
- raw ring eviction、sequence gap、slow subscriber resync；
- snapshot + replay 无缺失、无重复；
- attachment ready/focus/epoch/resize；
- owner 失焦释放，后台不自动接管；
- Terminal status 与 Run mode 冲突；
- Tool 集合冻结且互斥；
- assistant Tool call input 和 tool-role result 都进入现有 Chat Message 持久化；
- autoAudit false/true、guard 预检和复检；
- Run cancel 不关闭 PTY、不发送 CTRL_C；
- Session 删除阻塞与受限级联竞态；
- TTL eligibility 的四个条件；
- startup 将遗留 live 状态转为 lost；
- Observation 64 KiB tail 和 Timeline 四阶段；
- CJK、wrap、alternate screen、cursor line。

SSH broker 测试使用 fake ssh2 client/channel，不访问真实服务器。

### 21.2 前端测试

建议新增：

```text
packages/ssh-agent-web/features/terminal/**/*.test.ts(x)
packages/ssh-agent-web/features/chat/model/chat-runtime-state.test.ts
```

最低覆盖：

- snapshot -> replay -> ready -> live；
- duplicate/gap sequence 行为；
- Strict Mode effect 不创建重复 attachment；
- visible/focused 声明 owner，blur/hidden 释放；
- stale epoch resize 错误后刷新状态；
- 非 owner 不调用 resize API；
- `terminal.resized` 才改变本地 xterm geometry；
- no onData/paste/user input endpoint；
- reconnect grace 和强制 rebootstrap；
- Tool result details hydration 不丢失；
- Run create request 携带 mode；
- 开关、closing 和删除 UI 状态。

浏览器 xterm 用 wrapper adapter 注入 fake，不让 reducer 测试依赖 canvas/DOM 实现细节。

### 21.3 集成与验收

使用受控 SSH 测试机验证：

- 最终人工前端验收固定使用现有业务 Session `terminal-interaction-test`；测试时从当前系统解析其真实 Session/Workspace/SSH 配置，不在源码、fixture、日志或文档中复制凭据。
- 该 Session 已准备 Java 应用和 Arthas，作为交互式长周期 PTY 的真实验收环境。

1. shell prompt 和命令 echo；
2. `ls --color`、颜色、宽字符、emoji、CJK；
3. `top`/`vim`/分页器等 alternate screen；
4. browser resize 与 `stty size` 一致；
5. Agent 和前端看到的文本语义一致；
6. SSE 断线重连和 ring gap；
7. SSH generation 被回收/断线后 Terminal 进入 lost；
8. 长输出下 CPU、内存、backpressure；
9. 审批等待期间 guard 变化；
10. 取消 Run 后 shell 继续运行；
11. 仅有 Terminal 时 Session 删除先关闭 Terminal；存在 active Run 时删除被拒绝且不取消 Run；
12. idle TTL 不关闭有 attachment 或 Run binding 的 Terminal。

Arthas 场景作为验收目标：Agent 可在 `terminal-interaction-test` 中提交启动命令、选择 Java 进程、读取 attach 输出、观察交互菜单和 dashboard、发送完整输入或 CTRL_C；用户能只读跟随屏幕和 Observation Timeline。Run 结束后 TerminalSession 必须保持 active。

## 22. 分阶段实施顺序

每个阶段都保持前后端契约可验证，不能先写完整后端后另开会话猜前端协议。

### Phase 0：依赖和快照 spike

- 验证 headless + serialize + browser xterm 版本组合；
- 产出 fixture：ANSI、alternate screen、CJK、resize；
- 固定 direct dependency 精确版本；
- 审核依赖和 lockfile，使用 `npm install --ignore-scripts` 规则。

阻断条件：无法生成语义完整 snapshot，则先完成自有 serializer 设计，不进入 UI 实现。

### Phase 1：领域、migration、Repository、生命周期协调器

- 完成类型、状态机、migration、SQLite CAS；
- 接入 Session/Run/Command 生命周期屏障；
- 完成 startup lost recovery；
- 不连接真实 SSH。

### Phase 2：SSH broker、actor、headless、ring

- 打开/关闭 PTY；
- canonical output、sequence、backpressure、resize；
- 资源配额和 TTL；
- fake channel 单元测试。

### Phase 3：REST/SSE 与最小只读前端

- 完成 open/close/status/attachment/bootstrap/replay；
- 前端只读 xterm 和固定响应式布局；
- 完成 owner/focus/resize；
- 用人工页面验证双标签页行为。

### Phase 4：Agent Tool、审批、Observation、Timeline

- Run mode 冻结和 Tool 互斥；
- submit/key/observe；
- guard + autoAudit；
- Observation boundary、持久化、Tool details；
- Timeline 四阶段 UI。

### Phase 5：删除、关闭、恢复和完整验收

- 受限级联；
- async shutdown；
- 断线/lost/write uncertain；
- Arthas 和长输出压力测试；
- 更新 AI Repo 文档、manifest digest、changelog（仅在符合仓库分支规则时）。

每个 Phase 的代码完成后按仓库规则运行针对性测试和 `npm run check`。不运行 `npm test` 或 `npm run build`，除非用户明确要求。

## 23. 实现期间必须同步的 AI Repo 文档

Terminal 是新的 SSH Agent functional area。真正开始改源码时必须：

1. 新建 `docs/ssh-agent/ai-repo/features/terminal-interaction.md`；
2. 在 `docs/ssh-agent/ai-repo/index.md` 增加导航；
3. 在 `docs/ssh-agent/ai-repo/manifest.json` 映射领域、service、broker、API、SQLite 和前端主要源文件；
4. 改动 mapped source 后读完整 source 和 feature doc；
5. 执行 `node docs/ssh-agent/ai-repo/check.mjs --update`，然后执行无参数 check；
6. 设计文档保留决策，AI Repo feature doc 只做当前实现导航和不变量说明。

本次仅新增设计文档，没有新增功能源文件，因此不提前把尚未存在的路径加入 manifest。

## 24. 审核清单

以下实现级选择已冻结：

- [x] open/close 使用 `202` 异步状态，而不是等待 SSH 完成；
- [x] 默认 geometry `120x36`，范围 `40..320` cols / `12..120` rows；
- [x] attach 增加显式 `ready` handshake；
- [x] reconnect grace 30 秒、bootstrap timeout 15 秒、SSE heartbeat 15 秒；
- [x] resize debounce 100 ms；
- [x] submit 最大 32 KiB UTF-8；
- [x] graceful channel close 5 秒、server shutdown 10 秒；
- [x] Input 明文持久化；SSE/普通状态不回传，显式 Audit Timeline 返回 display text；
- [x] Observation 对 Agent 最大 64 KiB tail；
- [x] Run 请求必须显式提交 mode，冲突时拒绝而非自动纠正；
- [x] mode toggle 在 active Run 期间禁用，Run cancel 只释放 binding、不关闭 Terminal；
- [x] 初次 attachment 完成 ready 后才可声明 resize owner；
- [x] 浏览器只在收到后端 `terminal.resized` 后改变本地逻辑网格；
- [x] 后端和前端各自使用专门的静态 defaults 文件；服务端参数不在前端重复硬编码。

实现只能通过集中常量或 runtime config 调整数值，不能在调用点引入新的隐式默认值。若技术 spike 要求改变用户行为或领域边界，必须重新进入设计讨论。

## 25. 完成定义

MVP 只有同时满足以下条件才算完成：

- 用户能手动打开和关闭一个与 Session 绑定的长周期 PTY；
- Terminal Mode Run 只得到 `terminal_interaction`，Command Mode Run 只得到 `remote_server_call`；
- `terminal_interaction` 的原始 Tool input 和最终 result 与其他 Tool 一样进入现有 Chat Message 长期持久化；
- `submit` 使用完整输入、guard 和既有 autoAudit，observe/CTRL_C 不审批；
- Agent 获取持久化的准确 Observation，前端能定位 captured/delivered/processing/finished；
- 浏览器只读显示与后端 Canonical State 相同的 Terminal，并通过 owner 协议同步 resize；
- Run cancel 不影响 PTY，Session delete 执行受限级联；
- 容量、TTL、断线、重启、背压和写入不确定性都有确定行为；
- 前后端协议、测试、AI Repo 导航和真实源码保持同步。
