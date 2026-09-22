# SFTP 与实时监控代码路由

适用于 Workspace 级文件管理、Transfer 六状态持久化、流式上传下载、Workspace SSE、Connection 快照和远端 Linux 指标采集。

## 当前边界

- 后端共享 Broker 的上传和下载共用 20 个活动名额、3000 个 FIFO 等待位置；满队列返回 `transfer_queue_full`，公开异常状态 429，Tool 失败提示支持中英文。排队不新增 Transfer 状态，目录/stat/delete 不占传输名额。Agent 下载收到数据后才打开本地临时文件，空文件在下载成功后创建。

- Agent 文件工具按同批次读写路径判断是否并发；底层所有 SFTP 操作复用同连接身份的一个 Channel，各自持有独立文件句柄，空闲 1 秒释放。单任务取消不关闭共享 Channel。详见 [文件工具并发与 Channel 复用](./file-tool-concurrency.md)。

- Workspace SSE 新增可选 `sessions` topic 与 `session.updated`，复用原事件格式、分发和心跳；原 monitoring/connection/transfers 订阅不受影响。见 [session-title.md](./session-title.md)。

- HTTP SFTP 和监控不进入 Session FIFO、Guard 或 LLM。`sftp_upload` 和 `sftp_download` Agent Tool 直接使用 `SftpFileBroker` 流式传输文件，文件内容不进入 LLM，也不创建 `FileTransfer`。
- SFTP Tool 的检查、等待覆盖审批、传输进度和固定结果提示携带包内消息描述符；Agent Context 与持久化仍使用规范英文或原始动态内容，Chat SSE 只翻译浏览器投影。上传和下载覆盖审批继续共用 `ToolApproval`，对外仅返回按 Locale 生成的场景 `description`。
- Workspace Target Resolver 与 Session Resolver 共享 Workspace、Host Trust 和活动 Credential 解析。
- Workspace SSE 按订阅者 Locale 投影 `monitor.error`、连接错误和 Transfer failure；同一事件可同时服务中英文订阅者，远端采集结果和路径等动态数据不翻译。
- 目录列表、普通文件下载、普通文件或符号链接删除和临时文件上传已实现。目录禁止下载和删除。
- 远端上传覆盖只使用 OpenSSH `posix-rename`；扩展不可用时拒绝，不执行删除旧文件再 rename。Agent 下载先写本地同目录临时文件，无覆盖时用硬链接原子发布，批准覆盖后用本地原子 rename。
- Transfer 只持久化 `pending/running/completed/failed/cancelled/uncertain`；文件内容不持久化，重启不续传。
- JSON 请求仍受 2 MiB 限制；上传内容和下载响应直接流式桥接。SSE 每 15 秒 heartbeat。
- Metrics Collector 每 Workspace 唯一，基础数据 2 秒、Top 20 进程 3 秒；同一 Workspace 内探测串行。
- 前端区分 SSE 首次连接、实时、重连和关闭状态；`monitor.error` 会替换无限等待状态，并在已有快照时保留最后一次成功数据。
- 前端上传任务由 Workspace 级上下文持有，切换 Tab 不会丢失 `File`、XHR、进度或取消能力；离开 Workspace 前会确认并中止活动上传。
- 既有 Workspace 的非绝对默认目录不会直接发起 SFTP 请求，用户可显式从 `/` 浏览；`uncertain` Transfer 只允许刷新目录，不自动重试或覆盖。
- 目录切换 loading 限定在 Remote files 卡片内并跟随当前视口；远程文件删除使用前端确认弹窗，删除期间禁止关闭或重复提交，失败保留弹窗错误。
- 目录搜索和文件类型过滤只处理当前已加载的 `entries`，不会发起额外 SFTP 请求；用户主动切换目录时清空搜索词。
- Workspace 页面状态树以 `workspaceId` 为实例边界；切换 Workspace 时清空 Overview、Guard、凭据和 SFTP 本地状态，并回到 Overview。

- SFTP 覆盖审批的存储异常由 AgentRunError 原样上抛，停止 Run；审批拒绝/超时仍使用原 ToolResult 行为。详见 [chat-failures.md](./chat-failures.md)。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Transfer 领域模型和错误 | `packages/ssh-agent/src/domain/file-transfer.ts` |
| SFTP/Connection Broker 契约 | `packages/ssh-agent/src/application/ssh-channel-broker.ts` |
| Transfer 状态机和进度限频 | `packages/ssh-agent/src/application/services/file-transfer-service.ts` |
| Agent SFTP 上传/下载、条件覆盖审批和 Tool 进度 | `packages/ssh-agent/src/application/tools/sftp-upload-tool.ts`、`packages/ssh-agent/src/application/tools/sftp-download-tool.ts` |
| SSE 广播 | `packages/ssh-agent/src/application/workspace-event-hub.ts` |
| Collector 和 Linux parser | `packages/ssh-agent/src/application/services/remote-metrics-service.ts` |
| ssh2 SFTP adapter | `packages/ssh-agent/src/infrastructure/ssh/ssh2-sftp-file-broker.ts` |
| 组合 Broker 和共享 Connection Pool | `packages/ssh-agent/src/infrastructure/ssh/ssh2-channel-broker.ts`、`packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-pool.ts` |
| SQLite Transfer Repository | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-file-transfer-repository.ts` |
| HTTP/SSE 路由 | `packages/ssh-agent/src/api/http-handler.ts` |
| Node 流式适配 | `packages/ssh-agent/src/server/node-http-server.ts` |
| 前端 API 和页面 | `packages/ssh-agent-web/features/sftp/` |
| Workspace 页面状态边界 | `packages/ssh-agent-web/components/workspace-console.tsx` |
| 前端删除确认弹窗 | `packages/ssh-agent-web/features/sftp/components/sftp-delete-dialog.tsx` |
| 前端 Workspace 级上传管理 | `packages/ssh-agent-web/features/sftp/components/sftp-transfer-provider.tsx` |
| 前端 SSE、监控和 Transfer 状态推导 | `packages/ssh-agent-web/features/sftp/model/sftp-state.ts` |
| 联调契约 | `docs/ssh-agent/frontend/sftp-overview-realtime-integration.md` |

修改 Transfer 状态时必须保持六状态边界，不能把 Channel 排队或 rename 阶段暴露为新状态。修改覆盖流程时必须保持“不确定结果不自动重放”和“无原子扩展不覆盖”。
