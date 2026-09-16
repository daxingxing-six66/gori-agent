# Session Attachment 前端接口

当前后端提供 Session 附件上传和列表查询。图片上传成功后可把 Attachment ID 随 Chat Run 或 Queue 提交，详见 [Chat 图片附件前端联调](./chat-image-attachment-integration.md)。前端不要把 `storagePath` 当作任意本地文件访问接口。

## 上传

```http
POST /api/sessions/:sessionId/attachments?name={encodeURIComponent(file.name)}
Content-Type: {file.type || "application/octet-stream"}

<File 原始字节>
```

浏览器可以直接把 `File` 作为 `fetch` body，不需要 multipart/form-data 或 Base64：

```ts
const response = await fetch(
  `/api/sessions/${sessionId}/attachments?name=${encodeURIComponent(file.name)}`,
  {
    method: "POST",
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Accept-Language": locale,
    },
    body: file,
  },
);
```

成功状态为 `201`：

```ts
interface Attachment {
  id: string;
  sessionId: string;
  name: string;
  mimeType: string;
  size: number;
  storagePath: string;
  contentUrl: string;
  createdAt: number;
}
```

`name` 是后端最终采用的文件名。同一 Session 已存在同名文件时，后端在最后一个扩展名前自动追加递增序号：

```text
image.png -> image-1.png -> image-2.png
```

前端必须以响应中的 `name` 为准，不能假设它始终等于上传请求中的名称。

限制：

- 单文件最大 20 MiB。
- 同一 Session 下最终文件名唯一；后端不覆盖已有文件，并发同名上传会分别取得不同的递增名称。
- 文件名不能包含 `/`、`\\`、控制字符，UTF-8 编码后不能超过 255 bytes。
- `Content-Type` 缺失时后端保存为 `application/octet-stream`。
- 前端无需主动设置 `Content-Length`；如果客户端或代理发送了该 Header，后端会校验实际字节数。

## 列表

```http
GET /api/sessions/:sessionId/attachments
Accept-Language: zh-CN
```

响应：

```ts
{
  attachments: Attachment[];
}
```

列表按 `createdAt` 倒序返回；时间相同时按 ID 倒序。

上传响应和列表中的 `contentUrl` 是后端生成的相对 API 地址。前后端同源时可直接使用；不同源时应以既有后端 API Base URL 解析该地址。前端不得读取或拼接 `storagePath`。

## 图片内容

JPEG、PNG 和 WebP 附件可以通过 `contentUrl` 直接回显：

```http
GET /api/sessions/:sessionId/attachments/:attachmentId/content
```

例如：

```tsx
const src = new URL(attachment.contentUrl, backendApiBaseUrl).toString();

<img src={src} loading="lazy" alt={attachment.name} />
```

接口行为：

- 根据 `sessionId + attachmentId` 校验附件归属，不接收 `storagePath`。
- 按文件签名识别真实 JPEG、PNG 或 WebP MIME，不信任上传时声明的 `Content-Type`。
- 流式返回原始图片字节，不返回 Base64 或 data URL。
- 返回 `Content-Type`、`Content-Length`、`ETag`、`Content-Disposition: inline` 和 `X-Content-Type-Options: nosniff`。
- 返回 `Cache-Control: private, max-age=31536000, immutable`，浏览器可长期缓存不可变附件。
- 浏览器携带匹配的 `If-None-Match` 时返回 `304`。

前端应使用 `loading="lazy"`，让浏览器只请求当前需要显示的图片。非 JPEG、PNG、WebP 附件仍可上传和列出，但内容接口不会将其作为图片返回。

## 错误

错误结构沿用后端统一协议：

```ts
{
  error: {
    code: string;
    message: string;
    field?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  };
}
```

Attachment 稳定错误码：

| code | HTTP | 含义 |
|---|---:|---|
| `attachment_not_found` | 404 | Session 或当前 Session 下的 Attachment 不存在 |
| `attachment_name_invalid` | 400 | 文件名非法 |
| `attachment_mime_type_invalid` | 400 | Content-Type 非法 |
| `attachment_too_large` | 413 | 超过 20 MiB |
| `attachment_size_mismatch` | 400 | Content-Length 与实际字节数不一致 |
| `attachment_upload_cancelled` | 499 | 请求取消 |
| `attachment_content_cancelled` | 499 | 图片内容读取取消 |
| `attachment_image_format_unsupported` | 415 | 附件不是 JPEG、PNG 或 WebP |
| `attachment_content_invalid` | 415 | 图片容器或尺寸信息无效 |
| `attachment_changed` | 409 | 附件上传后发生变化 |
| `attachment_storage_unavailable` | 500 | 后端附件存储不可用 |
| `session_has_active_attachment_upload` | 409 | Session 有活动上传，暂不能删除 |

错误 `message` 已按 `Accept-Language` 本地化，前端仍按稳定 `code` 做程序分支。
