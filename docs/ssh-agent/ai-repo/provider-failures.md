# 外部模型错误代码路由

## 边界

- `application/provider-failure-classification.ts` 负责原因提取、脱敏、长度限制和重试属性，`application/provider-failure.ts` 负责模型事件流边界。只信任 Provider 终态错误响应、可识别的 HTTP 异常及网络异常；未知应用异常保持通用提示。
- 聊天在 Attachment 水合完成后才进入模型错误边界，覆盖首次请求、Tool 后续请求和消费队列后的请求。不改变正常流事件、Usage 或上下文超限识别所用的原始错误文本。
- 压缩通过请求局部的 Models 适配层捕获摘要错误，包括 split-turn 的前缀摘要。在 PI 包装为 `CompactionError` 前保存安全描述，外层 `ChatCompactionError` 保留 cause。请求开始清除旧状态；不同 Run 和不同压缩尝试互不共享失败原因。
- Runtime 保持一个 Run failure 报告，失败消息和终态引用同一 errorId。恢复失败附在原始 provider 报告的 recovery 字段下；不会用“无历史可压缩”替换 provider 根因。恢复次数仍最多一次，不新增 429/5xx 自动重试。
- Assistant 描述符和 Run failure 的 Key/values 通过既有 JSON 持久化。HTTP/SSE 递归投影把它们转换为原有字符串字段，移除来源标记和 diagnostics；不迁移或解析旧记录。
- 原始错误/cause 进入本地日志；公开原因不包含异常栈、认证 URL、常见凭证、完整响应对象或 HTML 页。正常模型内容不经过错误清洗。
- 来源使用显式 `exception/response` 模式；结构化原因优先于外层字符串。带空格的引号凭证和认证 Header 整行清洗；额度耗尽、地区限制和参数限制优先于 HTTP 429 的可重试判断。
- `ChatRunRuntime` 保存当前运行失败，通过 `beginProviderRequest()`、`captureFailure()`、`toAgentError()` 管理请求、运行异常和恢复失败。
- 空响应 400/413 的超限特例仅适用于 Cerebras；OpenCode Go 相同响应保留 HTTP 状态、使用 `chat_provider_request_rejected`，不自动压缩。
- 统一分类、诊断、Run executor 和安全快照见 [chat-failures.md](./chat-failures.md)。

## 入口

| 职责 | 源码 |
|---|---|
| 厂商分类和流包装 | `packages/ssh-agent/src/application/provider-failure-classification.ts`、`packages/ssh-agent/src/application/provider-failure.ts` |
| 聊天模型边界和恢复桥接 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| 请求局部摘要适配、错误捕获及 cause | `packages/ssh-agent/src/application/compaction-summary-request.ts`、`packages/ssh-agent/src/domain/context-compaction.ts` |
| 压缩策略、持久化与失败日志 | `packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 消息持久化和 Run 终态 | `packages/ssh-agent/src/application/services/chat-agent-event-handler.ts`、`packages/ssh-agent/src/application/chat-run-runtime.ts`、`packages/ssh-agent/src/application/services/chat-service.ts` |
| 公开投影 | `packages/ssh-agent/src/i18n/projection.ts`、`packages/ssh-agent/src/i18n/public-error.ts` |

前端契约见 [provider-error-integration.md](../frontend/provider-error-integration.md)。
