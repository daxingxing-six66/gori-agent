# 外部模型错误代码路由

## 边界

- `application/provider-failure-classification.ts` 负责原因提取、脱敏、长度限制和重试属性，`application/provider-failure.ts` 负责模型事件流边界。只信任 Provider 终态错误响应、可识别的 HTTP 异常及网络异常；未知应用异常保持通用提示。
- 聊天在 Attachment 水合完成后才进入模型错误边界，覆盖首次请求、Tool 后续请求和消费队列后的请求。不改变正常流事件、Usage 或上下文超限识别所用的原始错误文本。
- 压缩通过请求局部的 Models 适配层捕获摘要错误，包括 split-turn 的前缀摘要。在 PI 包装为 `CompactionError` 前保存安全描述，外层 `ChatCompactionError` 保留 cause。请求开始清除旧状态；不同 Run 和不同压缩尝试互不共享失败原因。
- 主聊天每次 `Models.streamSimple()` 请求设置 `maxRetries=3`，由 pi-ai Provider Adapter 复用现有 HTTP 请求重试，首次请求外最多重试三次，覆盖 Tool 后续请求和消费队列后的请求。共享策略重试符合条件的网络异常、408/409/429/5xx，尊重 `x-should-retry`；优先采用厂商 `Retry-After`，否则三次等待基准为 2、4、8 秒，并加入最多 25% 的随机缩短。Codex SSE 的 HTTP/网络重试复用同一个 2 秒基准常量，沿用其原有无随机抖动的退避。厂商要求等待超过默认 60 秒上限时立即失败；Run 的 `AbortSignal` 同时取消请求和退避等待。具体协议仍以 Adapter 支持为准，不新增外层模型调用重试，不重放已执行工具或已开始输出的流；压缩摘要和标题请求不在本次配置范围。
- Runtime 保持一个 Run failure 报告，失败消息和终态引用同一 errorId。恢复失败附在原始 provider 报告的 recovery 字段下；不会用“无历史可压缩”替换 provider 根因。上下文超限的压缩恢复仍最多一次，与 HTTP 重试预算分开。
- Assistant 描述符和 Run failure 的 Key/values 通过既有 JSON 持久化。HTTP/SSE 递归投影把它们转换为原有字符串字段，移除来源标记和 diagnostics；不迁移或解析旧记录。
- 原始错误/cause 进入本地日志；公开原因不包含异常栈、认证 URL、常见凭证、完整响应对象或 HTML 页。正常模型内容不经过错误清洗。
- 来源使用显式 `exception/response` 模式；结构化原因优先于外层字符串。带空格的引号凭证和认证 Header 整行清洗；额度耗尽、地区限制和参数限制优先于 HTTP 429 的可重试判断。
- `ChatRunRuntime` 保存当前运行失败，通过 `beginProviderRequest()`、`captureFailure()`、`toAgentError()` 管理请求、运行异常和恢复失败。
- 取消或队列续接中断后的 Provider 终态错误按 `aborted` 归一化，包括 Adapter 以 error 事件返回取消的情况；不创建厂商失败报告。Runtime 在 Turn 结束时停止旧 Loop。用户停止且有排队消息时，旧 Loop 收尾后使用新信号在同一 Run 消费剩余队列；内部强制取消及服务关闭不续接。明确的 `CompactionError("aborted")` 包装在停止期间还原为 AbortError，真实压缩或持久化失败仍保留报告。详见 [chat-runtime.md](./chat-runtime.md)。
- 空响应 400/413 的超限特例仅适用于 Cerebras；OpenCode Go 相同响应保留 HTTP 状态、使用 `chat_provider_request_rejected`，不自动压缩。
- 统一分类、诊断、Run executor 和安全快照见 [chat-failures.md](./chat-failures.md)。

## 入口

| 职责 | 源码 |
|---|---|
| 厂商分类和流包装 | `packages/ssh-agent/src/application/provider-failure-classification.ts`、`packages/ssh-agent/src/application/provider-failure.ts` |
| 聊天模型边界和恢复桥接 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| 主聊天 HTTP 重试预算、共享退避和回归 | `packages/ssh-agent/src/application/chat-runtime-defaults.ts`、`packages/ai/src/utils/provider-retry.ts`、`packages/ssh-agent/test/chat-provider-retry.test.ts` |
| Codex SSE 退避和响应头回归 | `packages/ai/src/api/openai-codex-responses.ts`、`packages/ai/test/openai-codex-stream.test.ts` |
| 请求局部摘要适配、错误捕获及 cause | `packages/ssh-agent/src/application/compaction-summary-request.ts`、`packages/ssh-agent/src/domain/context-compaction.ts` |
| 压缩策略、持久化与失败日志 | `packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 消息持久化和 Run 终态 | `packages/ssh-agent/src/application/services/chat-agent-event-handler.ts`、`packages/ssh-agent/src/application/chat-run-runtime.ts`、`packages/ssh-agent/src/application/services/chat-service.ts` |
| 公开投影 | `packages/ssh-agent/src/i18n/projection.ts`、`packages/ssh-agent/src/i18n/public-error.ts` |

前端契约见 [provider-error-integration.md](../frontend/provider-error-integration.md)。
