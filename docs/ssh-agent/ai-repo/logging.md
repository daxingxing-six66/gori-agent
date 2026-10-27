# 本地日志代码路由

用于 SSH Agent CLI 的本地诊断日志和压缩异常栈。

- CLI 启动时安装文件 Console，覆盖当前后端进程的 console 输出；库调用和测试不自动安装，不影响宿主进程。
- 目录默认为 `~/.gori-agent/logs/`，由 `SSH_AGENT_DATA_DIR` 统一覆盖，不再依赖源码包位置或默认进程工作目录。源码运行和 dist 运行使用同一目录。目录权限 0700，新日志文件 0600。
- 本地日期分档：`ssh-agent-YYYY-MM-DD.0.log`；超过 10 MiB 写下一个编号段。单条超大日志不截断，可以独占超过上限的段。重启追加已有段，不覆盖。首版单进程使用，不自动删除或压缩旧段。
- 每条日志带 ISO UTC 时间和 INFO/ERROR 通道标识；console.warn 与 console.error 属于 ERROR 通道。同步追加避免退出前缓冲丢失；磁盘失败降级到原始 stderr，不向业务抛出日志写入错误。
- 启动、关闭及 uncaughtExceptionMonitor 输出错误对象；监控器不吞掉未捕获异常，不改变 Node 默认退出行为。直接写 stdout/stderr 的第三方输出不被截获。
- Chat/provider/恢复/Run commit/cleanup 通过 `application/failure-reporter.ts` 使用既有 Console 文件日志。`domain/errors.ts` 维护共享 errorId，包装和传播不重复打印堆栈，恢复关联通过 rootErrorId 记录。错误文本、栈和 cause 做凭证脱敏、长度及深度限制，不记录整个聊天上下文。
- 压缩错误保留 cause，并通过同一 reporter 输出异常和 cause 栈；已知错误仍通过公开异常出口生成安全文案，不向浏览器发送栈。
- 日志可能包含底层异常中的敏感诊断信息，仅用于本机排查。禁止主动记录凭证、请求正文或摘要正文；分享日志前应脱敏。仓库仍忽略旧的 logs 目录，旧日志不自动搬迁。

## 代码入口

| 能力 | 文件 |
|---|---|
| 分日、大小滚动和磁盘失败降级 | `packages/ssh-agent/src/server/file-logger.ts` |
| 进程入口安装和异常监控 | `packages/ssh-agent/src/server/main.ts` |
| 压缩异常 cause | `packages/ssh-agent/src/domain/context-compaction.ts` |
| 压缩失败日志 | `packages/ssh-agent/src/application/services/chat-context-service.ts` |
| SQLite owner、慢事务与冲突来源诊断 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-transaction-runner.ts`、`sqlite-transaction-diagnostics.ts` |
| 监控 Collector 生命周期、采样排队与阶段耗时 | `packages/ssh-agent/src/application/services/remote-metrics-service.ts`、`application/monitoring/remote-metrics-diagnostics.ts` |
| 回归测试 | `packages/ssh-agent/test/file-logger.test.ts` |

启用新日志入口需要重新加载后端进程；不会恢复旧进程已经丢失的异常信息。

## SQLite 连接占用与监控积压取证

`SqliteTransactionBusyError` 来自共享连接的事务 owner 检查。异常栈只能说明哪条读取或写入被拒绝，不能据此判断持有事务的是同一 Session、OAuth、SSE 或其他业务。诊断只增加现场记录，不改变事务保护、同步提交、回滚、异常传播、Terminal idle 扫描及监控 FIFO 的现有行为。

- `SSH Agent SQLite transaction diagnostic` 记录进程 ID、随机 `connectionId`、本连接递增 `transactionId`、事务入队与开始时间、owner 的静态 `sourceStack`、当前阶段、排队/持有/阶段耗时及等待队列长度。阶段为 begin、operation、awaiting_operation、commit 或 rollback；`awaiting_operation` 仅表示等待业务 Promise，不推断该 Promise 对应的外部资源。
- `sqlite.transaction.blocked` 在原拒绝之前同步输出，还包括冲突访问的 `prepare/exec/statement/iterator/authorizer` 边界和调用栈。同一 owner 最多记录八个不同访问来源的完整栈，累计冲突数继续计入 `blockedAccesses`，避免重复堆栈淹没来源。
- 异步事务等待达到一秒时输出一次 `sqlite.transaction.slow`，定时器 unref，事务结束时清理。排队/持有至少一秒或发生过冲突的事务，结束时输出同 ID 的 `sqlite.transaction.finished`，记录 committed、rolled_back、begin_failed 或 rollback_failed 及失败阶段。若进程在异常时退出，结束记录可能缺失，但 blocked 已包含当时 owner 的现场。
- `SSH Agent remote metrics diagnostics` 记录 Collector started、stop_scheduled、stop_cancelled、stopped 及释放原因；随机 `collectorId` 区分同一 Workspace 前后两次实例。每次 tick 的 `sampleId`、触发源 initial/base_timer/process_timer、queuedAt、startedAt、queueWaitMs 和三处队列深度区分正在执行与等待的任务。
- 采样阶段为 resolve_target、base_probe、process_probe、parse、publish，并保留各阶段和整次执行耗时。排队至少一秒时记录 sample.started，排队或执行至少一秒时记录 sample.finished；健康、无积压的每次 tick 不新增 INFO。原监控失败日志追加相同关联字段，原错误对象与 monitor.error 投影沿用既有行为。
- 排查时先找 blocked 的 owner 来源与 connection/transaction ID，再关联 slow/finished；随后核对同一 Workspace 的 Collector/Sample ID、原入队时间、等待时长及递减队列深度，判断是否为旧任务集中执行。日志不足时保留待验证结论，不能把静态代码中的潜在长事务认定为这次实际 owner。

新增结构诊断不记录 SQL、绑定参数、回调参数/结果、认证材料、Target、命令或输出，也不把任意业务异常正文用作诊断标签；日志 sink 失败不替换原业务异常。回归见 `test/sqlite-transaction-diagnostics.test.ts`、`test/remote-metrics-diagnostics.test.ts`，只使用内存 SQLite、假 Broker 和时钟。


## 上下文缓存观测

`ChatContextService` 发出 `cache.prefix`（头部/工具/设置 SHA-256、消息数、首个变化组件）与 `cache.usage`（真实输入、缓存读取/写入、未缓存输入、输出、命中比例），以 requestId 关联。不记录提示词、参数或摘要正文。指纹属于应用 Context 层，不能当作最终 HTTP 字节或供应商命中证明；进程内保留最近 256 个 Session，重启从 initial 开始。Session ID 始终透传主模型调用以接通已有缓存键。细节和限制见 [runtime-context.md](./runtime-context.md)。

`cacheRate` 仅由 API 明确返回的 `Usage.cacheReadDetails` 计算，缺失或总输入为 0 时是 null；`cacheReported` 区分是否保存了可信计数。原有归一化 Token 字段仍用于用量与校准，不据此推断缓存率。统计的“模型调用”页签直接读取 SQLite 明细，详见 [statistics.md](./statistics.md)。
