# Context Compaction 代码路由

适用于 SSH Agent 的 Provider 请求前压缩、上下文超限恢复、手动压缩、压缩 Setting、Token 校准和摘要消息持久化。

## 当前边界

- 摘要请求的厂商原因在 PI 错误包装前提取，统一复用模型错误模块。手动 HTTP、自动 SSE、失败 Assistant 与 Run failure 保留相同安全原因和 retryable；内部 cause/stack 只进入日志。见 [provider-failures.md](./provider-failures.md)。

- 占用展示复用同一估算。实际请求、离线占用及手动压缩使用固定头部、同一 18 工具目录与状态格式。只读查询预览尚未提交事实而不写消息；手动压缩先提交真实状态，避免把预览 ID 保存为历史。见 [context-usage.md](./context-usage.md)。

- Agent Core 提供 `beforeProviderRequest` 和 `recoverProviderError` 两个通用扩展点。前者可在每次 Provider 调用前替换 Run 内 Context、模型或 thinking level；后者只接收尚未产生有效流式内容、尚未写入 transcript 的终态错误，并且最多恢复重试一次。`transformContext` 仍只转换单次请求，不替换 Run 内 Context。
- `pi-ai` 在 Agent 边界通过 `isContextOverflow()` 把不同 Provider 的超限文本规范化为 `AssistantMessage.errorCode="context_overflow"`。已经发送文本、思考内容或 Tool Call 的失败不回滚、不重试。
- SSH Agent 的 `ChatContextService` 是统一编排器。每次 Provider 请求前先用 `convertToLlm()` 转换消息，再估算 system prompt、messages 和 tools schema 的完整 payload。自动压缩按 Run 创建时读取的 Setting 快照执行；Run 完成后不再额外压缩。
- Token 校准按 provider/model 保存在进程内 EWMA。实际输入为 `usage.input + usage.cacheRead + usage.cacheWrite`；校准系数范围为 100% 到 200%，服务重启后从 100% 重新学习。日志只记录原因、阈值、模型、估算值、系数和结果，不记录消息正文、Tool 参数、摘要或凭证。
- 自动压缩阈值由全局 `triggerPercent` 控制，默认 80。第一次 retained-tail 目标为模型 Context Window 的 30%；压缩后仍高于阈值且本次至少减少 30% 时，第二次把 retained-tail 预算减半。最多两次，之后仍超阈值返回 `chat_context_compaction_insufficient`。
- 压缩模型可配置为 Provider/Model，也可为 `null` 以使用当前 Session 模型。配置模型不存在、没有凭证或容量不足时回退 Session 模型；认证检查本身抛错返回 `chat_credential_check_failed`，不会当成没有凭证；Session 模型也不可用时返回 `chat_compaction_model_unavailable`。
- 压缩模型为 `opencode-go` 时，摘要请求携带当前 SSH Agent Session 的稳定 `x-opencode-session` 和 `x-opencode-client=pi`；其他 Provider 不增加这些 Header。
- 压缩摘要是普通 `chat_messages` 行，`message_type=compact`。`message_json` 继续保存完整消息，包括 summary、retained tail、tokens before、details、reason、attempt、实际摘要模型、Usage 和 timestamp。自动压缩关联 `run_id`，手动压缩的 `run_id` 为 null。
- 部署历史入口属于 UI 元数据；`modelVisibleMessages()` 在历史加载、估算、压缩准备和 retained tail 投影中过滤 deployment custom 消息，避免被通用转换器当作 user 指令或进入摘要。
- Context 加载只使用最新 compact 消息、其 retained tail 和该消息之后的记录。旧消息仍保留在数据库和消息列表中，因而时间线与后续二次压缩都有明确边界。
- 图片附件引用参与 payload 估算，每张图片按 PI 的图片估算成本计入，但 Base64 不参与估算或摘要。压缩准备阶段只使用 `[Image attachment: name]` 文本标记和无二进制图片占位；进入摘要区的旧图片不再保留引用，retained tail 中的图片消息恢复为原文本和 `attachmentIds` 后再持久化。文档附件只计算路径/read 提示的文本成本，不生成图片占位。含文档消息持有服务端校验后的 `attachmentKinds`，避免无 I/O 的估算误计图片；压缩准备从附件元数据补回文件名、路径与 read 提示，不读取正文。retained tail 恢复原文本、ID 和类型提示；Provider 安全读取仍检查真实文件。
- 手动 `POST /api/sessions/:sessionId/chat/compactions` 忽略触发阈值，但复用相同模型选择、最多两次压缩、收益判断和持久化。它与 Chat Run 互斥，并持有 Session lifecycle lease。
- 有效 Provider Usage 加后续消息估算超过近期保留预算时，按消息字符估算与 Usage 占用的比例缩小切分预算；字符估算只分配保留范围，不能否定已知超额。失效或错误响应的 Usage 不参与修正。确实无法合法切分时返回 `chat_context_no_compactable_history`，不误报 `nothing_to_compact`；不改变自动触发阈值及二次压缩条件。
- 压缩失败的稳定 code 和后端固定 SSE 说明通过消息描述符在浏览器出口本地化；压缩摘要正文、Provider 输出、模型 ID 和 Token 数据保持原样。
- 压缩准备和摘要失败包装时保留原始 cause，失败日志输出异常栈及 cause；CLI 将日志写入本地滚动文件，见 [logging.md](./logging.md)。公开响应仍不暴露诊断栈。

协议、各通道最高版本及仍生效的 Skill/工作流在每次压缩中单独保留，旧状态可在有效上下文重建时移除；数据库原消息保留。Terminal 权威模式通过独立 typed 查询恢复，不被普通 system 事件遮蔽；摘要期间新提交的状态 head 与模式事件同样保留，避免被 compact 边界吞掉。头部和工具目录不重组，详见 [runtime-context.md](./runtime-context.md)。

## 固定算法参数

| 参数 | 值 |
|---|---:|
| retained-tail target | 30% |
| minimum reduction | 30% |
| maximum consecutive attempts | 2 |
| second attempt retained-tail | 第一次的 50% |
| EWMA alpha | 20% |
| calibration range | 100%..200% |

恢复失败保留在 Run 报告的 recovery 中，原始 provider 超限仍是主原因。空响应 400/413 只在 Cerebras 范围作为超限识别。`compaction.failed` 不要求 tokensBefore，携带共用失败报告字段。

## 稳定失败码

- `chat_context_overflow`
- `chat_context_no_compactable_history`
- `chat_credential_check_failed`
- `chat_context_compaction_insufficient`
- `chat_context_compaction_failed`
- `chat_compaction_model_unavailable`

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Provider 请求前替换与错误恢复扩展点 | `packages/agent/src/agent-loop.ts`、`packages/agent/src/types.ts`、`packages/agent/src/agent.ts` |
| Provider 超限识别与 payload Token 估算 | `packages/ai/src/utils/overflow.ts`、`packages/ai/src/utils/estimate.ts` |
| PI 压缩准备和显式二次压缩 | `packages/agent/src/harness/compaction/compaction.ts` |
| SSH Agent 压缩编排、校准、模型回退和 SSE | `packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 单次摘要的 Models 适配、原因捕获及异常包装 | `packages/ssh-agent/src/application/compaction-summary-request.ts` |
| 图片成本投影与 retained-tail 引用恢复 | `packages/ssh-agent/src/application/services/chat-attachment-service.ts` |
| Run 与手动压缩互斥 | `packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/application/services/session-lifecycle-coordinator.ts` |
| Setting 领域、Service 和 Repository | `packages/ssh-agent/src/domain/context-compaction.ts`、`packages/ssh-agent/src/application/services/context-compaction-settings-service.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-context-compaction-settings-repository.ts` |
| compact 消息持久化与 migration | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| HTTP 路由和请求校验 | `packages/ssh-agent/src/api/http-handler.ts`、`packages/ssh-agent/src/api/request-validation.ts` |

前端接口和 SSE payload 见 [context-compaction-api.md](../frontend/context-compaction-api.md)。


诊断状态通过统一持久化追加机制加入运行时；原阈值/超限恢复回调保持。UI 历史过滤位于 chat-ui-history-message.ts，只过滤 deployment/diagnose 两种 custom 消息，其他 custom 类型保持原有行为。详见 [Diagnose 功能路由](./diagnose.md)。

内置 gori-diagnosis Skill 以独立通道状态消息参与估算，压缩保留最新有效指引原文；结束追加 inactive，而不是下一次请求删除旧片段。


2026-10-21 逐次缓存统计：摘要的聚合 Usage 保留 `requests` 原始 API 响应用量列表，单摘要一条、history 与 turnPrefix 双摘要两条；顶层计数/费用仍按原规则相加，聚合顶层不制造单次 cacheReadDetails。状态及摘要正文不放入该列表。统计展开明细显示每次请求，旧压缩记录不能从合计数字还原单次调用。见 [statistics.md](./statistics.md)。

2026-10-22 Terminal 人机协作：terminal-human 通道的最新完整快照沿用各通道保留机制，在压缩后继续保留；不把隐藏按键补进摘要，也不把旧终端的画面当成当前现场。压缩或只读预览本身不确认人工现场交付；保留的交接必须真正进入成功的主模型请求，才能由对应响应的工具调用申请条件复用。原消息身份和正文保持，恢复后不制造重复交接；验证见 `terminal-human-runtime.test.ts`。见 [功能路由](./features/terminal-human-interaction.md)。
