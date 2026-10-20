# SFTP 与实时监控代码路由

只读 Session 的 Agent `sftp_upload` 在运行时门禁和工具直接执行入口被拒绝，`sftp_download` 仍可读取日志；部署上传也由部署服务拒绝。Workspace 独立 Files 页面没有 Session 身份，保留独立权限，不受此选项控制。详见 [session-sandbox.md](./session-sandbox.md)。

适用于 Workspace 级文件管理、Transfer 六状态持久化、流式上传下载、Workspace SSE、Connection 快照和远端 Linux 指标采集。


文件页面从 `/` 初始化，API 未传 `path` 时也使用 `/`；显式路径保持原有查询及错误语义，不在 404 后悄悄替换。Workspace 不再保存远端默认目录，本地 `defaultCwd` 仅用于会话继承；概览不再展示远端默认目录。

沙盒可写目录选择器复用正式 SFTP 的目录投影：已有工作区调用其列表 API，创建草稿经独立临时 SSH/SFTP 连接调用 `POST /api/workspaces/browse-directory`；后者不进入共享 Pool，也不持久化凭据。选择器仅显示目录并在确认时采用远端规范化路径。见 [connection-test.md](./connection-test.md)。

## 当前边界

- 前端 Workspace SSE 由各功能适配器订阅，统一通过独立事件 origin 与普通 REST 连接额度隔离；shared/events/workspace-events.ts 按 Workspace + Locale 复用连接并合并请求 topics，业务解析、状态推导和重连补读仍归原适配器。消费者离开只取消其订阅，见 [transport-channels.md](./transport-channels.md)。

- 后端共享 Broker 的上传和下载共用 20 个活动名额、3000 个 FIFO 等待位置；满队列返回 `transfer_queue_full`，公开异常状态 429，Tool 失败提示支持中英文。排队不新增 Transfer 状态，目录/stat/delete 不占传输名额。Agent 下载收到数据后才打开本地临时文件，空文件在下载成功后创建。

- Agent 文件工具按同批次读写路径判断是否并发；底层所有 SFTP 操作复用同连接身份的一个 Channel，各自持有独立文件句柄，空闲 1 秒释放。单任务取消不关闭共享 Channel。详见 [文件工具并发与 Channel 复用](./file-tool-concurrency.md)。

- Workspace SSE 新增可选 `sessions` topic 与 `session.updated`，复用原事件格式、分发和心跳；原 monitoring/connection/transfers 订阅不受影响。见 [session-title.md](./session-title.md)。
- `/deploy` 的上传阶段按本次模型提案中的产物清单逐个复用 `FileTransferService`，各文件进度写入 Transfer 历史，部署阶段另有汇总进度；Deployment 独立通过 `deployments` topic 广播结构化讨论和阶段快照。实际 SFTP 操作不经过 Landlock，部署服务在提案和上传前检查规范化远端父目录位于 Profile 允许目录内。见 [deployment.md](./deployment.md)。

- HTTP SFTP 和监控不进入 Session FIFO、Guard 或 LLM。`sftp_upload` 和 `sftp_download` Agent Tool 直接使用 `SftpFileBroker` 流式传输文件，文件内容不进入 LLM，也不创建 `FileTransfer`。
- SFTP Tool 的检查、等待覆盖审批、传输进度和固定结果提示携带包内消息描述符；Agent Context 与持久化仍使用规范英文或原始动态内容，Chat SSE 只翻译浏览器投影。上传和下载覆盖审批继续共用 `ToolApproval`，对外仅返回按 Locale 生成的场景 `description`。
- Workspace Target Resolver 与 Session Resolver 共享 Workspace、Host Trust 和活动 Credential 解析。
- Workspace SSE 按订阅者 Locale 投影 `monitor.error`、连接错误和 Transfer failure；同一事件可同时服务中英文订阅者，远端采集结果和路径等动态数据不翻译。
- 目录列表、普通文件下载、普通文件或符号链接删除和临时文件上传已实现。目录禁止下载和删除。
- 远端上传覆盖只使用 OpenSSH `posix-rename`；扩展不可用时拒绝，不执行删除旧文件再 rename。Agent 下载先写本地同目录临时文件，无覆盖时用硬链接原子发布，批准覆盖后用本地原子 rename。
- Transfer 只持久化 `pending/running/completed/failed/cancelled/uncertain`；文件内容不持久化，重启不续传。
- JSON 请求仍受 2 MiB 限制；上传内容和下载响应直接流式桥接。SSE 每 15 秒 heartbeat。
- Metrics Collector 每 Workspace 唯一，基础数据 2 秒、Top 20 进程 3 秒；同一 Workspace 内探测串行。
- Session 页首复用该 Collector 显示 CPU/内存/网络，新增默认路由网卡的收发速率与新订阅者的缓存快照初始化；网络计算和前端订阅由独立模块持有，Overview 仍保留原三个卡片。详见 [session-server-metrics.md](./session-server-metrics.md)。
- 前端区分 SSE 首次连接、实时、重连和关闭状态；`monitor.error` 会替换无限等待状态，并在已有快照时保留最后一次成功数据。
- 概览采用 Dashboard 布局：三个资源指标卡位于顶部，进程表为主区域，连接池与手动沙箱检测放在辅助区域，SSH 参数默认收起。窄屏自动改为单列，宽表在自身容器内横向滚动；展示仍只使用现有快照，不生成历史曲线或模拟指标。
- SFTP 页面将上传放在内容标题操作区，目录路径、搜索和过滤组成紧凑工具栏；条目使用语义表格，名称可截断且保留完整悬停文本，窄屏仅表格局部横向滚动。传输队列在宽屏右侧、较窄屏幕下方；上传上下文及取消、覆盖确认和离开保护不随布局改变。
- 前端上传任务由 Workspace 级上下文持有，切换 Tab 不会丢失 `File`、XHR、进度或取消能力；离开 Workspace 前会确认并中止活动上传。
- `uncertain` Transfer 只允许刷新目录，不自动重试或覆盖。
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
| ssh2 SFTP adapter 与共用目录投影 | `packages/ssh-agent/src/infrastructure/ssh/ssh2-sftp-file-broker.ts`、`packages/ssh-agent/src/infrastructure/ssh/read-sftp-directory.ts` |
| 组合 Broker 和共享 Connection Pool | `packages/ssh-agent/src/infrastructure/ssh/ssh2-channel-broker.ts`、`packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-pool.ts` |
| SQLite Transfer Repository | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-file-transfer-repository.ts` |
| HTTP/SSE 路由 | `packages/ssh-agent/src/api/http-handler.ts` |
| Node 流式适配 | `packages/ssh-agent/src/server/node-http-server.ts` |
| 前端 API 和页面 | `packages/ssh-agent-web/features/sftp/` |
| 概览和文件页局部布局 | `packages/ssh-agent-web/features/sftp/components/overview-dashboard.css`、`sftp-files.css`、`sftp-directory-entries.tsx` |
| Workspace 页面状态边界 | `packages/ssh-agent-web/components/workspace-console.tsx` |
| 前端删除确认弹窗 | `packages/ssh-agent-web/features/sftp/components/sftp-delete-dialog.tsx` |
| 前端 Workspace 级上传管理 | `packages/ssh-agent-web/features/sftp/components/sftp-transfer-provider.tsx` |
| 前端 SSE、监控和 Transfer 状态推导 | `packages/ssh-agent-web/features/sftp/model/sftp-state.ts` |
| 联调契约 | `docs/ssh-agent/frontend/sftp-overview-realtime-integration.md` |

修改 Transfer 状态时必须保持六状态边界，不能把 Channel 排队或 rename 阶段暴露为新状态。修改覆盖流程时必须保持“不确定结果不自动重放”和“无原子扩展不覆盖”。

Workspace 目录浏览也供沙盒多选器使用：跨目录勾选保留已选路径，按目录 realpath 回填列表，最多 16 条，`/` 只可浏览。SFTP 默认从 `/` 浏览，不由 Session 可写范围替换。Overview 显式沙箱检测校验并展示 Workspace 默认列表的全部规范根，不代表某个 Session 的当前覆盖配置；它不改变 Session 开关或现有 PTY。
