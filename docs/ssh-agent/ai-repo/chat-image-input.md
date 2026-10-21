# Chat 图片与文本附件输入代码路由

适用于 Session Attachment 被用户消息引用、图片和文本文件安全校验、模型能力检查、Provider 临时投影、文档 read 提示、消息关系持久化和压缩边界。

## 当前边界

- 创建 Run、`steer` 和 `follow_up` 可携带有序 `attachmentIds`。每条消息最多四个，不能重复；文本可为空，但文本和附件不能同时为空。
- Attachment 必须属于当前 Session。跨 Session ID 和不存在 ID 统一返回 `chat_attachment_not_found`，不泄露其他 Session 的附件存在性。
- 只有图片要求 `model.input.includes("image")`。文档可以使用纯文本模型；新图片消息、活动 Run 的图片 Queue，以及当前有效历史仍含图片引用时切换到纯文本模型，都会返回 `chat_model_image_input_unsupported`。历史模型检查重新查询当前 Session 附件并检查真实内容，不信任消息中的类型提示。
- 图片格式按文件签名识别，不信任上传时声明的 MIME。当前只接受 JPEG、PNG 和 WebP，并检查基础容器及尺寸信息。
- 文档支持 Markdown、TXT、JSON/JSONL、CSV/TSV、YAML、配置、日志和常见代码扩展，以及 Dockerfile、Makefile、点文件等文本名称。完整白名单集中在 `attachment-text-inspector.ts`；通过流式 UTF-8 严格解码校验全部字节，拒绝二进制控制字符，不按 MIME 判断真实类型。PDF、Word、Excel、音频和视频不属于文本附件。
- 文件路径只从后端 `storagePath` 构造。读取前检查目录链、拒绝符号链接，并通过文件句柄复核普通文件、大小和 20 MiB 上限；读取期间响应 Run 的 `AbortSignal`，结束时再次核对字节数和文件大小。
- Provider 请求前，用户文本先转成 `TextContent`，图片再按 ID 顺序转成 `ImageContent`。文档只在消息末尾追加服务端生成的文件名、绝对本地路径和使用现有 `read` 工具按需读取的提示，不注入正文。文件名和正文被明确视为不可信数据。纯附件消息不注入空文本；同一次请求中相同 Attachment 只准备一次。
- Base64 只存在于本次 Provider Context 的临时副本，不写回 Agent Context，也不进入消息、Queue、SSE、SQLite 或压缩摘要。
- `chat_message_attachments` 是普通用户消息附件关系和顺序的权威来源。`message_json` 继续完整保存 `attachmentIds`，但读取时以关系表恢复；同一 Attachment 可以关联多条消息。含文档的新消息另保存服务端校验产生的 `attachmentKinds` 供同步 Token 估算使用；客户端不能提交该字段，安全校验和 Provider 请求仍读取真实文件。旧的纯图片消息无需该字段。
- 消息历史的 Attachment HTTP 投影增加相对 `contentUrl`。该字段由 API 出口根据 Session 和 Attachment ID 生成，不持久化；浏览器通过受控图片内容接口按需回显，不读取 `storagePath`，消息历史仍不包含 Base64。
- 图片压缩投影使用文件名文本标记和空图片块计算成本；文档仅计算引用提示的文本成本，不添加图片占位或正文。压缩准备会保留文档路径和 read 提示供摘要引用。retained tail 恢复为原文本、`attachmentIds` 和类型提示，后续 Provider 请求再生成临时投影。

## 数据流

```text
Attachment upload
  -> Run/Queue attachmentIds
  -> chat_messages + chat_message_attachments
  -> ChatAttachmentService validates real content
  -> image: ephemeral pi-ai ImageContent
  -> document: ephemeral path + read instruction
  -> Models.streamSimple
```

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 用户消息扩展与附件 ID helper | `packages/ssh-agent/src/domain/chat-attachment.ts` |
| 引用校验、安全读取、Provider 与压缩投影 | `packages/ssh-agent/src/application/services/chat-attachment-service.ts` |
| Chat 与 HTTP 共用的图片格式识别 | `packages/ssh-agent/src/application/services/attachment-image-inspector.ts` |
| 文档名称白名单与流式 UTF-8 校验 | `packages/ssh-agent/src/application/services/attachment-text-inspector.ts` |
| Run、历史模型和 Queue 校验 | `packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/application/services/chat-queue-service.ts` |
| Provider 临时 Context 包装 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| 图片 Token 成本和 retained-tail 恢复 | `packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 关系表写入、读取和有序元数据投影 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts` |
| migration | `packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| HTTP 请求校验 | `packages/ssh-agent/src/api/request-validation.ts` |
| 错误本地化 | `packages/ssh-agent/src/i18n/public-error.ts`、`packages/ssh-agent/src/i18n/catalogs/` |
| 定向测试 | `packages/ssh-agent/test/chat-attachment-service.test.ts`、`packages/ssh-agent/test/chat-image-attachment-api.test.ts`、`packages/ssh-agent/test/chat-document-read-api.test.ts`、`packages/ssh-agent/test/chat-context-service.test.ts` |
| 前端联调契约 | [chat-image-attachment-integration.md](../frontend/chat-image-attachment-integration.md) |

修改该链路时必须同时检查：跨 Session 隔离、模型能力、文件替换竞态、关系表顺序、Queue 幂等、Provider Context 不反向污染，以及压缩记录中没有 Base64。
