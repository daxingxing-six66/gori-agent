# ChatService 完整拆分计划

状态：已完成
制定日期：2026-08-28
适用范围：`packages/ssh-agent` 的 Chat Runtime 后端，不包含前端功能变更。

## 1. 目标

本计划把 `ChatService` 从同时拥有多个生命周期的 God Class，收敛为 Chat 用例入口和 Run 生命周期协调者。

拆分后的 `ChatService` 只保留以下职责：

- 对外维持现有 Chat API 方法。
- 保证一个 Session 同时只有一个活动 Chat Run。
- 按固定顺序完成 Session、模型、工作目录、Terminal binding 和 Run 持久化校验。
- 注册活动 Runtime，启动 Agent，并在结束时决定 Run 终态。
- 协调各独立组件完成取消和资源释放。

以下职责必须移出 `ChatService`：

- Agent、Node execution environment 和 Tool 集合构造。
- Tool Call 授权流程与 SFTP Tool 内审批上下文。
- Approval 持久化、timeout、AbortSignal 和 pending waiter 生命周期。
- Queue 持久化与 Agent steer/follow-up 队列同步。
- AgentEvent 到消息、Queue、Terminal timeline 和 SSE 的投影。
- Chat context 恢复和自动压缩算法。
- Run SSE stream 的缓存、回放和关闭。

行数下降不是验收目标。真正的验收标准是状态所有权、依赖方向和失败清理边界明确。

## 2. 当前问题

### 2.1 `createRun` 同时承担准备、构造和运行

问题：`createRun` 从 Session 校验一直执行到 Agent 构造、Tool callback 注册、Runtime 注册和异步执行。

具体流程：

```text
检查幂等和 busy
  -> 读取 Session
  -> 获取 lifecycle lease
  -> 校验 workDir、model、thinking level、provider auth
  -> 绑定 command 或 terminal
  -> 持久化 ChatRun
  -> 创建 NodeExecutionEnv
  -> 创建六类 Tool
  -> 创建 Agent 和 callbacks
  -> 创建 ActiveRuntime
  -> 注册并执行
```

影响：任意 Tool、审批规则或 Agent 配置变化都会修改同一个高风险方法；构造中途失败时也难以审查哪些资源已经获取。

解决：保留上层执行顺序，把 Agent/Tool 构造移入 Runtime Factory，把可变进程内状态移入单 Run Runtime。

### 2.2 Approval 是独立生命周期，但当前依附于 ActiveRuntime

问题：Approval 同时涉及 SQLite、SSE、timer、AbortSignal listener、用户决议和 Run 取消，当前由 `ChatService.authorize` 与 `ActiveRuntime.pendingApprovals` 共同维护。

具体例子：用户取消 Run 时，`cancelRun` 必须知道 pending waiter 的内部结构并逐个 resolve；HTTP Approval 决议也必须先操作 Repository，再查找活动 Runtime。

解决：建立 `ChatApprovalService`，由它唯一维护 pending waiter，并提供 request、resolve、cancelRun 和 close 生命周期。

### 2.3 Queue 同时修改 SQLite 与 Agent 内存队列

问题：enqueue、cancel、consume、审批拒绝后的 steer 清理和 Run 取消分散在多个方法及 Agent callback 中。

具体例子：审批拒绝后不是立即取消所有消息，而是在当前 Turn 完整产生 Tool Result 后停止自动延续，只取消 steer，保留 follow-up。该语义依赖 Runtime 状态、Repository 和 Agent queue 三方同步。

解决：建立 `ChatQueueService`，通过窄化的 queue driver 操作 Agent，不直接依赖完整 Agent。

### 2.4 AgentEvent 投影混合多种业务副作用

问题：一个 event handler 同时处理模型失效、消息持久化、Queue consume、Terminal timeline 和 SSE projection。

具体例子：一个 `message_end` 可能先改写 unsupported model 错误，再写消息，再完成 Terminal timeline，最后消费 Queue 并向浏览器发布事件。

解决：建立 `ChatAgentEventHandler`，集中维护事件到业务投影的顺序，并以单元测试锁定顺序和输出。

### 2.5 资源释放没有单一所有者

问题：Agent、NodeExecutionEnv、Session lease、Terminal binding、Approval waiter 和 SSE streams 分别在 `createRun`、`executeRun`、`cancelRun`、`close` 中释放。

具体例子：Terminal unbind 抛错时，后续 active map 删除和 lease release 可能无法执行。

解决：`ChatRunRuntime.dispose` 负责 Agent 与 Node execution environment 的幂等释放；Approval、Tool Call 和 SSE 组件各自释放其内部资源；`ChatService` 的 finalization 使用嵌套 `try/finally` 保证 Runtime dispose、Terminal unbind、active 删除和 lease release 不互相阻断。

## 3. 冻结契约

拆分期间以下行为不得改变：

- HTTP 路由、请求和响应结构不变。
- `ChatService` 的公开方法签名不变。
- SQLite schema 和已持久化记录结构不变。
- Chat SSE event 名称、payload 和 replay 行为不变。
- 一个 Session 最多一个活动 Chat Run。
- requestId 幂等规则不变。
- 普通模式只提供 `remote_server_call`；Terminal Mode 只提供 `terminal_interaction`。
- Chat Run 取消只停止 Agent，不关闭 TerminalSession。
- `read` 无审批。
- `write`、`bash`、`remote_server_call` 和 Terminal submit 沿用 `autoAudit`。
- Guard 在远端命令和 Terminal submit 审批前检查，并在实际派发前复检。
- Terminal `observe` 和 `CTRL_C` 不创建通用 Approval。
- SFTP 只在覆盖时审批，且 `autoAudit` 不绕过覆盖确认。
- 用户拒绝或超时后，在 Tool Result 完成后停止自动延续，只取消 steer，保留 follow-up。
- Run 结束时保留消息、Approval、Queue 和 compaction 的现有持久化语义。
- 服务重启后的 interrupted recovery 结果不变。

任何需要改变上述行为的修复必须单独提交设计说明和回归测试，不能隐藏在机械拆分中。

## 4. 目标架构

```text
HTTP routes
  -> ChatService
       -> active Runtime map
       -> ChatAgentRuntimeFactory
            -> ChatRunRuntime
            -> local/server/SFTP Tool factories
            -> Agent
       -> ChatToolCallCoordinator
            -> ChatToolAuthorizationPolicy
            -> ChatApprovalService
       -> ChatQueueService
       -> ChatAgentEventHandler
       -> ChatContextService
       -> ChatRunEventHub
       -> ChatRepository / SessionRepository

Agent events
  -> ChatAgentEventHandler
       -> message persistence
       -> Queue consume
       -> Terminal timeline
       -> model catalog update
       -> ChatRunEventHub
```

依赖只能从 `ChatService` 和 Runtime assembly 指向这些组件。任何新组件不得反向依赖 `ChatService`。

## 5. 目标模块边界

### 5.1 `ChatService`

保留：

- 公开 Chat use cases。
- requestId 幂等和 Session busy 检查。
- Session、workDir、model、thinking level 和 provider auth 校验。
- Session lifecycle lease 与 server interaction binding 的获取顺序。
- ChatRun 创建、终态选择和活动 Runtime 注册。
- 调用其他组件执行 cancel、compact 和 dispose。

移除：

- `Agent`、`NodeExecutionEnv`、Tool 构造和 Agent 配置 import。
- Tool 名称分支。
- Approval timer 和 pending map。
- Agent queue 具体方法调用。
- `AgentEvent` 类型分支。
- `compact`、`prepareCompaction` 和 context projection。
- `ChatRunEventStream` cache。

### 5.2 `ChatRunRuntime`

建议文件：`packages/ssh-agent/src/application/chat-run-runtime.ts`

唯一拥有单 Run 的进程内可变状态：

- `ChatRun`。
- `Agent`。
- `NodeExecutionEnv`。
- termination、continuation、steering 和 model 状态。
- 幂等 `dispose` 状态。

公开行为应使用语义方法，不让调用方直接拼装状态：

- `requestCancellation()`。
- `stopAfterApprovalRejection()`。
- `beginTurn()`。
- `consumeContinuationDecision()`。
- `markModelRemoved()`。
- `abortAgent()`。
- `dispose()`。

它不访问 Repository、Terminal Service、Session lease、Approval、Tool Call context 或 SSE。

### 5.3 `ChatAgentRuntimeFactory`

建议文件：`packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`

职责：

- 创建 `NodeExecutionEnv`。
- 创建 read/write/bash 本地 Tool adapters。
- 根据冻结的 `serverInteractionMode` 选择远端命令或 Terminal Tool。
- 创建 SFTP upload/download Tool。
- 生成模式对应的 system prompt。
- 固定 Agent steering、follow-up 和 parallel Tool 配置。
- 连接 Tool Call、SFTP overwrite、AgentEvent 和 continuation callbacks。
- 返回完整可用的 `ChatRunRuntime`，不得暴露半初始化对象。

它不校验 Session、模型权限，不持久化 Run，也不决定 Run 终态。

### 5.4 `ChatApprovalService`

建议文件：`packages/ssh-agent/src/application/services/chat-approval-service.ts`

职责：

- 创建并持久化 `ToolApproval`。
- 发布 `approval.requested` 和 `approval.resolved`。
- 处理 auto approval。
- 维护按 runId/approvalId 索引的 pending waiter。
- 处理用户 approve/reject、timeout、already-aborted signal 和 Run cancel。
- 在所有完成路径清理 timer、AbortSignal listener 和 pending index。
- 保持重复相同决议幂等、相反决议返回 409 的现有规则。

建议 API：

```ts
request(input: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision>
resolve(sessionId: string, approvalId: string, approved: boolean): ToolApproval
cancelRun(runId: string, reason: "run_cancelled" | "server_restarted"): void
list(sessionId: string, status: string): ToolApproval[]
close(): void
```

它不访问 Agent 或 Runtime。

### 5.5 `ChatToolCallCoordinator`

建议文件：`packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts`

职责：

- 把 Agent `beforeToolCall` 参数交给 `ChatToolAuthorizationPolicy`。
- 根据 allow、defer、block、approval 计划执行对应流程。
- 调用 `ChatApprovalService`，再把 Terminal 决议交回授权策略。
- 生成当前固定的 Tool rejection result。
- 维护 SFTP Tool Call 到 assistantMessageId 的短生命周期映射。
- 用户拒绝或超时时通知 Runtime 停止自动延续。
- Run 结束时清理遗留 Tool Call 上下文。

`ChatToolAuthorizationPolicy` 继续只负责规则判断，不持久化 Approval，不维护 waiter。

### 5.6 `ChatQueueService`

建议文件：`packages/ssh-agent/src/application/services/chat-queue-service.ts`

职责：

- Queue requestId 幂等。
- Queue item 持久化和 SSE 发布。
- steer/follow-up 入队。
- 单项取消后重建对应 Agent queue。
- message_end 时消费对应 pending item。
- Run 取消时取消全部 pending Queue。
- 审批拒绝后的 continuation callback 中只取消 steer。

它只依赖以下窄接口，不依赖完整 `Agent`：

```ts
interface ChatQueueDriver {
  steer(message: AgentMessage): void;
  followUp(message: AgentMessage): void;
  clearSteeringQueue(): void;
  clearFollowUpQueue(): void;
}
```

### 5.7 `ChatAgentEventHandler`

建议文件：`packages/ssh-agent/src/application/services/chat-agent-event-handler.ts`

职责：

- `turn_start`：恢复 steer 接受状态，推进 Terminal processing timeline。
- `message_end`：识别 unsupported model、改写友好错误、持久化消息、完成 Terminal timeline、消费 Queue。
- `tool_execution_update`：通过现有 protocol 生成白名单 update。
- `message_update` 和其他 AgentEvent：保持现有 SSE projection。
- 更新 Runtime model state。

unsupported model 的诊断解析 helper 一并移动到该模块。

### 5.8 `ChatContextService`

建议文件：`packages/ssh-agent/src/application/services/chat-context-service.ts`

职责：

- 从最近 compaction 和后续消息恢复 Agent context。
- 根据模型 context window 计算压缩阈值。
- 执行 compaction。
- 持久化 compaction projection。
- 发布 started、failed 和 completed 事件。

建议 API：

```ts
load(sessionId: string): AgentMessage[]
compactCompletedRun(input: { run: ChatRun; model: Model }): Promise<void>
```

它不依赖完整 Runtime 或 Agent，只接收压缩所需模型信息。

### 5.9 `ChatRunEventHub`

建议文件：`packages/ssh-agent/src/application/chat-run-event-hub.ts`

职责：

- 创建和缓存每个 Run 的 `ChatRunEventStream`。
- 发布事件。
- 建立带 Last-Event-ID 的订阅。
- 超过上限时关闭并淘汰最早 stream。
- 服务关闭时关闭所有 stream。

现有 `ChatRunEventStream` 继续只管理单个 Run 的 sequence、replay、subscriber 和 heartbeat。

### 5.10 `chat-runtime-defaults.ts`

建议文件：`packages/ssh-agent/src/application/chat-runtime-defaults.ts`

集中维护：

- 默认 Approval timeout。
- Run stream cache 上限。
- compaction reserve token 上限。
- compaction recent token 上限。

默认值使用导出的静态常量，不散落在构造函数或算法中。

## 6. 目标运行流程

### 6.1 创建 Run

```text
ChatService.createRun
  1. requestId 幂等查询
  2. active Session busy 检查
  3. Session、workDir、model、thinking level、provider auth、message 校验
  4. 获取 Session lease
  5. bindServerInteraction
  6. 持久化 pending ChatRun
  7. ChatContextService.load
  8. ChatAgentRuntimeFactory.create
  9. 注册 active Runtime
 10. 订阅 AgentEvent
 11. 异步 executeRun
```

第 4 步以后每个成功获取的资源必须登记对应 rollback。Runtime 注册成功前失败，由创建路径回滚；注册成功后统一由 Run finalization 释放。

### 6.2 Tool Call

```text
Agent beforeToolCall
  -> ChatToolCallCoordinator
    -> ChatToolAuthorizationPolicy.prepare
      -> allow / defer / block / approval
    -> ChatApprovalService.request
    -> ChatToolAuthorizationPolicy.recordDecision
    -> BeforeToolCallResult
```

SFTP overwrite 仍在 Tool 内触发 Approval，但 assistantMessageId 映射和 rejection continuation 由同一个 Tool Call Coordinator 管理。

### 6.3 Run 取消

```text
ChatService.cancelRun
  -> Runtime.requestCancellation
  -> ChatApprovalService.cancelRun
  -> ChatQueueService.cancelRun
  -> Runtime.abortAgent
```

不得调用 TerminalSession close。Terminal binding 只在 Run finalization 时解除。

### 6.4 Run 结束

```text
Agent prompt 结束或抛错
  -> 选择 completed / failed / cancelled
  -> 持久化并发布 run.updated
  -> completed 时调用 ChatContextService.compactCompletedRun
  -> ChatApprovalService.cancelRun
  -> ChatToolCallCoordinator.clearRun
  -> Runtime.dispose
  -> unbind Terminal Run
  -> active map delete
  -> release Session lease
```

每个释放步骤必须幂等，并使用独立 `try/finally`，不能因前一个释放失败而跳过后续步骤。

## 7. 分阶段实施

### 阶段 0：补齐行为基线

状态：已完成。

修改：只增加 characterization tests，不拆代码。

必须补充：

- createRun requestId 幂等和 Session busy。
- workDir、model、thinking level、provider auth、空消息失败。
- command/terminal Tool 集合互斥。
- Terminal binding 在构造失败时回滚。
- Agent prompt 成功、失败和 cancel 的 Run 终态。
- env cleanup、Terminal unbind 和 Session lease 各执行一次。
- Run 结束和服务 close 时 pending Approval/Queue 清理。

退出条件：所有现有行为有明确测试；发现的行为缺口记录为独立问题，不在结构提交中顺手改变。

### 阶段 1：Tool authorization 策略

状态：已完成。

已有结果：

- `ChatToolAuthorizationPolicy` 已独立。
- 已覆盖 read、SFTP defer、远端 Guard、`autoAudit`、Terminal submit、Terminal Guard 和非 submit action。
- `ChatService` 不再直接解析 Terminal Tool 参数。

后续只允许修正其窄接口，不把 Approval waiter 或 Agent callback 塞回策略类。

### 阶段 2：抽取 Event Hub 与默认值

风险：低。

状态：已完成。

修改：

- 新建 `ChatRunEventHub`。
- 移走 `streams`、`stream`、`publish`、cache eviction 和 close。
- 新建 `chat-runtime-defaults.ts`，迁移相关静态默认值。
- `ChatService.subscribe` 保留 Run 存在性校验，再委托 Event Hub。

测试：

- replay 和 live event 保持现有测试。
- 新增 cache 上限、淘汰时 close、全量 close、重复获取同一 stream。

退出条件：`ChatService` 不再 import `ChatRunEventStream`，不再拥有 stream map。

### 阶段 3：抽取 Approval Service

风险：中。

状态：已完成。

修改：

- 移走 `PendingApproval`、`ApprovalDecision`、`authorize`、`resolveApproval` 的具体实现和 approval list。
- pending waiter 从 Runtime 移入 `ChatApprovalService`。
- `cancelRun` 和 finalization 只调用 `approvalService.cancelRun`。
- timeout 默认值从静态常量文件读取。

测试：

- auto approval 立即持久化和发布。
- manual approve/reject。
- 重复同向决议幂等、反向决议 409。
- timeout。
- signal 已 abort 和等待中 abort。
- Run cancel。
- timer/listener/pending index 每条路径都清理。

退出条件：`ChatService` 不再创建 timer，不再监听 AbortSignal，不再维护 pending Approval map。

### 阶段 4：抽取 Tool Call Coordinator

风险：中。

状态：已完成。

修改：

- 移走 `beforeToolCall` callback 主体。
- 移走 SFTP overwrite Approval callback 和 toolCallId/assistantMessageId 映射。
- 统一 rejection reason 到 Agent Tool Result 的转换。
- Run finalization 清理 Tool Call 临时上下文。

测试：

- allow、defer、block、manual approval、auto approval。
- Terminal approve/reject 回写。
- SFTP assistantMessageId 关联、缺失上下文失败和 finally 清理。
- user rejection、timeout、run cancellation 的不同 terminate 语义。

退出条件：`ChatService` 中没有 Tool 名称分支，也没有 SFTP overwrite 文案和 Tool Call 临时 map。

### 阶段 5：抽取 Queue Service

风险：中。

状态：已完成。

修改：

- 移走 enqueue、cancelQueued、consume 和 Run cancel Queue 逻辑。
- 使用 `ChatQueueDriver` 隔离 Agent queue API。
- continuation callback 委托 Queue Service 取消 steer。

测试：

- requestId 幂等。
- steer 和 follow-up 正确入队。
- `reject_until_next_turn` 时新 steer 立即取消。
- 单项取消后 Agent queue 按剩余持久化消息重建。
- message_end 消费。
- Run cancel 取消全部 pending。
- rejection 后取消 steer 但保留 follow-up。

退出条件：`ChatService` 不再直接调用 `steer`、`followUp`、`clearSteeringQueue` 或 `clearFollowUpQueue`。

### 阶段 6：抽取 Context Service

风险：中低。

状态：已完成。

修改：

- 移走 `loadContextMessages` 和 `maybeCompact`。
- compaction 常量迁入静态默认值文件。
- Context Service 只接收模型和 Run 数据，不接收完整 Agent。

测试：

- 无 compaction 时加载全部消息。
- 有 compaction 时按 summary、retained tail、后续消息恢复。
- 未到阈值不执行。
- compaction success/failure 事件和持久化。
- messageSequence 边界。

退出条件：`ChatService` 不再 import compaction functions。

### 阶段 7：抽取 Agent Event Handler

风险：中。

状态：已完成。

修改：

- 移走 `handleAgentEvent`、`appendMessage`、`consumeQueuedMessage` 和 unsupported model helpers。
- 事件处理器通过 Queue Service、TerminalInteractionService、Model Catalog 和 Event Hub 完成投影。

测试：

- turn_start 的 steer 状态恢复和 Terminal processing。
- assistant/user message_end 持久化。
- unsupported model 目录删除、消息改写和 Runtime 标记。
- Terminal finished timeline。
- tool update 白名单 projection。
- message_update payload 不变。

退出条件：`ChatService` 不再 import `AgentEvent` 或 `toToolExecutionUpdateEvent`。

### 阶段 8：抽取 Runtime 和 Agent Runtime Factory

风险：高，应在前述 callback 已缩短后实施。

状态：已完成。

修改：

- 新建 `ChatRunRuntime`，封装互斥状态和幂等 dispose。
- 新建 `ChatAgentRuntimeFactory`，迁移 Node env、local tools、server tool、SFTP tools、system prompt 和 Agent options。
- Factory 只返回完整 Runtime；内部可使用局部引用解决 Agent callback 的自引用，不暴露未初始化状态。
- `ChatService.createRun` 只向 Factory 提供已验证的 Run、model、workDir、history 和 callbacks。

测试：

- command 模式 Tool 集合精确匹配。
- terminal 模式 Tool 集合精确匹配。
- system prompt 与模式匹配。
- local Tool 使用指定 workDir env。
- Agent steering/follow-up/toolExecution 配置不变。
- remote Tool abort callback 仍中止当前 Agent。
- Factory 失败时 env、Terminal binding 和 lease 正确回滚。
- Runtime dispose 重复调用只释放一次。

退出条件：`ChatService` 不再 import `Agent`、`NodeExecutionEnv` 和 Tool 创建函数。

### 阶段 9：收敛 ChatService Run 生命周期

风险：中高。

状态：已完成。

修改：

- `createRun` 收敛为显式 acquisition/rollback 顺序。
- `executeRun` 只决定 Run 终态、调用 compaction 和执行 finalization。
- `cancelRun` 只协调 Runtime、Approval 和 Queue。
- `close` 只遍历活动 Runtime 发起 abort/dispose，并关闭 Event Hub。
- 保留 active map，不为了隐藏一个 Map 新增无业务规则的 Registry wrapper。

测试：

- 每个 acquisition 点注入失败，验证已获取资源全部释放。
- prompt、compaction、env cleanup 和 Terminal unbind 分别失败时，其他释放动作仍执行。
- active map 只在 Runtime 可用后写入，并在所有终态删除。
- Session lease 精确释放一次。

退出条件：`ChatService` 只包含公开 use cases、Run 准备、活动 Run 约束、终态选择和最终协调。

### 阶段 10：装配、文档和死代码清理

风险：低。

状态：已完成。

修改：

- 在 `create-sqlite-management-backend.ts` 显式装配各组件。
- `ChatRepository.recoverInterrupted` 从 `ChatService` constructor 移到启动装配阶段，保留原调用时机。
- 测试中的直接 `new ChatService` 迁入共享 Chat test harness，避免每个测试重复装配所有 collaborators。
- 删除已经迁移的 private helpers、旧类型和无用 imports。
- 更新 AI Repo 文档、manifest source mapping 和 digest。

退出条件：没有双实现、兼容转发层或未使用旧路径。

## 8. 测试矩阵

| 维度 | 必须覆盖的行为 |
|---|---|
| Run 创建 | 幂等、busy、Session 缺失、workDir 缺失、模型缺失、thinking 不支持、Provider 未配置、空消息 |
| 模式 | command Tool 集合、terminal Tool 集合、TerminalSession binding 和 unbind |
| Tool authorization | read、write、bash、remote、Terminal submit/key/observe、未知 Tool、Guard block |
| Approval | auto、manual approve/reject、timeout、abort、cancel、重复决议、服务关闭 |
| SFTP | 无覆盖直接执行、上传覆盖审批、下载覆盖审批、autoAudit 不绕过 |
| Queue | steer、follow-up、幂等、单项取消、consume、Run cancel、审批拒绝后的 continuation |
| Agent events | delta、message_end、tool update、unsupported model、Terminal timeline |
| Run 终态 | completed、failed、cancelled、model removed、prompt exception |
| Context | history、compaction 恢复、阈值、成功、失败 |
| SSE | replay、live、heartbeat、cache eviction、close |
| 资源 | env、Approval waiter、Tool Call context、Terminal binding、Session lease、active map 均释放一次 |

单元测试优先使用 faux provider 和窄 fake，不使用真实模型 API。Chat 跨组件行为继续由 `chat-api.test.ts` 锁定。

## 9. 失败与回滚矩阵

| 失败位置 | 必须释放/收敛 |
|---|---|
| Session 或模型校验失败 | 不获取 Terminal binding，不创建 Run |
| 获取 lease 后校验失败 | release lease |
| Terminal binding 失败 | release lease，不创建 Run |
| Run 持久化后 Runtime 构造失败 | dispose 已创建 env、unbind Terminal、release lease；持久化 Run 的终态需按下节决策处理 |
| Agent prompt 失败 | Run failed、Approval/Queue 清理、Runtime dispose、Terminal unbind、active delete、lease release |
| compaction 失败 | 保持 Run completed，只发布 compaction.failed，继续全部资源清理 |
| env cleanup 失败 | 仍执行 Terminal unbind、active delete 和 lease release |
| Terminal unbind 失败 | 仍执行 active delete 和 lease release |
| 服务 close | abort Agent、结束 waiter、释放 Runtime、关闭 Event Hub；不关闭 TerminalSession |

## 10. 需要单独决定的行为缺口

这些问题由拆分审查发现，但不应在纯结构阶段隐式改变：

### 10.1 Run 已持久化但 Runtime 构造失败

当前可能留下 `pending` Run。推荐行为是将其收敛为 `failed`，错误码使用稳定的 Chat failure code，并补充注入式失败测试。该修改属于正确性修复，应与对应拆分阶段明确记录。

### 10.2 `close()` 是否改为异步

当前 `close(): void` 无法等待 env cleanup 和 Run finalization。推荐先保持签名不变完成拆分；如果服务器关闭流程需要等待资源释放，再单独评估改为 `Promise<void>`，并同步所有调用方。

### 10.3 cleanup 错误的可观测性

当前部分 cleanup 错误可能只影响内部 Promise。推荐后续增加结构化日志或内部诊断事件，但不把基础设施错误文本暴露到 Chat SSE 协议。

## 11. 禁止事项

- 不新增 `ChatManager`、`ChatHelper` 或只转发一个方法的 wrapper。
- 不按行数平均拆文件。
- 不让新组件反向调用 `ChatService`。
- 不让 Runtime Factory 访问 SQLite 或决定 Approval 规则。
- 不让 Approval Service 依赖 Agent。
- 不把 Queue 的 SQLite 与 Agent 同步拆成两个无协调者的模块。
- 不创建第二套 Run 状态或第二个 active map。
- 不保留旧路径作为兼容分支；每阶段完成后删除已迁移实现。
- 不在结构重构中修改 HTTP/SSE/SQLite 协议。
- 不同时实施前端功能、Terminal 新能力或新的 Tool。

## 12. 最终验收标准

完成全部阶段后必须满足：

- `ChatService` 不 import Agent 构造、Tool 构造、compaction、AgentEvent projection 或单 Run SSE 实现。
- `ChatService` 不包含 Tool 名称分支、Approval timer、Agent queue 具体调用或 stream cache。
- 每个可变资源有唯一所有者和幂等释放入口。
- `ChatApprovalService`、`ChatQueueService`、`ChatAgentEventHandler`、`ChatContextService`、`ChatAgentRuntimeFactory` 和 `ChatRunEventHub` 均有独立测试。
- 现有 Chat API 和 Terminal Interaction 集成测试全部通过。
- `npm run check` 无 error、warning 或 info。
- 修改过的测试文件均单独运行通过。
- `node docs/ssh-agent/ai-repo/check.mjs` 通过。
- 没有数据库 migration、HTTP 契约或前端行为变化，除非用户另行批准。

## 13. 推荐执行批次

建议按以下批次提交评审，每个批次可独立回滚：

1. 行为基线测试。
2. Event Hub 与静态默认值。
3. Approval Service。
4. Tool Call Coordinator。
5. Queue Service。
6. Context Service。
7. Agent Event Handler。
8. Runtime 与 Agent Runtime Factory。
9. ChatService 生命周期收敛和失败注入测试。
10. Runtime assembly、AI Repo、质量审查和死代码清理。

阶段 1 的 Tool authorization 策略已经完成，不需要重复实施。
