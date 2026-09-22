# 文件工具并发与 SFTP Channel 复用

适用于同一 Assistant 消息中的工具调用调度，以及多文件共用 SSH SFTP 子系统。

## 批次执行规则

- Agent Core 保留“一个串行工具使整批按模型返回顺序串行”的规则。新增 Tool 元数据 `requiresSequentialExecution(calls, signal)`，只允许进一步限制并发，不能放宽全局或 Tool 的静态 sequential。它在参数校验和审批之前接收原始参数，必须按不可信输入处理；相同回调每批执行一次，异常回退串行，正常 Tool 执行负责报告参数错误。
- Gori 的 Runtime Factory 仅对 `read`、`sftp_upload`、`sftp_download` 装配 parallel 和共享路径检查回调；其他工具（含 write、bash、远端命令和 Terminal）均设置 sequential。SFTP 工具独立构造时仍保留原 sequential 默认值。
- read：本地读；upload：本地源文件读、远端目标目录 + 本地 basename 写；download：远端源文件读、本地目标目录 + 远端 basename 写。相同或祖先/子路径之间只要存在写入就整批串行，读读可并发。本地和远端属于不同命名空间，目录相同但最终文件名不同可并发。
- 本地路径用执行环境 absolutePath 解析，再使用本机 path 规则；远端使用 POSIX 绝对路径和 normalize。识别相对/绝对路径、`.`、`..` 和组件边界。本地 Unicode 使用 NFC 比较，macOS/Windows 保守忽略大小写。read 的 `@`、特殊空格或引号等拼写回退场景直接串行，避免猜测实际读取路径。
- 此版本仅检查同一批次的词法路径，不解析远端/本地符号链接、硬链接或挂载别名，不提供跨 Session、跨批次、HTTP 文件操作或外部进程的路径锁及内容快照。
- 并行仍采用现有顺序预检、并发执行、按完成顺序发送工具完成事件、最后按模型原顺序输出 ToolResult 的机制；保留审批、取消、失败和 SSE 协议。

## SFTP 复用规则

- `Ssh2SftpChannelPool` 按完整 Connection Key 共享一个 SFTP subsystem；Key 沿用 Workspace、主机、信任、凭据及认证版本、用户隔离。并发首次使用共享同一个打开过程，只占一个 Connection Pool Channel slot。
- list/stat/delete/上传/下载共用该 Channel；每个文件有独立 SFTP handle、请求 ID、临时路径、进度和取消信号。多个文件可以同时存在未完成的请求，但单文件上传仍逐块等待确认，不实现单文件分块并发。
- 引用计数覆盖打开等待和实际操作。单调用取消不会中止其他打开等待者或关闭共享 Channel。无人等待的未完成打开会退役，迟到的打开结果立即关闭。
- 最后一个操作完成后保留 Channel 1 秒，以复用 stat 后的传输及连续请求；到期关闭并释放 slot。后端关闭显式退役所有 Channel，连接/Channel 断开或连接 generation 失效时不再复用。新请求可新建 Channel，旧任务不自动重放。
- 上传取消只清理自身句柄及随机临时文件，不关闭 Channel；迟到 OPEN 的句柄也清理。断线后不等待无响应的清理请求，正常清理等待有界。下载关闭自身流及句柄，也不关闭其他下载使用的 Channel。
- 上传仍使用临时文件后 rename；覆盖仍要求 OpenSSH 原子扩展。最终 rename 期间中断继续返回 upload_result_uncertain；已发送的操作不自动重放。下载不新增断点续传。
- Connection Pool 原有最多 8 个 Channel 的限制不变，它限制 Channel 数，不是共享 Channel 内的文件数。共享传输仍竞争带宽、磁盘及服务器请求容量，不提供吞吐保证。

## 共享文件传输限流

- `Ssh2ChannelBroker` 的上传和下载共用一个 `SftpTransferLimiter`，最多 20 个活动传输，额外最多 3000 个 FIFO 等待任务。默认后端共用一个 Broker，覆盖所有 Workspace、Session、Agent Tool 和 HTTP 文件传输；多个后端进程不共享此内存限额。
- 名额覆盖底层上传/下载调用直到成功或失败退出（包括传输清理）；目录查询、stat、删除和本地 read 不占文件传输名额。原有整批串行和路径冲突规则仍优先适用。
- 排队时不进入底层 SFTP 传输、不消费上传数据源；Agent 下载延迟到收到数据时打开本地临时文件，零字节文件在下载成功后创建，避免等待队列占用文件句柄。
- 20 个活动名额和 3000 个等待位置均满时，新调用立即失败，返回 `transfer_queue_full`（公开 HTTP 错误状态 429）；Agent Tool 使用既有失败结果和中英文消息描述符。队列不新增 Transfer 状态或 SSE 事件。
- 取消排队任务立即移除并释放等待位置。Workspace/Credential 失效取消匹配的等待任务；Broker 关闭取消全部等待任务并拒绝新任务。活动调用结束始终释放名额，按 FIFO 唤醒后续任务。

## 入口与验证

| 职责 | 入口 |
|---|---|
| 通用批次限制扩展 | `packages/agent/src/types.ts`、`packages/agent/src/agent-loop.ts` |
| Gori 路径检查与工具装配 | `packages/ssh-agent/src/application/services/file-tool-concurrency.ts`、`packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts` |
| 共享 SFTP Channel 生命周期 | `packages/ssh-agent/src/infrastructure/ssh/ssh2-sftp-channel-pool.ts` |
| 上传下载共享并发与等待队列 | `packages/ssh-agent/src/infrastructure/ssh/sftp-transfer-limiter.ts`、`packages/ssh-agent/test/sftp-transfer-limiter.test.ts` |
| 流式传输、清理和组合关闭 | `packages/ssh-agent/src/infrastructure/ssh/ssh2-sftp-file-broker.ts`、`packages/ssh-agent/src/infrastructure/ssh/ssh2-channel-broker.ts` |
| 路径矩阵、真实 Agent 调度和装配 | `packages/ssh-agent/test/file-tool-concurrency.test.ts`、`packages/ssh-agent/test/chat-agent-runtime-factory.test.ts` |
| 打开等待、取消、失败和身份隔离 | `packages/ssh-agent/test/sftp-channel-lifecycle.test.ts` |
| 本机 SSH 并发传输及断线回归 | `packages/ssh-agent/test/sftp-channel-reuse.test.ts`、`packages/ssh-agent/test/ssh2-connection-pool.test.ts` |

集成测试只监听本机回环地址，动态生成 SSH 主机密钥，使用测试凭据，不接触真实服务器。容量设为一个 Channel 时仍要求两个上传进入写入阶段，以验证真实复用与并发。
