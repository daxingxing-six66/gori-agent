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
| 回归测试 | `packages/ssh-agent/test/file-logger.test.ts` |

启用新日志入口需要重新加载后端进程；不会恢复旧进程已经丢失的异常信息。
