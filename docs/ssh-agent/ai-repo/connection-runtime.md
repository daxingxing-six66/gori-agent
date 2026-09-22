# SSH Connection Runtime 代码路由

适用于 SSH 目标解析、Connection Key、物理连接复用、Channel 并发、主机密钥校验、认证、保活、断线重连和连接失效。

- 创建弹窗的草稿连接测试使用独立临时客户端，仅验证认证，不占用本 Pool、不保存 Host Trust、不重试。详见 [connection-test.md](./connection-test.md)。

## 当前边界

- `Ssh2ChannelBroker` 的上传下载共用 20 个活动名额和 3000 个 FIFO 等待位置，独立于 Connection/Channel 容量；Workspace/Credential 失效同时取消匹配的排队传输，关闭时拒绝新传输并清空队列。详见 [文件传输限流](./file-tool-concurrency.md)。

- SFTP 的 list/stat/delete/上传/下载按完整 Connection Key 共享一个 Channel，多个文件并发使用独立句柄，最后一次操作结束后空闲 1 秒回收。单个取消不关闭其他任务的 Channel；断线/失效后新请求新建，旧任务不重放。详见 [文件工具并发](./file-tool-concurrency.md)。

- Agent 和应用层不接触物理 Connection；Agent 命令只依赖 `RemoteCommandBroker`，SFTP Service 通过 `SftpFileBroker` 使用共享的 SFTP Channel，与 exec/PTY Channel 分离。
- `Ssh2ChannelBroker` 是组合入口；`Ssh2ConnectionPool` 只管理物理 Connection 和 Channel slot，Exec、SFTP 与长期 PTY 协议生命周期分别位于独立 adapter。
- 进程级 Pool 按 Workspace、主机信任、Credential 身份/认证版本和远端用户隔离；每个键最多一个物理 Connection、8 个 Channel。
- 命令应用层另有默认 16 的进程级 Operation 并发限制；它限制跨 Session 的总执行量，不替代每个 Connection 的 8 Channel 容量约束。
- 初次建连只尝试一次。ready Connection 意外断开后最多自愈重连 5 次；运行中的命令不会重放，其结果为 uncertain。
- 使用 ssh2 keepalive；Channel 获取等待 15 秒，空闲 Connection 60 秒回收。
- Channel 容量 waiter 遵守 AbortSignal，取消时立即从 FIFO 移除。Connection 建立期间发生 Workspace/Credential 失效或后端关闭时会终止 attempt，已失效 Client 不会重新写回 Pool。
- Workspace 创建时没有 Host Trust。首次 Tool 调用由 Workspace 级 single-flight Bootstrap 执行一次不带业务 Credential 的临时 ssh2 握手，保存实际协商算法和 SHA-256 指纹；并发首次命令共享同一结果。
- Bootstrap 持久化成功后才建立正常认证 Connection。保存的算法和指纹在认证前严格校验；指纹或算法不匹配产生 `host_key_mismatch`，不会自动覆盖。
- 活动 Credential 切换及 Workspace/Credential 删除会失效相关连接，但 Credential 切换不会删除 Workspace Host Trust。重新信任和 SSH CA 仍由 development backlog 路由。
- 当前实现 exec Channel、目录/stat/上传/下载/删除 SFTP Channel，以及 `client.shell()` PTY。PTY 持有共享 slot 到 actor dispose，并按 Connection generation 额外限制长期 Channel 数；断线不迁移或重放。
- SFTP upload 接收异步字节流，逐块写入并回调已传输字节数。目标同目录的隐藏临时文件关闭成功后才重命名；覆盖只允许 OpenSSH 原子 rename。下载只读取普通文件，删除允许普通文件和符号链接。
- 上传阶段断线不会改变最终目标，失败可重试；最终 rename 阶段断线无法判断提交结果，返回 `upload_result_uncertain`，不会自动重放。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 目标快照、Connection Key | [ssh-target.ts](../../../packages/ssh-agent/src/domain/ssh-target.ts) |
| Session 到目标快照解析 | [ssh-target-resolver.ts](../../../packages/ssh-agent/src/application/services/ssh-target-resolver.ts) |
| 首次信任 single-flight | [workspace-host-trust-service.ts](../../../packages/ssh-agent/src/application/services/workspace-host-trust-service.ts) |
| Host Key 探测端口和 ssh2 实现 | [host-key-probe.ts](../../../packages/ssh-agent/src/application/host-key-probe.ts)、[ssh2-host-key-probe.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-host-key-probe.ts) |
| Host Trust 持久化 | [workspace-host-trust-repository.ts](../../../packages/ssh-agent/src/application/repositories/workspace-host-trust-repository.ts)、[sqlite-workspace-host-trust-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-workspace-host-trust-repository.ts) |
| 应用层 Command、SFTP 和 Connection Control 边界 | [ssh-channel-broker.ts](../../../packages/ssh-agent/src/application/ssh-channel-broker.ts) |
| ssh2 组合 Broker | [ssh2-channel-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-channel-broker.ts) |
| 物理 Connection、Channel slot、主机校验、认证和重连 | [ssh2-connection-pool.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-pool.ts) |
| Exec、SFTP 和 PTY adapter | [ssh2-exec-command-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-exec-command-broker.ts)、[ssh2-sftp-file-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-sftp-file-broker.ts)、[ssh2-terminal-channel-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-terminal-channel-broker.ts) |
| Credential Secret 读取 | [credential-repository.ts](../../../packages/ssh-agent/src/application/repositories/credential-repository.ts)、[sqlite-credential-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-credential-repository.ts) |
| 管理变更触发连接失效 | [workspace-service.ts](../../../packages/ssh-agent/src/application/services/workspace-service.ts)、[credential-service.ts](../../../packages/ssh-agent/src/application/services/credential-service.ts) |
| 默认运行时装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 真实 ssh2 回归测试 | [host-trust-bootstrap.test.ts](../../../packages/ssh-agent/test/host-trust-bootstrap.test.ts)、[ssh2-connection-pool.test.ts](../../../packages/ssh-agent/test/ssh2-connection-pool.test.ts) |

Connection Key 不得缩减为 hostname/port，也不得包含 Secret。自动 TOFU 只允许 Host Trust 不存在时执行；已有记录不匹配必须失败。修改重试逻辑时必须保持“活动命令不自动重放”这一安全边界。
