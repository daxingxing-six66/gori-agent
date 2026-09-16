# Chat 图片输入代码路由

适用于 Session Attachment 被用户消息引用、图片文件安全读取、模型能力校验、Provider 多模态投影、消息关系持久化和压缩边界。

## 当前边界

- 创建 Run、`steer` 和 `follow_up` 可携带有序 `attachmentIds`。每条消息最多四个，不能重复；文本可为空，但文本和附件不能同时为空。
- Attachment 必须属于当前 Session。跨 Session ID 和不存在 ID 统一返回 `chat_attachment_not_found`，不泄露其他 Session 的附件存在性。
- 所选模型必须满足 `model.input.includes("image")`。新图片消息、活动 Run 的图片 Queue，以及当前有效历史仍含图片引用时切换到纯文本模型，都会返回 `chat_model_image_input_unsupported`。
- 图片格式按文件签名识别，不信任上传时声明的 MIME。当前只接受 JPEG、PNG 和 WebP，并检查基础容器及尺寸信息。
- 文件路径只从后端 `storagePath` 构造。读取前检查目录链、拒绝符号链接，并通过文件句柄复核普通文件、大小和 20 MiB 上限；读取期间响应 Run 的 `AbortSignal`，结束时再次核对字节数和文件大小。
- Provider 请求前，用户文本先转成 `TextContent`，图片再按 ID 顺序转成 `ImageContent`。纯图片消息不注入空文本。一次 Provider 请求中相同 Attachment 只读取一次。
- Base64 只存在于本次 Provider Context 的临时副本，不写回 Agent Context，也不进入消息、Queue、SSE、SQLite 或压缩摘要。
- `chat_message_attachments` 是普通用户消息附件关系和顺序的权威来源。`message_json` 继续完整保存 `attachmentIds`，但读取时以关系表恢复；同一 Attachment 可以关联多条消息。
- 消息历史的 Attachment HTTP 投影增加相对 `contentUrl`。该字段由 API 出口根据 Session 和 Attachment ID 生成，不持久化；浏览器通过受控图片内容接口按需回显，不读取 `storagePath`，消息历史仍不包含 Base64。
- 图片压缩投影使用文件名文本标记和空图片块计算成本。retained tail 恢复为文本加 `attachmentIds`；进入摘要区的旧图片只留下文件名标记。

## 数据流

```text
Attachment upload
  -> Run/Queue attachmentIds
  -> chat_messages + chat_message_attachments
  -> ChatAttachmentService validates and reads
  -> ephemeral pi-ai ImageContent
  -> Models.streamSimple
```

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 用户消息扩展与附件 ID helper | `packages/ssh-agent/src/domain/chat-attachment.ts` |
| 引用校验、安全读取、Provider 与压缩投影 | `packages/ssh-agent/src/application/services/chat-attachment-service.ts` |
| Chat 与 HTTP 共用的图片格式识别 | `packages/ssh-agent/src/application/services/attachment-image-inspector.ts` |
| Run、历史模型和 Queue 校验 | `packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/application/services/chat-queue-service.ts` |
| Provider 临时 Context 包装 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| 图片 Token 成本和 retained-tail 恢复 | `packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 关系表写入、读取和有序元数据投影 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts` |
| migration | `packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| HTTP 请求校验 | `packages/ssh-agent/src/api/request-validation.ts` |
| 错误本地化 | `packages/ssh-agent/src/i18n/public-error.ts`、`packages/ssh-agent/src/i18n/catalogs/` |
| 定向测试 | `packages/ssh-agent/test/chat-attachment-service.test.ts`、`packages/ssh-agent/test/chat-image-attachment-api.test.ts`、`packages/ssh-agent/test/chat-context-service.test.ts` |
| 前端联调契约 | [chat-image-attachment-integration.md](../frontend/chat-image-attachment-integration.md) |

修改该链路时必须同时检查：跨 Session 隔离、模型能力、文件替换竞态、关系表顺序、Queue 幂等、Provider Context 不反向污染，以及压缩记录中没有 Base64。
