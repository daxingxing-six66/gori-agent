# Chat 统一失败处理代码路由

沿用既有领域 Error、pi-ai AssistantMessage/diagnostics、AgentRunError、ChatRun.failure 和后端消息目录，不增加平行异常框架。

## 边界

- `failure-policy.ts` 从 public-error 提取原分类和 code 注册表，HTTP 与 Run 共用；public-error 只导出。未知应用异常不作为厂商响应公开。
- Provider 分类在纯函数文件中，流包装保留部分输出并处理同步抛错、终态 error 和消费失败。空 400 不触发其他厂商的 Cerebras 超限特例。
- Runtime 捕获原异常；失败消息和 Run 保存相同报告。压缩失败挂 recovery，清理失败单独记录且不改主结果。
- 用户主动取消是正常结束行为。浏览器消息行按 `stopReason: "aborted"` 隐藏取消附带的错误详情，保留已有正文、Thinking 与工具记录；实时和历史加载一致，不解析英文或本地化错误文案。其他消息的真实失败仍按原规则显示，即使所属 Run 后来被取消也不统一隐藏。回归见 `packages/ssh-agent-web/tests/chat-failure-details.test.tsx`。
- 点击停止时存在排队消息会中断当前 Loop 并在同一 Run 续接，Run 不提前进入终态；旧循环结束与监听器落库之后才读取剩余队列，每次仅续接队首一条，其余消息继续排队。真实失败阻止续接，内部强制取消优先于待续接意图；明确的摘要中止不包装为恢复失败。状态与回归入口见 [chat-runtime.md](./chat-runtime.md)。
- AgentRunError 是 fatal tool 契约；普通 ToolError 仍可交给模型。并行 fatal 会中止可取消的同批任务并等待已启动任务结束；监听器失败不再递归写错误消息。
- 审批 timeout/abort/HTTP 写入失败必须 reject 等待者；SFTP 覆盖审批也适用。新队列注入失败只补偿当前项；补偿失败中止 Run。现有 follow_up 转 steer 时若数据库更新或内存队列同步抛错，沿用持久化失败路径中止 Run，避免继续消费不一致的队列。
- executor 只选择一次业务结果，终态提交失败不将它改成另一业务错误。SQLite updateRun 终态事务关闭 pending Queue/Approval，提交后更新内存和 SSE。
- PendingRunCommits 按 Session 保存待提交快照；活动 Run 查询、创建 Run 和手动压缩入口重试一次，仍失败返回 chat_persistence_failed/503 并阻止新操作。仅重试提交，不重新执行模型或工具；进程重启沿用 interrupted recovery。
- 部署 Agent Run 在 Chat 写入终态之前先收敛在途阶段并保存实际结果。新部署的 Session 模式保留，只有明确结束用例才保存整体终态；旧未接入模式的 Run 保持原兼容结算。结算失败时保留按 Session 绑定的待结算任务，发布 run.persistence_failed；上述入口重试原部署结算和原 Chat 终态提交，不重跑 Agent。Runtime 初始化后已认领部署却启动失败时也遵守此顺序，避免 Chat 已结束而部署仍为 running。
- schemaVersion=1 failure_json 保存安全摘要，公开投影使用白名单；无版本历史保留原快照，不从文案猜原因。日志使用现有 Console sink 和共享 errorId，原始 cause 不公开。
- delivery 故障不改变 Run 业务结果，通过 stream.resync 要求客户端读取 REST；正常客户端断开只移除订阅。服务关闭取消并等待在途 Run 任务，10 秒未结束则抛错，不继续关闭数据库；独立手动压缩尚未纳入该等待集合。

## 中断后的工具消息恢复

`packages/ai/src/api/transform-messages.ts` 在每次 Provider 序列化前修复工具消息配对，只处理请求投影，不删除或重写持久化历史，也不重新执行工具：

- 已有真实结果时保留该结果；调用执行期间追加的 Terminal 等 system 事件暂缓到本组全部结果之后，避免提前补出错误结果后又发送一条同 ID 的真实结果。多个并行调用的结果可按实际完成顺序出现，system 事件之间的顺序不变。
- 遇到下一条 user/assistant 或历史结束时仍缺少结果，为每个缺失调用补一条 `isError: true` 的结果，明确执行中断、操作可能已经生效，需要先检查当前状态再决定是否重试。补充结果使用原调用时间戳，重复投影保持稳定；不能将未知结果冒充执行失败或成功。
- 重复结果、无对应调用的结果，以及已过滤 error/aborted assistant 留下的结果不进入 Provider 请求；原始审计记录仍然保留。修复不改变 Run 的失败分类，不自动恢复或重放有副作用的操作。

`tool-message-recovery.test.ts` 覆盖 system 插入、并行调用、部分/全部结果缺失、重复与孤立结果、跨模型 ID 归一化及投影幂等；`chat-system-message-adapters.test.ts` 验证 Chat Completions、Responses 和 Mistral 最终请求保留真实结果及 system 角色，测试在网络请求前停止。

## 源码入口

| 职责 | 位置 |
|---|---|
| 领域身份和现有错误 | `packages/ssh-agent/src/domain/errors.ts`、`domain/chat.ts`、`domain/ssh-failure.ts` |
| 单一分类、公开说明和报告 | `packages/ssh-agent/src/application/failure-policy.ts` |
| 诊断脱敏、cause 和身份关联 | `packages/ssh-agent/src/application/failure-reporter.ts` |
| Provider 分类与流边界 | `packages/ssh-agent/src/application/provider-failure-classification.ts`、`application/provider-failure.ts` |
| 执行/提交/清理归属 | `packages/ssh-agent/src/application/services/chat-run-executor.ts`、`services/chat-service.ts` |
| 运行错误与恢复 | `packages/ssh-agent/src/application/chat-run-runtime.ts`、`services/chat-agent-runtime-factory.ts` |
| 终态原子更新和历史验证 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts` |
| 公开报告和 SSE | `packages/ssh-agent/src/i18n/projection.ts`、`application/chat-run-event-stream.ts` |
| Provider 工具配对与中断恢复投影 | `packages/ai/src/api/transform-messages.ts` |
| 工具配对回归与适配器序列化 | `packages/ssh-agent/test/tool-message-recovery.test.ts`、`packages/ssh-agent/test/chat-system-message-adapters.test.ts`、`packages/ai/test/transform-messages-copilot-openai-to-anthropic.test.ts` |

设计、实施边界与验收见 [chat-run-failure-design.md](../design/chat-run-failure-design.md)。

部署规则错误通过现有 DeploymentError 携带精确 code、field、动态原因及安全 details；Tool 授权和执行错误保持完整 JSON，HTTP 只本地化场景前缀，保留实际原因和字段。已知路径失败由部署层分类，未知基础设施异常仍按原内部错误策略处理，不能统一改成“命令或路径无效”。见 [deployment.md](./deployment.md)。
