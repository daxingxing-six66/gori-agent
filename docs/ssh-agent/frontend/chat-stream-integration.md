# Chat Stream 前端联调

## 业务背景

Chat 绑定现有 Session 和 Workspace。消息调用配置好的 LLM Provider；本地文件工具使用 Session 本机目录，远端命令使用 Workspace SSH 连接。前端只展示 Pi Agent 基础事件、审批、队列、Run 和压缩结果，不展示 SSH 内部连接阶段。

## Session

创建：`POST /api/workspaces/{workspaceId}/sessions`

```json
{"displayName":"Incident","workDir":"~/projects/demo","autoAudit":false}
```

更新：`PATCH /api/sessions/{sessionId}`

```json
{"workDir":null,"autoAudit":true,"expectedRevision":2}
```

`workDir=null` 表示使用 `SSH_AGENT_LOCAL_CWD`。活动 Run 期间修改 `workDir` 或 `autoAudit` 返回 `409 session_has_active_chat_run`。

`autoAudit=true` 时，后端会自动批准本地 `write`、`bash`、远端 `remote_server_call` 及 `sftp_upload`/`sftp_download` 的文件覆盖，并产生 `source="auto"` 的 Approval 审计记录。`read` 始终无需审批。远端命令仍先经过 Workspace Guard；命中 Guard 时不会创建 Approval，也不会执行 Tool。

查询 Session 详情：`GET /api/sessions/{sessionId}`。响应保留 Session 原有字段，并增加最近一次成功创建的 Chat Run 模型选择：

```ts
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface ChatModelSelection {
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

type SessionDetails = Session & {
  chatModelSelection: ChatModelSelection | null;
};
```

```json
{
  "id": "session-1",
  "workspaceId": "workspace-1",
  "displayName": "Incident",
  "workDir": null,
  "autoAudit": false,
  "terminalContextCursor": 0,
  "revision": 1,
  "createdAt": 1787651000000,
  "updatedAt": 1787651000000,
  "chatModelSelection": {
    "providerId": "anthropic",
    "modelId": "claude-sonnet-test",
    "thinkingLevel": "medium"
  }
}
```

没有历史 Chat Run 时 `chatModelSelection=null`。该值来自 `chat_runs`，不会写入 Session，也不会出现在 Workspace Session Tree 中。历史模型被移除或认证失效时仍会回显；下一次 Run 会按当前模型目录和认证状态重新校验。

## Run

`POST /api/sessions/{sessionId}/chat/runs`

```json
{"requestId":"req-1","providerId":"openai","modelId":"gpt-4.1","thinkingLevel":"medium","message":"检查服务状态","attachmentIds":["attachment-1"],"serverInteractionMode":"command"}
```

`attachmentIds` 可省略；图片输入的上传顺序、模型能力和错误码见 [Chat 图片附件前端联调](./chat-image-attachment-integration.md)。

响应 Schema：

```ts
interface ChatRun {
  id: string; sessionId: string; workspaceId: string; requestId: string;
  providerId: string; modelId: string; thinkingLevel: ThinkingLevel;
  status: "pending" | "running" | "completed" | "failed" | "cancelled";
  failure?: { code: string; message: string; retryable: boolean };
  createdAt: number; startedAt?: number; finishedAt?: number; updatedAt: number;
}
```

相同 `sessionId + requestId` 返回已有 Run。活动 Run 再创建返回 `409 chat_session_busy`。

首次 Run 必须同时提供 `providerId` 和 `modelId`。后续 Run 可以省略两者，后端会复用该 Session 最近一次 Run 的 Provider、Model 和 thinking level：

```json
{"requestId":"req-2","message":"继续检查"}
```

继承和切换规则：

- `providerId` 与 `modelId` 必须同时提供或同时省略。
- 两者省略时复用最近模型；可单独提供 `thinkingLevel` 修改最近模型的强度。
- 显式提交与上次相同的 Provider/Model 且省略 `thinkingLevel` 时，继承上次强度。
- 显式切换 Provider/Model 且省略 `thinkingLevel` 时使用 `off`。
- 每次创建都会重新校验模型是否存在、Provider 是否已配置，以及模型是否支持指定强度。
- 幂等请求先按 `sessionId + requestId` 返回原 Run，不使用后来的模型选择覆盖原结果。

取消：`POST /api/sessions/{sessionId}/chat/runs/{runId}/cancel`。

### 刷新后查询活动 Run

`GET /api/sessions/{sessionId}/chat/runs/active`

始终返回 `200`：

```ts
interface GetActiveChatRunResponse {
  run: ChatRun | null;
}
```

有活动 Runtime 时：

```json
{
  "run": {
    "id": "run-1",
    "sessionId": "session-1",
    "workspaceId": "workspace-1",
    "requestId": "req-1",
    "providerId": "anthropic",
    "modelId": "claude-sonnet-test",
    "thinkingLevel": "medium",
    "status": "running",
    "createdAt": 1787651000000,
    "startedAt": 1787651000001,
    "updatedAt": 1787651000001
  }
}
```

没有活动 Runtime 时返回 `{"run":null}`。Session 不存在返回 `404 chat_session_not_found`。服务重启不会恢复 Run；启动恢复会先将遗留 `pending/running` Run 标记为 `failed + chat_run_interrupted`，因此接口返回 `run=null`。

## 固定头部与模式记录

头部在首次 Run 初始化并保存快照，后续会话运行不修改。内容含初始本地目录、本地 OS 类型/版本/架构和配置的远端地址/端口；不含远端工作区名称及默认目录。旧会话在升级后的下一次 Run 初始化一次。

Terminal 开启/关闭不提交普通聊天输入；服务端随状态提交追加模式 system 记录，和其他消息共用分页 sequence。前端应接受下列 AgentMessage 分支，保留其历史身份，不将其渲染为 Assistant 气泡：

```ts
interface RuntimeSystemMessage {
  role: "system";
  content: Array<{ type: "text"; text: "<terminal-model-on>" | "<terminal-model-off>" }>;
  runtimeEventId: string;
  runtimeMode: "command" | "terminal";
  timestamp: number;
}
```

模式记录没有 runId。相同 timestamp 下的不同 runtimeEventId 不能合并；前端不能伪造 system role，Run/Queue 请求仍只提交普通文本/附件。头部和 Tool 定义在模式切换时保持不变，后端另有执行门禁。

聊天当前支持按历史位置保留 system 消息的 OpenAI Chat Completions、Responses、Mistral API；其他协议在创建前返回 `409 chat_system_messages_unsupported`。这项校验与 Provider 管理目录分开：历史模型选择仍可回显，使用不支持协议的旧会话需选择兼容模型再继续。第三方兼容服务的实际行为以服务端协议为准。

## 消息和队列

消息接口支持互补的向前与向后游标分页：

```http
GET /api/sessions/{sessionId}/chat/messages?limit=100
GET /api/sessions/{sessionId}/chat/messages?beforeSequence=901&limit=100
GET /api/sessions/{sessionId}/chat/messages?afterSequence=1200&limit=100
```

- 未传游标时返回最新一页。
- `beforeSequence` 返回排他边界之前、距离边界最近的一页，用于向上加载更早历史。
- `afterSequence` 返回排他边界之后最早的一页，用于首次完整恢复、SSE 重连和持久化补偿。显式传入 `afterSequence=0` 会从 Session 第一条消息开始。
- `beforeSequence` 和 `afterSequence` 不能同时使用；同时传入返回 `400 validation_error`，错误字段为 `beforeSequence`。
- `limit` 默认为 100，范围为 1 到 100。所有页面内部始终按 `sequence` 从小到大排序。

```typescript
interface ListChatMessagesResponse {
  messages: Array<{
    id: string;
    sequence: number;
    runId?: string;
    message: AgentMessage;
    attachments?: Attachment[];
    createdAt: number;
  }>;
  nextBeforeSequence: number | null;
  nextSequence: number | null;
}
```

`nextBeforeSequence` 有值时等于本页最早消息的 `sequence`，可直接用于下一次 `beforeSequence`；为 `null` 表示当前方向已到最早消息。`nextSequence` 有值时等于本页最后消息的 `sequence`，可直接用于下一次 `afterSequence`；为 `null` 表示当前方向没有更晚消息。无游标和 `beforeSequence` 查询只产生 `nextBeforeSequence`，`afterSequence` 查询只产生 `nextSequence`；另一个字段固定为 `null`。空页的两个字段都为 `null`。

压缩摘要也通过该接口作为普通消息返回，`message.role="compactionSummary"`，与用户、Assistant 和 Tool Result 消息遵循相同分页规则。Context 从最新摘要边界继续构造，但旧消息不会从数据库或历史接口删除。全局压缩 Setting、手动压缩和摘要消息字段见 [Context Compaction 前端接口](./context-compaction-api.md)。

`POST /api/sessions/{sessionId}/chat/runs/{runId}/queue`

```json
{"requestId":"queue-1","behavior":"steer","message":"先检查日志","attachmentIds":["attachment-1"]}
```

`steer` 在当前 turn 后注入，`follow_up` 在 Agent 原本结束时注入。取消未消费项：`DELETE .../queue/{queueItemId}`。

### 将待执行消息改为立即引导

`POST /api/sessions/{sessionId}/chat/runs/{runId}/queue/{queueItemId}/steer`，无请求体。

返回 `200 ChatQueueItem`（结构见下方），同一记录的 `behavior` 变为 `steer`，仍为 `pending`。ID、requestId、原始消息、附件顺序和创建时间保持不变，同时发布 `queue.updated`。已是 pending steer 的重复请求返回原记录，不重复注入。其余 follow-up 保持原顺序。

仅当前活动且仍接受引导的 Run 可转换；停止中、已结束或审批拒绝后暂不接受引导时返回 `409 chat_run_not_active`。当前 Run 下找不到 pending 项（包括已消费、已取消或不属于该 Run）返回 `404 chat_queue_item_not_found`。

前端普通发送始终加入 follow_up，队列行的回车图标调用此接口；不要删除后重新提交。成功只更新队列行为，不提前插入聊天记录。接口响应可能晚于消费事件，不能把 consumed/cancelled 改回 pending。立即引导仍在 Agent 的引导检查点生效，不强行中断正在执行的命令。

用户拒绝 Tool 或审批超时后，后端会停止当前 Turn 基于 Tool Result 的自动延续，并把当前 Run 尚未消费的 steer 更新为 `cancelled`；follow-up 不会一起取消，而是按 FIFO 作为新的 User Turn 继续。拒绝到当前 Turn 完成之间新提交的 steer 会直接返回 `cancelled`。前端应以 `queue.updated` 和 Queue 查询结果更新展示，不要把 Tool 拒绝显示为整个 Run 失败。

刷新后查询 Queue：

`GET /api/sessions/{sessionId}/chat/runs/{runId}/queue?status=pending`

`status` 可选值为 `pending`、`consumed`、`cancelled`，默认 `pending`。

```ts
interface ChatQueueItem {
  id: string;
  sessionId: string;
  runId: string;
  requestId: string;
  behavior: "steer" | "follow_up";
  message: AgentMessage;
  status: "pending" | "consumed" | "cancelled";
  createdAt: number;
  resolvedAt?: number;
}

interface ListChatQueueResponse {
  items: ChatQueueItem[];
}
```

```json
{
  "items": [
    {
      "id": "queue-1",
      "sessionId": "session-1",
      "runId": "run-1",
      "requestId": "queue-request-1",
      "behavior": "follow_up",
      "message": {"role":"user","content":"完成后汇总","timestamp":1787651001000},
      "status": "pending",
      "createdAt": 1787651001000
    }
  ]
}
```

取消整个 Run 时，尚未消费的 Queue 项会一起变为 `cancelled`。

## 审批

查询：`GET /api/sessions/{sessionId}/chat/approvals?status=pending`。

决定：`POST .../approvals/{approvalId}/approve` 或 `/reject`。

```ts
interface ToolApproval {
  id: string; sessionId: string; runId: string; assistantMessageId: string;
  toolCallId: string; toolName: string; description: string;
  status: "pending" | "approved" | "rejected";
  source?: "user" | "auto";
  rejectionReason?: "user_rejected" | "timeout" | "run_cancelled" | "server_restarted";
  createdAt: number; resolvedAt?: number;
}
```

`description` 是后端生成并持久化的审批场景文案，前端可在同一通用审批组件中直接展示，不需要根据 `toolName` 分支拼接。SFTP 覆盖审批分别返回：

```text
远程文件 /srv/releases/app.tar 已存在。继续执行将覆盖该文件，是否继续执行？
本地文件 /srv/releases/app.tar 已存在。继续执行将覆盖该文件，是否继续执行？
```

其中路径替换为本次覆盖目标的实际路径。Session 关闭 `autoAudit` 时，SFTP 文件覆盖产生 `status="pending"` 的人工审批；开启时直接批准，不等待用户操作，记录 `status="approved"`、`source="auto"`。提交时才出现的并发同名普通文件也遵循此策略；目录、符号链接和特殊文件仍不能覆盖。

响应字段和 SSE 类型不变。前端只根据 `approval.requested` 展示需要操作的审批，不应仅凭 Tool 的短暂 `waiting_for_approval` 进度状态弹出确认；该状态也可能立即被自动批准和后续传输进度替换。

Tool 参数从 Assistant Message 的 tool call 读取；审批事件不重复携带大型 `write.content`。

自动审批不会出现 `approval.requested`；后端直接发送 `approval.resolved`，payload 中为 `status="approved"` 且 `source="auto"`。

拒绝和超时都会生成配对的错误 Tool Result，但不会执行 Tool。LLM 历史中的结果文本会明确区分 `user_rejected` 与 `timeout`；没有 follow-up 时 Run 正常进入 `completed`。

## SSE

上下文占用新增 `context.updated` 控制事件，每次 Turn 结束和自动压缩保存摘要后推送。打开或刷新 Session 使用 `GET /api/sessions/{sessionId}/chat/context-usage`，手动压缩读取 HTTP 响应中的 `contextUsage`。完整结构和竞态处理见 [上下文占用联调](./context-usage-integration.md)。

`GET /api/sessions/{sessionId}/chat/runs/{runId}/events`，支持 `Last-Event-ID` 同进程 Ring Buffer 重放，每 15 秒 heartbeat。

Pi 事件：`agent_start`、`turn_start`、`message_start`、`message_update`、`message_end`、`tool_execution_start`、`tool_execution_update`、`tool_execution_end`、`turn_end`、`agent_end`。

控制事件：`stream.ready`、`run.updated`、`queue.updated`、`approval.requested`、`approval.resolved`、`compaction.started`、`compaction.completed`、`compaction.failed`。压缩事件的完整 payload 见 [Context Compaction 前端接口](./context-compaction-api.md)。

`message_update.data.assistantMessageEvent` 是 delta；最终消息以 `message_end` 为准。`tool_execution_update` 使用收敛后的 `text/progress/status` 协议，不再发送原始 `partialResult`，详见 [Tool 流式更新协议](./tool-update-protocol.md)。SSE 断开不取消 Run，重连后应同时查询消息和 pending approval。

推荐的刷新恢复顺序：

1. 查询消息历史。
2. 查询当前活动 Run。
3. `run != null` 时连接该 Run SSE，并查询 pending Queue。
4. 查询 pending Approval。

完整的 Workspace SSE 和 Chat SSE 事件、payload 及恢复规则见 [sse-events-reference.md](./sse-events-reference.md)。

## 常用错误

```text
chat_session_busy
chat_session_not_found
chat_run_not_found
chat_run_not_active
chat_model_not_found
chat_system_messages_unsupported
chat_prompt_not_initialized
chat_model_selection_invalid
chat_model_selection_required
chat_thinking_level_unsupported
chat_provider_not_configured
chat_message_invalid
chat_attachment_ids_invalid
chat_attachment_limit_exceeded
chat_attachment_not_found
chat_attachment_image_format_unsupported
chat_attachment_content_invalid
chat_attachment_changed
chat_attachment_storage_unavailable
chat_model_image_input_unsupported
session_work_dir_unavailable
session_has_active_chat_run
approval_not_found
approval_already_resolved
chat_queue_item_not_found
chat_context_overflow
chat_context_compaction_insufficient
chat_context_compaction_failed
chat_compaction_model_unavailable
```

通用错误体：

```json
{"error":{"code":"chat_session_busy","message":"Session already has an active Chat Run"}}
```
