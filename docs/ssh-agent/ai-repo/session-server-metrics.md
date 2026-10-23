# Session 页首服务器指标

适用于已有 Session 标题后的服务器与会话信息卡片，汇总 CPU、内存、网络、磁盘 I/O、本地工作目录和沙盒可写目录。指标是远端服务器整体数据，按 Workspace 共享，不表示单个会话或进程的资源占用。

## 数据与生命周期

- `RemoteMetricsService` 继续按 Workspace 维护唯一 Collector；Session 的 `monitoring` 订阅可启动它，无需先打开 Overview。原基础/进程采集周期、串行队列和最后订阅离开后 30 秒释放策略保留。
- `WorkspaceEventHub.registerSnapshotProvider()` 是只读缓存接入点：订阅建立时在 `stream.ready` 后，只向新订阅者发送该 topic 的现存快照，不广播给旧订阅者、不额外执行远端命令、不新增 REST 查询或数据库存储。服务关闭注销提供者，已停止 Collector 的迟到采样不再发布。
- `monitor.snapshot` 增加可选 `network`，包含 `interfaceName` 和 `receiveBytesPerSecond/transmitBytesPerSecond`。首次采样或重建基准时速率为 null；缺少可读统计或可用默认路由时省略 network，CPU/内存仍正常展示。
- 网络 probe 与原基础 probe 共用一个 SSH exec，不睡眠、不抓包、不依赖额外安装。读取 `/proc/net/dev`、IPv4/IPv6 默认路由及远端 uptime；优先选最低 metric 的可用 IPv4 默认路由，无 IPv4 时选 IPv6，不累加所有网卡。
- 独立 `RemoteNetworkSampler` 使用 bigint 保存累计字节数，以实际远端采样时间差计算 B/s。SSH 目标身份/连接代际变化、网卡变化、uptime 回退或计数器回退均重新建立基准，避免负数和尖峰；统计缺失时清除旧基准。两个定时任务重合或间隔不足 1 秒时复用上一速率与原基准，下一次有效采样仍包含期间全部字节。
- `monitor.snapshot` 另有可选 `diskIo`，提供 `readBytesPerSecond/writeBytesPerSecond`。由独立 `RemoteDiskIoSampler` 汇总可见的底层整盘块设备，统计服务器读写吞吐量，不表示容量、单个进程或文件的读写量。probe 合并进现有基础采样命令，不新增 SSH exec、轮询定时器、依赖或持久化，也不进入 Agent 上下文。
- 磁盘累计扇区数以 bigint 计算增量，再用远端 uptime 的真实间隔换算 B/s；首次、设备集合/身份、SSH 目标或连接代际变化、uptime/计数回退时重建基准，两项速率为 null；不足 1 秒时保留之前速率与基准。缺少可用统计时省略 diskIo，CPU/内存/网络继续正常工作。单位依据 [Linux 内核块设备统计](https://docs.kernel.org/block/stat.html)：统计扇区固定为 512 字节，不使用文件系统 block size。
- I/O probe 读取 `/sys/block/*/stat` 的读取/写入扇区、`dev` 及可选 `diskseq`，仅统计可读取且 `slaves` 为空的整盘设备；排除分区标记及 loop、ram、zram、fd、sr 设备，避免叠加分区与 LVM/RAID 的映射层。NVMe/virtio 设备保持可用，不通过数字尾缀推断分区。设备集合按身份比较，各设备独立检查回退；名称、身份和原始计数只留在采样内存，SSE 仅发送两项速率。权限不足或缺少 sysfs 时保守显示不可用。

## 前端边界

- `features/server-metrics/` 独立持有数据投影、事件适配器、共享内存 store、React hook 和展示。只消费 Workspace `monitoring`，不消费 Chat Run/Terminal/Deployment 事件，不依赖 SFTP 页面状态；事件地址使用与普通 API 隔离的事件 origin，见 [transport-channels.md](./transport-channels.md)。
- store 按 Workspace + Locale 共享监控订阅，底层再通过 shared/events/workspace-events.ts 与标题/Deploy/Diagnose/SFTP 复用 Workspace 连接。最后指标消费者离开即移除 monitoring 订阅，其他功能继续接收事件；缓存保留 30 秒后淘汰。跨同工作区会话可立即显示已有快照。更换工作区或语言使用独立资源，关闭订阅的迟到回调与较旧/其他工作区快照不能覆盖当前数据。
- 首次等待显示占位符；断线、monitor.error 和超过 10 秒未更新时分别表示重连、失败或等待更新，并保留最后成功数据。监控恢复后清除错误；首次网络基准显示采样中，不伪造零速率。
- `ChatConsole` 将 `SessionInfoPopover` 放入 `ChatPageHeader.sessionInfo`，最终通过通用 `PageHeader.titleTrailing` 插槽紧邻标题展示单个信息图标，右侧恢复原有沙盒图标与短文案，位于 Run 状态之前。页首只组合展示，不持有采集/订阅逻辑。`SessionServerMetrics` 作为卡片资源区域传入，卡片隐藏时仍挂载，不随悬浮重复创建监控订阅。
- 卡片支持悬浮、键盘聚焦和点击打开；移出后延迟关闭，点击可保持打开，方向键下移入卡片，Escape、失焦或点击外部关闭。通过 body portal 固定定位，宽度最大 380px，按视口留白约束，长目录换行且内容可滚动。页首保持单行，长标题截断，窄屏不展开整行指标。
- `ServerMetricsStrip` 在卡片展示 CPU 百分比、内存百分比及已用/总量、网络发送 ↑ / 接收 ↓，网络下方另有硬盘图标与“磁盘 I/O”读/写速率；容量与速率按 B、KiB、MiB、GiB 转换。不展示网卡说明、实时状态和更新时间两行描述，采样状态保留在无障碍名称中，缺失或首次基准使用占位符，真实空闲显示 0 B/s，采集错误仍显示。Overview 仍展示原三个资源卡，不增加网络或 I/O 卡。新增可选字段单独校验，旧快照或畸形 I/O 不影响其余指标。
- 本地目录优先取 Session `workDir`；历史 null 值由 `useSessionWorkDir` 在首次打开时通过现有本地文件接口的 `rootPath` 解析后端默认目录，不猜测 Workspace 默认值。成功结果缓存，请求关闭或切换会话时取消；失败显示不可用并在下次打开重试。沙盒范围来自 Hook 已确认的最新设置：普通开启列出 Session 目录，只读列出 `/tmp` 并说明 `/dev/null` 例外，关闭时明确目录限制未启用，不将保留的配置冒充有效范围。

## 入口与移除

| 职责 | 文件 |
|---|---|
| 网络公共契约 | `packages/ssh-agent/src/domain/remote-network-metrics.ts` |
| 固定 probe、路由选择、计数基准和速率计算 | `packages/ssh-agent/src/application/monitoring/remote-network-sampler.ts` |
| 磁盘 I/O 契约、设备统计与独立采样基准 | `packages/ssh-agent/src/domain/remote-disk-io-metrics.ts`、`packages/ssh-agent/src/application/monitoring/remote-disk-io-sampler.ts` |
| Collector 接入与最新快照 | `packages/ssh-agent/src/application/services/remote-metrics-service.ts` |
| 缓存订阅接入点和 SSE 公共字段 | `packages/ssh-agent/src/application/workspace-event-hub.ts` |
| 前端投影、订阅和共享缓存 | `packages/ssh-agent-web/features/server-metrics/model/server-metrics.ts`、`runtime/server-metrics-stream.ts`、`runtime/server-metrics-store.ts`、`runtime/use-server-metrics.ts` |
| 页首展示和局部样式 | `packages/ssh-agent-web/features/server-metrics/components/session-server-metrics.tsx`、`server-metrics-strip.tsx`、`server-metrics.css` |
| 信息卡片、定位与本地目录解析 | `packages/ssh-agent-web/features/session/components/session-info-popover.tsx`、`session-info-popover.css`、`runtime/use-session-work-dir.ts` |
| 组合接入 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`chat-page-header.tsx` |
| 中英文目录 | 资源文案使用 `packages/ssh-agent-web/features/i18n/messages/zh-CN/server-metrics.ts`、`en-US/server-metrics.ts`，卡片和目录状态使用对应 `session.ts` |
| 回归 | `packages/ssh-agent/test/remote-network-sampler.test.ts`、`remote-disk-io-sampler.test.ts`、`remote-metrics-subscriptions.test.ts`、`packages/ssh-agent-web/tests/server-metrics-store.test.ts`、`server-metrics-strip.test.tsx`、`session-work-dir.test.ts` |

仅移除资源指标时，删除信息卡片的 `SessionServerMetrics` 槽内容即可停止该功能的订阅，再移除 `features/server-metrics/` 及其独立双语目录/聚合入口；会话目录和沙盒信息可继续保留。完全移除卡片时再移除 ChatConsole 的 `sessionInfo`、Popover 和目录解析 Hook。完全移除网络采集时，再移除 Sampler、network 字段及 RemoteMetricsService 的少量接入；缓存快照接口可以独立保留供原 Overview 使用。不涉及 migration 或历史数据清理。

仅移除磁盘 I/O 时，移除对应 Sampler/probe、Collector 的 diskIo 接入、可选契约、卡片行及双语键即可，不影响网络或原容量卡，也不涉及数据库迁移。

定向测试使用模拟 Broker、EventSource 端口和时钟。真实 Linux/SSH 采样未由这些测试证明，需在已授权目标上另行验收。
