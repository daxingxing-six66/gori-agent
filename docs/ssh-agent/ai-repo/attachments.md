# Session Attachment 代码路由

适用于 Session 本地附件的原始字节上传、SQLite 元数据、磁盘一致性、安全边界、列表查询和 Session 删除协同。图片附件如何被 Chat 引用并临时投影给 Provider，见 [chat-image-input.md](./chat-image-input.md)。

## 当前边界

- 文件实际保存在 `{attachmentBaseDir}/attachments/sessions/{sessionId}/{name}`；默认 `attachmentBaseDir` 为 `SSH_AGENT_DATA_DIR` 或 `~/.gori-agent`；CLI 显式传入解析后的数据目录，不依赖当前源码路径。数据库 `storage_path` 只保存后端生成的相对路径。
- 上传接口接收原始字节流，不接收 multipart、Base64 或客户端路径。单文件上限为 20 MiB；可选 `Content-Length` 必须与实际读取字节数一致。
- 文件名不能是空白、`.`、`..`，不能包含路径分隔符、NUL/控制字符，UTF-8 编码后不能超过 255 bytes。MIME 类型来自 `Content-Type`，缺省为 `application/octet-stream`，不执行内容嗅探。
- 上传先写同目录 `0600` 独占临时文件，再通过硬链接原子发布。原始名称已占用时在最后一个扩展名前依次追加 `-1`、`-2`；并发发布冲突会继续递增，不覆盖已有文件。发布后写入数据库；任一步失败或请求取消都会清理本次临时文件和已发布文件。
- Attachment 目录权限为 `0700`。目录链若是符号链接或非目录则拒绝上传；最终文件路径仅由受校验的 Session ID 和文件名组成。
- 同一 Session 的最终文件名保持唯一。上传响应返回实际采用的 `name` 和 `storagePath`；为追加序号而截断名称时仍保证最终名称不超过 255 UTF-8 bytes。列表按 `created_at DESC, id DESC` 返回。
- 上传持有 `attachment_upload` Session lifecycle lease，删除屏障建立后拒绝新上传，活动上传会阻止 Session 删除。Session 数据库删除成功后清理精确的附件目录；清理失败只记录日志。
- 上传、列表和 Chat 消息历史的 Attachment HTTP 投影增加受控相对 `contentUrl`，不把该 URL 或宿主机绝对路径写入数据库。内容接口按 `sessionId + attachmentId` 校验归属，通过无符号链接方式打开文件，并与 Chat 输入共用 JPEG、PNG、WebP 真实格式识别。
- 图片内容以原始字节流返回，包含真实 `Content-Type`、`Content-Length`、`ETag`、`private, max-age=31536000, immutable` 和 `X-Content-Type-Options: nosniff`。匹配 `If-None-Match` 时返回 `304`。非受支持图片不能通过该接口回显。
- Attachment 基础领域不提供删除、覆盖、版本管理或通用文件下载。上传接口本身仍不解析图片内容；图片校验延迟到 Chat 引用或受控内容读取阶段。

## HTTP 契约

```http
POST /api/sessions/:sessionId/attachments?name={encodedFileName}
Content-Type: image/png
Content-Length: 12345

<raw bytes>
```

成功返回 `201` 和单个 Attachment HTTP 投影；其中 `name` 是自动消除同名冲突后的最终名称，`contentUrl` 可直接作为浏览器图片地址。列表接口：

```http
GET /api/sessions/:sessionId/attachments
```

返回 `{ "attachments": Attachment[] }`。公开异常沿用统一 `{ error: { code, message, ... } }` 结构，并按 `Accept-Language` 本地化静态消息。

图片内容接口：

```http
GET /api/sessions/:sessionId/attachments/:attachmentId/content
If-None-Match: "previous-etag"
```

成功时流式返回图片原始字节；缓存仍有效时返回 `304`。接口不接收 `storagePath`，也不返回 Base64。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 领域模型和错误 | [attachment.ts](../../../packages/ssh-agent/src/domain/attachment.ts) |
| Repository 端口 | [attachment-repository.ts](../../../packages/ssh-agent/src/application/repositories/attachment-repository.ts) |
| 文件校验、流式写入、自动命名、受控读取和清理 | [attachment-service.ts](../../../packages/ssh-agent/src/application/services/attachment-service.ts) |
| JPEG、PNG、WebP 共享格式识别 | [attachment-image-inspector.ts](../../../packages/ssh-agent/src/application/services/attachment-image-inspector.ts) |
| SQLite Repository 和 migration | [sqlite-attachment-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-attachment-repository.ts)、[migrations.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/migrations.ts) |
| HTTP 路由和 Node 流式适配 | [attachment-routes.ts](../../../packages/ssh-agent/src/api/attachment-routes.ts)、[node-http-server.ts](../../../packages/ssh-agent/src/server/node-http-server.ts) |
| Runtime 装配和 Session 删除协同 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts)、[session-service.ts](../../../packages/ssh-agent/src/application/services/session-service.ts) |
| 国际化错误出口 | [public-error.ts](../../../packages/ssh-agent/src/i18n/public-error.ts)、[catalogs](../../../packages/ssh-agent/src/i18n/catalogs/) |
| 定向测试 | [attachment-service.test.ts](../../../packages/ssh-agent/test/attachment-service.test.ts)、[attachment-api.test.ts](../../../packages/ssh-agent/test/attachment-api.test.ts) |
| 前端联调契约 | [session-attachment-api.md](../frontend/session-attachment-api.md) |

修改该领域时必须同时检查临时文件清理、同名并发、最终名称长度、数据库失败补偿、Session 删除互斥、目录符号链接、内容缓存头和 Node HTTP 流式路由。
