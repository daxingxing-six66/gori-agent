# SSH Agent SSE 事件汇总

当前后端提供两条彼此独立的 SSE 通道：Workspace SSE 用于监控、连接和文件传输；Chat Run SSE 用于单次 Agent Run。PTY 不使用这两条通道。

## Workspace SSE

```http
GET /api/workspaces/{workspaceId}/events?topics=monitoring,connection,transfers
Accept: text/event-stream
```

`topics` 支持 `monitoring`、`connection`、`transfers`。省略时订阅全部 topic。

| SSE event | topic | data | 说明 |
|---|---|---|---|
| `stream.ready` | 不受过滤影响 | `{workspaceId, connectedAt}` | 连接建立后立即发送 |
| `monitor.snapshot` | `monitoring` | `RemoteMetricsSnapshot` | CPU、内存、文件系统、uptime 和 Top 20 进程 |
| `monitor.error` | `monitoring` | `{sampledAt, code, message}` | 单次采集失败；SSE 不关闭 |
| `connection.snapshot` | `connection` | `ConnectionPoolSnapshot` | Connection Pool 当前快照 |
| `transfer.updated` | `transfers` | `FileTransfer` | 上传或下载进度及六状态终态 |

`ConnectionPoolSnapshot`：

```ts
interface ConnectionPoolSnapshot {
  workspaceId: string;
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  activeChannels: number;
  waitingChannels: number;
  generation: number;
  connectedAt?: number;
  lastError?: { code: string; message: string };
}
```

`RemoteMetricsSnapshot` 和 `FileTransfer` 的完整 Schema 见 [sftp-overview-realtime-integration.md](./sftp-overview-realtime-integration.md)。

Workspace SSE 每 15 秒发送注释 heartbeat：

```text
: heartbeat

```

事件 ID 是后端进程内全局递增序号。Workspace SSE 不提供 `Last-Event-ID` 重放；重连后后端会重新发送连接快照和活动 Transfer，监控在下一次采样时恢复。

## Chat Run SSE

```http
GET /api/sessions/{sessionId}/chat/runs/{runId}/events
Accept: text/event-stream
Last-Event-ID: 12
```

### Pi Agent 基础事件

| SSE event | data | 说明 |
|---|---|---|
| `agent_start` | `{type:"agent_start"}` | Agent Run 开始 |
| `turn_start` | `{type:"turn_start"}` | 新的 Assistant Turn 开始 |
| `message_start` | `{type, message}` | User、Assistant 或 Tool Result 消息开始 |
| `message_update` | `{assistantMessageEvent}` | Assistant 流式 delta；不是累计消息 |
| `message_end` | `{type, message}` | 权威完整消息，可直接落入 UI 历史 |
| `tool_execution_start` | `{type, toolCallId, toolName, args}` | Tool 开始；包含已校验参数 |
| `tool_execution_update` | `{type, toolCallId, toolName, update}` | 白名单化的 `text/progress/status` 更新；不包含 `args` 或原始 `partialResult` |
| `tool_execution_end` | `{type, toolCallId, toolName, result, isError}` | 权威 Tool 终态和结果 |
| `turn_end` | `{type, message, toolResults}` | 当前 Turn 完成 |
| `agent_end` | `{type, messages}` | Agent 循环结束 |

SSH Connection、Channel、排队和命令 Operation 内部事件不会映射到 Chat SSE。`remote_server_call` 只产生 Pi 的 Tool start/end 事件。

`tool_execution_update.update` 的完整联合类型、校验规则、SFTP 时序和前端归约方式见 [Tool 流式更新协议](./tool-update-protocol.md)。

### Chat 控制事件

| SSE event | data | 说明 |
|---|---|---|
| `stream.ready` | `{runId, connectedAt}` | Chat SSE 建立成功；该事件没有 `id` |
| `run.updated` | `ChatRun` | Run 进入 `running/completed/failed/cancelled` |
| `queue.updated` | Queue patch | Queue 创建、消费或取消 |
| `approval.requested` | `ToolApproval` | 人工审批等待开始；`description` 提供可直接展示的场景文案 |
| `approval.resolved` | `ToolApproval` | 人工或自动审批已经决定；保留原审批 `description` |
| `compaction.started` | `{reason, attempt, tokensBefore, thresholdTokens, model}` | Provider 调用前或超限恢复时开始压缩 |
| `compaction.completed` | `{reason, attempt, messageId, sequence, tokensBefore, estimatedTokensAfter, reductionPercent, model}` | 摘要消息已持久化；可能继续第二次压缩 |
| `compaction.failed` | `{reason, attempt, code, message}` | 压缩失败；Run 使用相同稳定错误码结束 |
| `context.updated` | `ChatContextUsage` | 每个 Turn 结束及每次自动压缩保存摘要后发送完整占用快照 |

`queue.updated` 创建事件包含 `{id, behavior, status, message}`；消费或取消事件至少包含 `{id, status}`，审批拒绝/超时取消 steer 时还包含 `behavior:"steer"` 和 `resolvedAt`。Tool 拒绝或超时不会取消 follow-up，后者消费时产生 `status:"consumed"`。刷新恢复不能只依赖该 patch，应查询 Queue 接口取得完整对象。

Chat SSE 每 15 秒发送同样的注释 heartbeat。Run 内普通事件使用递增 `id`，Ring Buffer 最多保存最近 512 个事件。相同后端进程内可使用 `Last-Event-ID` 重放；进程重启后不保证 delta 重放。

压缩事件字段和手动压缩 HTTP 接口见 [Context Compaction 前端接口](./context-compaction-api.md)。手动压缩不创建 Chat Run，因此不发送这里的 SSE。

占用结构、刷新查询、手动响应和查询/SSE 竞态规则见 [上下文占用联调](./context-usage-integration.md)。刷新时同时调用 `GET chat/context-usage`，不从累计 Usage 或摘要模型的 Usage 推导占用。

## 前端恢复基线

Workspace 页面重连后使用目录、Transfer 列表和后端初始快照恢复。Chat 页面刷新或重连时按以下顺序恢复：

```text
GET chat/messages
  -> GET chat/runs/active
       -> run != null: GET run/queue?status=pending + connect Run SSE
  -> GET chat/approvals?status=pending
```

SSE 是实时增量通道，不是持久化查询接口。消息、Run、Queue、Approval 和 Transfer 的 HTTP 查询结果是刷新恢复的基线。
