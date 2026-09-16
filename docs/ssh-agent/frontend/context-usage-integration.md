# Session 上下文占用联调

本功能展示当前有效上下文的估算占用，不是 Session 累计 Token 消耗或费用。前端无需计算 Token，也不需要读取附件内容。

## 统一数据结构

```ts
interface ChatContextUsage {
  contextTokens: number;
  contextWindow: number;
  usagePercent: number;
  source: "estimated";
  providerId: string;
  modelId: string;
}
```

`contextTokens` 复用后端上下文估算和 provider/model 校准，覆盖有效消息、图片成本、System Prompt 和工具定义。底层估算可以使用适用的历史 Usage 加后续消息成本，不等于纯字符统计，也不等于最近一次请求的输入 Usage。

`contextWindow` 属于聊天模型，不属于摘要模型。`usagePercent` 保留至多两位小数，允许超过 100%。建议显示“约 42.8k / 200k · 21.4%”；进度条可限制视觉宽度，但保留实际百分比。Token 数据和模型 ID 不随 Locale 改变。

未消费 Queue、正在流式生成但尚未完成的消息不计入。压缩后只统计最新摘要、retained tail 和后续消息。校准系数仅在进程内保存，服务重启后估算可能轻微变化。

## 打开或刷新 Session

```http
GET /api/sessions/{sessionId}/chat/context-usage
Accept-Language: zh-CN
```

```json
{
  "contextUsage": {
    "contextTokens": 42800,
    "contextWindow": 200000,
    "usagePercent": 21.4,
    "source": "estimated",
    "providerId": "provider-id",
    "modelId": "model-id"
  }
}
```

有活动 Run 时按活动 Runtime 统计；无活动 Run 时按最近一次 Run 的模型和交互模式统计。查询不发起模型请求，不校验凭证、不触发压缩，响应为 `Cache-Control: no-store`。

无历史 Run 或最近模型已移除：`200 { "contextUsage": null }`。前端隐藏占用或显示“暂无数据”，不要显示 0%。Session 不存在返回 `404 chat_session_not_found`，沿用通用错误体。

首版不计算尚未发送的输入框草稿、附件选择或模型切换预览。

## 运行中 SSE

沿用现有 Run 连接：

```http
GET /api/sessions/{sessionId}/chat/runs/{runId}/events?locale=zh-CN
```

新增命名事件，`data` 直接是完整快照，没有 `contextUsage` 外层：

```text
id: 42
event: context.updated
data: {"contextTokens":42800,"contextWindow":200000,"usagePercent":21.4,"source":"estimated","providerId":"provider-id","modelId":"model-id"}
```

- 每个 `turn_end` 之后推送一次；一个 Run 可以有多个 Turn。
- 每次自动压缩保存摘要后，在 `compaction.completed` 之后推送一次；连续两次压缩各推送一次。
- 不在每个 Tool Result、Provider 请求前或 Run 结束时额外推送。
- 前端直接替换当前快照，不累加 Token。只接收当前 Session/Run 的事件。
- 支持现有同进程 `Last-Event-ID` 重放。服务重启或重放缓存淘汰后，通过查询接口恢复。

初始化时连接活动 Run SSE，同时查询占用。每次查询开始记录当前本地更新计数；查询返回时，只有 Session/Run 未变化且计数未增加才应用结果。收到 SSE 或手动压缩响应后增加计数，避免迟到的查询覆盖新快照。切换 Session 时取消旧查询并关闭旧连接；重连后可重新查询。

## 手动压缩

```http
POST /api/sessions/{sessionId}/chat/compactions
```

原有 completed/skipped 响应新增 `contextUsage`：成功为 `ChatContextUsage`，skipped 为 `ChatContextUsage | null`。没有历史消息和模型时示例：

```json
{"status":"skipped","reason":"nothing_to_compact","attempts":0,"contextUsage":null}
```

成功后同时处理原有摘要 `message` 和新占用快照。手动压缩没有 Run SSE。请求失败沿用原错误处理；若压缩已保存摘要但后续判断失败，可再次查询占用以获得已保存状态。

## 验收

1. 刷新已结束的 Session，无活动 SSE 也能显示占用。
2. 工具循环每个 Turn 更新一次；单纯 delta 不更新占用。
3. 自动压缩后占用反映新摘要，不重新累计旧历史。
4. 手动压缩完成后立即应用 HTTP 中的占用。
5. 新 Session、模型移除、切换 Session、SSE 重连和迟到查询正确处理。

完整压缩接口见 [context-compaction-api.md](./context-compaction-api.md)。本次仅提供后端和协议文档，前端接入需单独实现。
