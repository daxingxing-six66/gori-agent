# SSH Agent 后端国际化前端联调说明

后端国际化不会改变现有 REST JSON、SSE data、Tool update 或 ToolApproval 的公开结构。前端只需要在请求时传递 Locale，现有 Parser 和渲染逻辑继续读取原来的字符串字段。

## Locale 传递

REST 请求使用：

```http
Accept-Language: zh-CN
```

支持 `zh-CN` 和 `en-US`。`zh`、`zh-CN`、`zh-Hans` 归一化为 `zh-CN`；明确的其他语言归一化为 `en-US`；未提供时默认 `zh-CN`。

浏览器原生 `EventSource` 不方便设置自定义 Header，因此 Chat、Workspace 和 Terminal SSE 使用查询参数：

```text
GET /api/sessions/:sessionId/chat/runs/:runId/events?locale=zh-CN
GET /api/workspaces/:workspaceId/events?topics=monitoring,connection,transfers&locale=zh-CN
GET /api/sessions/:sessionId/terminal/attachments/:attachmentId/events?afterSequence=0&locale=zh-CN
```

`locale` 查询参数优先于 `Accept-Language`。切换语言后重新建立 EventSource；Chat 历史事件会按新 Locale 重放，不会复用旧连接已经编码的语言。

## 响应兼容性

错误响应仍为：

```ts
{
  error: {
    code: string;
    message: string;
    field?: string;
    retryable?: boolean;
    details?: Record<string, unknown>;
  }
}
```

只会改变 `message` 的语言。`code`、HTTP status、`field`、`retryable` 和 `details` 语义不变。未知异常统一返回 `internal_error`，`details.errorId` 可用于服务端日志定位。

以下既有字符串字段会按 Locale 投影：

- `ChatRun.failure.message`
- `FileTransfer.failure.message`
- `ConnectionPoolSnapshot.lastError.message`
- `TerminalSession.failureMessage`
- `ToolApproval.description`
- 后端生成的 Assistant `errorMessage`
- Tool update 中 `status.detail.message` 和 `progress.detail.message`
- 带后端展示元数据的固定 Tool Result 文本

Tool update 公开协议不变：

```ts
type ToolUpdate =
  | { type: "status"; detail: { status: string; message: string } }
  | { type: "progress"; detail: { current: number; total: number; unit: string; message?: string } }
  | { type: "text"; detail: { content: string; mode: "replace" } };
```

内部 `messageKey`、`messageValues`、`messageDescriptor` 和 presentation 元数据不会发送给前端。前端不要根据本地化 `message` 做业务判断，只使用稳定 `code`、status、event type 和 `toolName`。

Assistant 因 Provider 调用失败时，公开 `errorMessage` 会变为安全的本地化说明，Provider 原始失败 diagnostics 不发送到浏览器；正常的模型正文和 Thinking 不受影响。

JSON 和 SSE 响应包含 `Content-Language`。通过 Header 协商时响应包含 `Vary: Accept-Language`；使用明确的 `locale` 查询参数时不依赖该 Header 缓存维度。

## 不翻译的数据

后端不会翻译用户输入、模型输出、Thinking、Provider 原始响应、SSH stdout/stderr、Terminal 字节、Observation、命令、文件内容、路径、主机名、用户名、Workspace/Session/Provider/Model 名称或 ID、用户定义的 Guard 文案、Tool schema、Tool 参数和 System Prompt。
