# Chat 图片与文本附件前端联调

后端支持在创建 Chat Run、`steer` 和 `follow_up` 时引用已经上传到当前 Session 的图片或文本 Attachment。请求只传 Attachment ID，不传 Base64、data URL、文件路径、文档正文或二进制内容。

## 调用顺序

1. 使用 [Session Attachment 接口](./session-attachment-api.md) 上传图片或文本文件。
2. 取得上传响应中的 `id`。
3. 把有序 ID 数组作为 `attachmentIds` 随 Chat 请求提交。

## 创建 Run

```http
POST /api/sessions/:sessionId/chat/runs
Content-Type: application/json
Accept-Language: zh-CN
```

```json
{
  "requestId": "request-1",
  "providerId": "anthropic",
  "modelId": "vision-model",
  "thinkingLevel": "medium",
  "message": "比较这两张截图",
  "attachmentIds": ["attachment-2", "attachment-1"],
  "serverInteractionMode": "command"
}
```

`attachmentIds` 可省略。图片按数组顺序输入模型，文档引用和 read 提示在消息末尾追加。纯附件消息允许 `message: ""`；如果文本为空且数组为空，返回 `chat_message_invalid`。

相同 `sessionId + requestId` 的幂等重试返回原 Run，不会重复创建消息或附件关系。

## Queue

```http
POST /api/sessions/:sessionId/chat/runs/:runId/queue
Content-Type: application/json
```

```json
{
  "requestId": "queue-1",
  "behavior": "follow_up",
  "message": "再检查这一张",
  "attachmentIds": ["attachment-3"]
}
```

`steer` 和 `follow_up` 使用同一规则。只有包含图片才要求活动 Run 模型支持图片输入；文档允许纯文本模型。`queue.updated` 的 pending payload 在有附件时增加 `attachmentIds`：

```json
{
  "id": "queue-item-1",
  "behavior": "follow_up",
  "status": "pending",
  "message": "再检查这一张",
  "attachmentIds": ["attachment-3"]
}
```

## 消息查询

`GET /api/sessions/:sessionId/chat/messages` 的分页结构不变。携带附件的普通用户消息增加有序附件元数据：

```ts
interface ChatMessageProjection {
  id: string;
  sequence: number;
  runId?: string;
  message: AgentMessage & { attachmentIds?: string[] };
  attachments?: Attachment[];
  createdAt: number;
}
```

其中 `Attachment` 增加后端生成的相对 `contentUrl`。同源部署可以直接交给 `<img src>`；不同源部署应使用既有后端 API Base URL 解析该地址。前端不需要读取 `storagePath`、请求 Base64 或自行创建 Blob URL。

```json
{
  "id": "message-1",
  "sequence": 1,
  "runId": "run-1",
  "message": {
    "role": "user",
    "content": "比较这两张截图",
    "attachmentIds": ["attachment-2", "attachment-1"],
    "timestamp": 1787651000000
  },
  "attachments": [
    {"id":"attachment-2","sessionId":"session-1","name":"b.png","mimeType":"image/png","size":1200,"storagePath":"attachments/sessions/session-1/b.png","contentUrl":"/api/sessions/session-1/attachments/attachment-2/content","createdAt":1787650999000},
    {"id":"attachment-1","sessionId":"session-1","name":"a.jpg","mimeType":"image/jpeg","size":1500,"storagePath":"attachments/sessions/session-1/a.jpg","contentUrl":"/api/sessions/session-1/attachments/attachment-1/content","createdAt":1787650998000}
  ],
  "createdAt": 1787651000000
}
```

只有携带附件的普通用户消息返回 `attachments`。前端使用 `contentUrl` 按需回显图片，不得读取或提交 `storagePath`；它只是后端管理的存储元数据。

文本附件显示文件名、大小和可点击卡片。点击后向通用文件阅读器传递 Session/附件 ID，经 `GET /api/sessions/:sessionId/attachments/:attachmentId/text` 获取内容，复用右侧 Tab、Markdown 预览与代码高亮；不把附件路径塞进 `/local-files/content`。

含文档的消息还可能带有服务端生成的 `attachmentKinds`，仅用于上下文估算；客户端不提交或据此绕过模型/文件校验。模型请求中的文档提示是临时投影，不改写用户消息原文。

Chat SSE 的 `message_start` 和 `message_end` 用户消息会保留 `attachmentIds`，但不会携带 Attachment 二进制、Base64、data URL 或宿主机绝对路径。

## 限制

- 每条消息最多四个图片/文本附件，ID 必须是非空、不重复的字符串。
- Attachment 必须属于请求 URL 中的 Session；同一 Attachment 可被多条消息复用。
- 图片实际输入支持 JPEG、PNG、WebP。其他浏览器可解码的图片会在本地转换为 PNG，超过 2048px 时等比缩小；无法解码则明确失败。动画图片只取浏览器解码画面，不保留动画。
- 文档支持 Markdown/TXT、JSON、CSV、YAML、日志、配置及常见代码类型；浏览器和后端都严格校验 UTF-8，拒绝二进制控制字符。完整名称白名单见 `attachment-text-inspector.ts`。
- 单文件仍沿用 20 MiB 上限，没有额外的消息合计大小限制。
- 只有图片要求模型目录中的目标模型声明支持 `image` 输入。文档正文不会自动注入请求；后端末尾追加可信本地路径与 `read` 提示，模型主动调用工具后才读取正文。
- 当前有效历史仍有图片引用时，不能切换到纯文本模型。
- PDF、Word、Excel、视频、音频、图片生成和 Assistant 图片输出未接入。浏览器不能解码的图片不能上传到 Chat。

## 稳定错误码

| code | HTTP | 含义 |
|---|---:|---|
| `chat_attachment_ids_invalid` | 400 | `attachmentIds` 不是数组、包含空 ID 或重复 ID |
| `chat_attachment_limit_exceeded` | 400 | 单条消息超过四个附件 |
| `chat_attachment_not_found` | 404 | Attachment 不存在或不属于当前 Session |
| `chat_attachment_image_format_unsupported` | 415 | 不属于受支持的图片或文本附件；保留原错误码兼容 |
| `chat_attachment_content_invalid` | 415 | 图片容器或基础尺寸信息损坏 |
| `chat_attachment_text_invalid` | 415 | 文档不是严格 UTF-8 或含二进制控制字符 |
| `chat_attachment_changed` | 409 | 上传后的文件大小或内容在读取时发生变化 |
| `chat_attachment_storage_unavailable` | 500 | 后端无法安全读取 Attachment 存储 |
| `chat_model_image_input_unsupported` | 409 | 当前模型不支持图片输入 |

错误响应继续使用统一结构，`message` 按 Locale 本地化；程序分支只依赖稳定 `code`。

## 前端安全边界

- 不要把图片转成 Base64 放进 Chat JSON。
- 不要把 `storagePath` 作为文件下载地址或本地路径。
- 上传成功后使用响应中的最终 `name` 和 `contentUrl`；本地预览对象 URL 只作为上传完成前的临时展示。
- 输入区回形针按钮支持选择多个文件，粘贴和拖放复用同一上传状态 Hook；仅粘贴文档 File 时不把伴随剪贴板正文插入草稿。上传中、失败、移除、取消和 Session 切换均保留原附件隔离规则。文档上传后和发送后均可点击查看。
- EventSource 仍按现有方式传递 `locale`；本功能没有新增 SSE 事件类型。
