# Chat 统一失败处理代码路由

沿用既有领域 Error、pi-ai AssistantMessage/diagnostics、AgentRunError、ChatRun.failure 和后端消息目录，不增加平行异常框架。

## 边界

- `failure-policy.ts` 从 public-error 提取原分类和 code 注册表，HTTP 与 Run 共用；public-error 只导出。未知应用异常不作为厂商响应公开。
- Provider 分类在纯函数文件中，流包装保留部分输出并处理同步抛错、终态 error 和消费失败。空 400 不触发其他厂商的 Cerebras 超限特例。
- Runtime 捕获原异常；失败消息和 Run 保存相同报告。压缩失败挂 recovery，清理失败单独记录且不改主结果。
- AgentRunError 是 fatal tool 契约；普通 ToolError 仍可交给模型。并行 fatal 会中止可取消的同批任务并等待已启动任务结束；监听器失败不再递归写错误消息。
- 审批 timeout/abort/HTTP 写入失败必须 reject 等待者；SFTP 覆盖审批也适用。新队列注入失败只补偿当前项；补偿失败中止 Run。现有 follow_up 转 steer 时若数据库更新或内存队列同步抛错，沿用持久化失败路径中止 Run，避免继续消费不一致的队列。
- executor 只选择一次业务结果，终态提交失败不将它改成另一业务错误。SQLite updateRun 终态事务关闭 pending Queue/Approval，提交后更新内存和 SSE。
- PendingRunCommits 按 Session 保存待提交快照；活动 Run 查询、创建 Run 和手动压缩入口重试一次，仍失败返回 chat_persistence_failed/503 并阻止新操作。仅重试提交，不重新执行模型或工具；进程重启沿用 interrupted recovery。
- schemaVersion=1 failure_json 保存安全摘要，公开投影使用白名单；无版本历史保留原快照，不从文案猜原因。日志使用现有 Console sink 和共享 errorId，原始 cause 不公开。
- delivery 故障不改变 Run 业务结果，通过 stream.resync 要求客户端读取 REST；正常客户端断开只移除订阅。服务关闭取消并等待在途 Run 任务，10 秒未结束则抛错，不继续关闭数据库；独立手动压缩尚未纳入该等待集合。

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

设计、实施边界与验收见 [chat-run-failure-design.md](../design/chat-run-failure-design.md)。
