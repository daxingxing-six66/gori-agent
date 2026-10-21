# 运行时上下文、固定工具目录与缓存观测

适用于诊断、部署、Session 沙盒、Terminal 环境及单轮工作流的模型上下文。2026-10-21 的缓存修复以本页为当前实现依据；业务数据库仍保存可修改的当前状态，模型已经收到的状态消息通过追加新版本更新。

## 状态提交与请求边界

`ChatRuntimeFacts` 调用各领域读取当前事实，`ChatRuntimeContextService` 负责同步或只读预览，`SqliteRuntimeContextRepository` 使用共享事务端口在同一 SQLite 事务中读取事实、比较摘要、写入 `chat_messages` 和更新 `chat_runtime_context_heads`。运行时工厂只安排同步，不处理诊断/部署业务生命周期。持久化失败返回现有 `chat_persistence_failed`，不继续发送模型请求。

每条真实 system 消息保存 `runtimeEventId` 和 `runtimeContext`：协议 `version=1`、channel、通道内递增 revision、scope、active、完整 data 与可选的后端 instructions。表头按 Session/channel 唯一，指向已提交消息及内容 SHA-256。只比较作用域与实际内容；时间、请求次数、无关业务 revision 不进入摘要。重复请求、恢复及同值刷新不追加；A → B → A 分别保存三个版本。这是请求之间观察到的状态序列，不是业务事件溯源。

请求按“同步事实 → 估算/必要压缩 → 再同步 → 发送”进行。状态追加在完整工具结果组后，`afterToolCall` 只刷新执行入口，避免在同批工具结果之间插入事件。订阅适配器沿用原规则，在请求副本的相同位置将 system 转为 developer；数据库角色与正文不改写。

固定头部只读取首次不可变快照。旧会话升级时不更新旧头部、聊天或工具结果，在下一次模型请求前补协议及各通道当前状态。首次工具目录升级会改变一次请求前缀，之后未压缩、同模型/设置的连续请求才适合检验追加稳定性。

## 各通道的语义审查

协议规定：同一通道最高 revision 是完整当前事实，替代该通道旧 scope/版本的当前含义；旧快照仍是历史，不是当前许可；不同通道不能互相覆盖。active=false 明确结束该通道之前的功能指引，不能用缺省字段表达退出。当前阶段、Session 只读和服务端绑定约束优先于旧工作流文字。

| 通道 | 当前事实与结束语义 | 为什么不容易混淆 |
|---|---|---|
| protocol | 固定协议说明 | 独立保留，摘要不能自行激活模式 |
| sandbox | 当前执行模式、只读及排序后的有效可写目录，始终提供完整快照 | 只读快照替代旧宽松根列表，指引明确禁止例外与部署写入；工具执行仍独立校验 |
| terminal | Run 冻结模式、PTY 身份及实际沙箱事实，命令模式 active=false | 原子 on/off system 记录仍是交互模式权威；新增普通 system 不遮蔽其查询；空闲读取当前 PTY，旧 Run 不能借新 PTY 恢复执行 |
| diagnose | 当前任务 scope、direction/status/explanation，说明最多 300 Unicode 字符；结束 inactive | 节点修订不改前次简报，完整记录由 diagnose_inspect 读取；新任务 scope 替代旧任务，旧 Run 不获得新任务工具 |
| diagnose-instructions | 当前活动任务的内置 Skill 原文及固定指引 | 不随节点修订重发；内容或任务身份变化才追加；结束快照撤销旧指引 |
| deployment | 部署身份、选择来源、阶段及阶段结果、计划版本、阶段工具；结束 inactive | 失败仍保持活动，重试读取当前已确认计划；进入待审明确禁止执行，旧执行指引不能覆盖新待审状态 |
| workflow | 首次配置或当前讨论/执行/修复的指引及引用数据 | 按 scope 和内容去重；单轮配置仅在对应 Run 生效，后续请求追加 inactive；部署指引受当前任务和阶段限制 |

自由文字、方向、说明、目录、Profile 等放入 `<quoted-data>` 的 JSON 中，并转义 `<`、`>`；只有后端编写的固定指引放入 instructions。引用数据不因 system 角色获得指令含义。工具定义存在不授予执行权限，结束不靠删除定义表达。这些规则与样例可供文案审查，但不能证明模型理解具有确定性。

例如先有 deployment/execution，再追加 deployment/review：旧执行消息留作历史，最新完整快照只允许查询、讨论或结束，不能执行未确认修订。诊断 task A 结束后新建 task B，两个事件使用不同 scope；只读 sandbox 的最新版本对 task B 同样生效，部署通道不能覆盖沙盒通道。

## 固定工具与压缩恢复

`chatToolDefinitions()` 是唯一目录，按名称排序现有 18 个内置工具。实际请求、离线估算和手动压缩共用名称、描述和参数 Schema；动态目录、沙盒事实、模式和任务 ID 不进入定义。`bindChatTools()` 绑定实际执行实现，未激活工具使用 `unavailableTool`，在参数准备（审批前）与直接执行入口拒绝。已绑定实现保留原任务/计划/阶段、Guard、只读、审批、一次性 grant 和目标复核规则。

只读占用查询通过 preview 计算尚未提交的事实，不写事件或 head。手动压缩先同步真实事件，再压缩，避免持久化预览 ID。自动、手动与超限压缩都在 retainedTail 单独保留协议、各通道最高版本、仍活动的 Skill/工作流和 Terminal 权威模式；摘要进行期间新提交的 head 也进入压缩后上下文。压缩是明确的上下文重建边界，可移除已过时状态，不修改数据库原消息。重启读取保存正文，不重新生成事件。

固定目录会增加未启用功能时的基础 schema 占用；状态追加也有增量成本。本次保持原压缩阈值和工具输出限制，收益须比较总输入、缓存读取及输出，不能只看命中率。

## 观测与验证

`cache.prefix` 记录应用层 Context 的头部、工具、设置摘要与首次变化组件，`cache.usage` 通过 requestId 关联真实 uncached/cacheRead/cacheWrite/output，并计算 `cacheRead / (input + cacheRead + cacheWrite)`。不记录提示词、参数或摘要正文；缓存指纹在进程内按最近 256 个 Session 有界保存，重启后的第一条为 initial。它不是最终 HTTP payload 的逐字指纹，附件水合、适配器转换及供应商缓存行为需分别分析。主模型调用始终透传 Session ID，接通已有供应商缓存键，不能据此保证缓存收益。

`test/runtime-context.test.ts` 使用临时 SQLite、假模型数据和真实订阅序列化函数验证多通道旧输入的完整前缀、固定目录、A/B/A、结束/新作用域、重复同步、并发、写入回滚、重开恢复、引用转义及预览无写入。`chat-context-service.test.ts` 覆盖三类压缩期间新状态提交及 typed Terminal 查询。运行时、诊断、部署、只读与工具授权回归继续验证副作用前拒绝。

共享装配复核：附件水合/引用、UI 历史、Provider 失败/重试、标题、统计、用户决策、活动状态、Guard、SSH、SFTP、监控和 HTTP 的原边界保持；本次 migration 只新增状态索引表。未进行真实模型、SSH 或发布，离线结构测试不能证明缓存率或订阅额度收益。

## 源码入口

| 职责 | 路径（相对 packages/ssh-agent/src） |
|---|---|
| 协议、消息格式、追加与压缩保留 | `domain/runtime-context.ts` |
| 持久化端口与 SQLite 事务实现 | `application/repositories/runtime-context-repository.ts`、`infrastructure/sqlite/sqlite-runtime-context-repository.ts` |
| 同步、预览与领域事实组合 | `application/services/chat-runtime-context-service.ts`、`chat-runtime-facts.ts` |
| Profile 引用与工作流指引分离 | `application/runtime-workflow.ts` |
| 各领域快照 | `application/diagnose-runtime.ts`、`deployment-runtime-context.ts`、`services/session-sandbox-policy.ts` |
| 唯一工具目录 | `application/chat-context.ts` |
| 请求调度、压缩、查询与观测 | `application/services/chat-agent-runtime-factory.ts`、`chat-context-service.ts`、`chat-service.ts` |

相关边界见 [session-prompt.md](./session-prompt.md)、[context-compaction.md](./context-compaction.md)、[logging.md](./logging.md)。
