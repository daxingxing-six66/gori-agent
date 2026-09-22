# Gori 后端国际化与公开异常代码路由

适用于 SSH Agent 后端生成的静态提示、公开异常、Approval 描述、Tool 展示更新，以及 REST/Chat SSE/Workspace SSE/Terminal SSE 的 Locale 协商。

## 当前边界

- 文件传输等待队列满使用稳定 code `transfer_queue_full` 和词典 Key `sftp.transfer_queue_full`；公开异常保留 429，上传/下载 Tool 结果也携带该描述符供浏览器本地化。

- 新模型错误在请求边界生成安全描述，浏览器显示本地化场景前缀和保留原语言的厂商原因；未知内部异常继续使用通用提示。来源标记不公开，旧记录不反向解析。见 [provider-failures.md](./provider-failures.md)。

- 运行时实现只位于 `packages/ssh-agent`。前端协议字段、业务错误 code、HTTP status、SSE event type 和 Tool 机器名称保持稳定。
- 内部消息使用类型化 `{ key, values }` 描述符。`zh-CN` 与 `en-US` 词典必须包含相同 Key 和占位符；路径、ID、字段名、主机名等动态值不翻译。
- REST 读取 `Accept-Language`；Chat、Workspace 与 Terminal SSE 的 `locale` 查询参数优先于 `Accept-Language`。缺少 Locale 时默认 `zh-CN`，明确的其他语言回退为 `en-US`。
- HTTP 和 SSE 只本地化公开投影副本，不修改 Repository 返回对象、Agent Context 或交给 LLM 的 Tool Result。用户输入、LLM 正常输出、Thinking、SSH stdout/stderr、Terminal bytes/Observation 和文件内容不进入词典；Provider 失败的原始 `errorMessage` 和 diagnostics 保留在内部记录中，但浏览器投影只返回稳定的安全错误说明。
- `application/failure-policy.ts` 持有唯一 code 注册表和领域分类；`i18n/public-error.ts` 仅重新导出，不保留第二套实现。`normalizePublicError()` 是公开异常唯一规范化入口，`runFailure()` 复用它生成 Run 报告，normalizer 不再打印日志。已知领域异常保留 code、status、field、retryable 和安全 details；未知异常返回 `internal_error` 与 `errorId`，原始 cause/stack 只写服务端日志。
- 新 Chat failure 使用 schemaVersion=1 安全快照；公开投影白名单包含 errorId、code、stage、message、retryable、action、upstreamStatus 和 recovery。主原因和恢复原因都按 Locale 投影；cause 不进入公开快照。
- Chat 与 Workspace SSE 按订阅者 Locale 编码。Chat 重放缓存保存结构化事件，不缓存本地化后的 bytes，因此同一个 Run 的不同订阅者和重连可以选择不同语言。
- 持久化 failure 保留英文 fallback，并可保存 `messageKey/messageValues`。Approval 和 TerminalSession 另有 Key/values 列；旧记录没有 Key 时只按稳定 code 映射，不能从历史字符串反向猜测参数。
- Tool `onUpdate` 继续使用既有 `status/progress/text` 协议。SSH Agent 包内可附加 `messageDescriptor`，浏览器出口把它转换成原有 `message: string` 并移除内部元数据。
- `toolName`、Tool schema、Tool 参数描述和 System Prompt 不翻译。审批展示名称由消息 Key 选择，不增加新的公共字段或审批类型。
- Attachment 名称、MIME 类型和路径属于动态数据，不翻译；名称非法、类型非法、大小超限/不一致、内容读取取消、图片格式/内容无效、上传后变化和存储不可用通过稳定 code 在统一异常出口生成中英文静态消息。
- Chat 图片引用、格式/内容变化和模型图片能力错误同样使用稳定 code。本地化只改变公开说明，不改变 Attachment ID、图片顺序、模型 ID 或 Provider 请求内容。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Locale、消息描述符、词典和占位符校验 | `packages/ssh-agent/src/i18n/message.ts`、`packages/ssh-agent/src/i18n/catalogs/` |
| 公开异常规范化与稳定 code 映射 | `packages/ssh-agent/src/application/failure-policy.ts`（`i18n/public-error.ts` 为导出门面） |
| HTTP/SSE 公开对象投影 | `packages/ssh-agent/src/i18n/projection.ts` |
| REST 路由与统一异常出口 | `packages/ssh-agent/src/api/http-handler.ts`、`packages/ssh-agent/src/server/node-http-server.ts` |
| Chat/Workspace/Terminal SSE | `packages/ssh-agent/src/application/chat-run-event-stream.ts`、`packages/ssh-agent/src/application/workspace-event-hub.ts`、`packages/ssh-agent/src/api/terminal-routes.ts` |
| Approval 与 Tool 展示消息 | `packages/ssh-agent/src/application/services/chat-approval-service.ts`、`packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/tool-update-protocol.ts`、`packages/ssh-agent/src/application/tools/` |
| failure/Approval/Terminal 持久化 | `packages/ssh-agent/src/infrastructure/sqlite/migrations.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-terminal-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-command-operation-repository.ts` |
| 对外联调契约 | `docs/ssh-agent/frontend/backend-i18n-integration.md` |

新增公开静态文本时必须先增加中英文词典 Key，再在领域边界携带描述符或为稳定 code 增加唯一映射。禁止在 HTTP/SSE 出口返回底层 Provider、SSH、SQLite 或文件系统原始异常。
