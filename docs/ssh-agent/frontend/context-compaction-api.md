# Context Compaction 前端接口

本文描述后端协议及前端接入边界。

## 前端接入

- 真实 Session 的 `/` 和 `@` Composer Menu 都展示“压缩上下文”工具；新会话没有可压缩历史，不提供该操作。
- Session 加载、Chat Run 活动或手动压缩期间禁用入口。压缩请求期间阻止重复提交，并在 Session 切换或组件卸载时中止旧请求。
- 手动压缩成功后直接合并响应中的 `message`，无需等待 Chat Run SSE；`nothing_to_compact` 显示轻量提示。
- `compactionSummary` 在时间线中显示为可展开的系统摘要节点。自动压缩完成事件会触发消息增量同步，以取得服务端持久化的摘要消息。
- 请求失败直接展示后端错误信息，不在前端模拟压缩或修改历史消息。

## 全局 Setting

前端在全局设置弹窗的“上下文压缩”分类中读取和完整替换该配置：

- 自动压缩始终开启，界面不提供启停开关。
- 触发阈值使用 `1..99` 的整数滑杆编辑。
- 压缩模型复用有效 Provider/Model 目录，也可以选择“使用 Session 当前模型”，对应 `model=null`。
- 保存期间锁定设置弹窗，防止请求完成前卸载表单。
- `revision_conflict` 时刷新服务端 revision，并保留当前草稿供用户重新确认；其他错误直接展示后端消息。
- 已保存模型无法从当前目录解析时保持原始 `providerId/modelId`，不静默改写为 `null`，并提示运行时会回退到 Session 模型。

读取：

```http
GET /api/settings/compaction
```

完整替换：

```http
PUT /api/settings/compaction?expectedRevision=1
Content-Type: application/json
```

```json
{
  "triggerPercent": 80,
  "model": {
    "providerId": "anthropic",
    "modelId": "claude-sonnet-test"
  }
}
```

请求和响应模型：

```ts
interface ChatCompactionSettings {
  triggerPercent: number; // 整数，1..99
  model: { providerId: string; modelId: string } | null;
  revision: number;
  updatedAt: number;
}
```

`model=null` 表示使用 Session 当前模型。PUT 使用 query 中的 `expectedRevision` 做乐观并发控制；旧 revision 返回 `409 revision_conflict`。未知模型返回 `404 not_found`，`field="model"`。

Setting 是全局单行配置。自动压缩始终启用；每个 Chat Run 在创建时读取一次配置，运行中的 Run 不受后续修改影响。

## 手动压缩

```http
POST /api/sessions/{sessionId}/chat/compactions
```

不需要请求体。Session 有活动 Chat Run 或另一个手动压缩时返回 `409 chat_session_busy`。

没有可压缩内容：

```json
{
  "status": "skipped",
  "reason": "nothing_to_compact",
  "attempts": 0,
  "contextUsage": null
}
```

成功：

```ts
interface ManualCompactionCompleted {
  contextUsage: ChatContextUsage;
  status: "completed";
  reason: "manual";
  attempts: 1 | 2;
  message: ChatMessageProjection;
  tokensBefore: number;
  estimatedTokensAfter: number;
  reductionPercent: number;
  model: {
    providerId: string;
    modelId: string;
    fallback: boolean;
  };
}
```

手动压缩是同步 HTTP 请求，不发送 Chat Run SSE。`model.fallback=true` 表示配置的压缩模型不可用，本次实际使用了 Session 模型。

completed 和 skipped 都包含 `contextUsage`；skipped 也可能返回有效占用，无模型时为 null。结构及接入规则见 [上下文占用联调](./context-usage-integration.md)。自动压缩每次完成后另推送 `context.updated`。

## compact 消息

消息列表仍使用：

```http
GET /api/sessions/{sessionId}/chat/messages
```

压缩摘要作为普通 `ChatMessageProjection` 返回，`message.role="compactionSummary"`。它可能关联自动压缩的 `runId`；手动压缩消息没有 `runId`。前端可以把它作为时间线中的系统摘要节点，不应把 retained tail 再渲染成重复的聊天消息。

## 自动压缩 SSE

自动压缩沿用当前 Run SSE：

```ts
interface CompactionStarted {
  reason: "threshold" | "overflow";
  attempt: 1 | 2;
  tokensBefore: number;
  thresholdTokens: number;
  model: { providerId: string; modelId: string; fallback: boolean };
}

interface CompactionCompleted {
  reason: "threshold" | "overflow";
  attempt: 1 | 2;
  messageId: string;
  sequence: number;
  tokensBefore: number;
  estimatedTokensAfter: number;
  reductionPercent: number;
  model: { providerId: string; modelId: string; fallback: boolean };
}

interface CompactionFailed {
  reason: "threshold" | "overflow";
  attempt: 1 | 2;
  code:
    | "chat_context_overflow"
    | "chat_context_compaction_insufficient"
    | "chat_context_compaction_failed"
    | "chat_compaction_model_unavailable";
  message: string;
}
```

当 Provider 在尚未产生有效流式内容时报告上下文超限，第一次错误消息不会通过 `message_end` 暴露；后端先发送压缩事件并自动重试一次。已经产生有效内容或重试后再次超限时不再自动恢复。

Run 可能使用以下稳定 failure code：

- `chat_context_overflow`
- `chat_context_compaction_insufficient`
- `chat_context_compaction_failed`
- `chat_compaction_model_unavailable`

通用错误体保持：

```json
{
  "error": {
    "code": "chat_context_compaction_failed",
    "message": "Context compaction failed",
    "retryable": true
  }
}
```
