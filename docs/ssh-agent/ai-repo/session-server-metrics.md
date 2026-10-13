# Session 页首服务器指标

适用于已有 Session 页首的 CPU、内存和网络收发速率。数据是远端服务器整体指标，按 Workspace 共享，不表示单个会话或进程的资源占用。

## 数据与生命周期

- `RemoteMetricsService` 继续按 Workspace 维护唯一 Collector；Session 的 `monitoring` 订阅可启动它，无需先打开 Overview。原基础/进程采集周期、串行队列和最后订阅离开后 30 秒释放策略保留。
- `WorkspaceEventHub.registerSnapshotProvider()` 是只读缓存接入点：订阅建立时在 `stream.ready` 后，只向新订阅者发送该 topic 的现存快照，不广播给旧订阅者、不额外执行远端命令、不新增 REST 查询或数据库存储。服务关闭注销提供者，已停止 Collector 的迟到采样不再发布。
- `monitor.snapshot` 增加可选 `network`，包含 `interfaceName` 和 `receiveBytesPerSecond/transmitBytesPerSecond`。首次采样或重建基准时速率为 null；缺少可读统计或可用默认路由时省略 network，CPU/内存仍正常展示。
- 网络 probe 与原基础 probe 共用一个 SSH exec，不睡眠、不抓包、不依赖额外安装。读取 `/proc/net/dev`、IPv4/IPv6 默认路由及远端 uptime；优先选最低 metric 的可用 IPv4 默认路由，无 IPv4 时选 IPv6，不累加所有网卡。
- 独立 `RemoteNetworkSampler` 使用 bigint 保存累计字节数，以实际远端采样时间差计算 B/s。SSH 目标身份/连接代际变化、网卡变化、uptime 回退或计数器回退均重新建立基准，避免负数和尖峰；统计缺失时清除旧基准。两个定时任务重合或间隔不足 1 秒时复用上一速率与原基准，下一次有效采样仍包含期间全部字节。

## 前端边界

- `features/server-metrics/` 独立持有数据投影、EventSource adapter、共享内存 store、React hook 和展示。只消费 Workspace `monitoring`，不消费 Chat Run/Terminal/Deployment 事件，不依赖 SFTP 页面状态。
- store 按 Workspace + Locale 共享一个连接，最后消费者离开即关闭连接，缓存保留 30 秒后淘汰；跨同工作区会话可立即显示已有快照。更换工作区或语言使用独立资源，关闭连接的迟到回调与较旧/其他工作区快照不能覆盖当前数据。
- 首次等待显示占位符；断线、monitor.error 和超过 10 秒未更新时分别表示重连、失败或等待更新，并保留最后成功数据。监控恢复后清除错误；首次网络基准显示采样中，不伪造零速率。
- `SessionServerMetrics` 在 `ChatConsole` 的页首接入，`ChatPageHeader` 只接受可选 ReactNode 插槽，不持有采集/订阅逻辑。`ServerMetricsStrip` 展示三个图标组：CPU 百分比、内存百分比、网络发送 ↑ / 接收 ↓，速率按 B/s、KiB/s、MiB/s、GiB/s 转换。
- 悬停与无障碍文案说明服务器视角、网卡、更新时间和数据状态。桌面保持紧凑单行，窄屏页首换行以保留全部指标。Overview 仍展示原三个资源卡，不增加网络卡。

## 入口与移除

| 职责 | 文件 |
|---|---|
| 网络公共契约 | `packages/ssh-agent/src/domain/remote-network-metrics.ts` |
| 固定 probe、路由选择、计数基准和速率计算 | `packages/ssh-agent/src/application/monitoring/remote-network-sampler.ts` |
| Collector 接入与最新快照 | `packages/ssh-agent/src/application/services/remote-metrics-service.ts` |
| 缓存订阅接入点和 SSE 公共字段 | `packages/ssh-agent/src/application/workspace-event-hub.ts` |
| 前端投影、订阅和共享缓存 | `packages/ssh-agent-web/features/server-metrics/model/server-metrics.ts`、`runtime/server-metrics-stream.ts`、`runtime/server-metrics-store.ts`、`runtime/use-server-metrics.ts` |
| 页首展示和局部样式 | `packages/ssh-agent-web/features/server-metrics/components/session-server-metrics.tsx`、`server-metrics-strip.tsx`、`server-metrics.css` |
| 组合接入 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`chat-page-header.tsx` |
| 独立中英文目录 | `packages/ssh-agent-web/features/i18n/messages/zh-CN/server-metrics.ts`、`en-US/server-metrics.ts` |
| 回归 | `packages/ssh-agent/test/remote-network-sampler.test.ts`、`remote-metrics-subscriptions.test.ts`、`packages/ssh-agent-web/tests/server-metrics-store.test.ts`、`server-metrics-strip.test.tsx` |

仅移除 Session 展示时，删除 ChatConsole 的组件导入与页首插槽内容即可停止该功能的订阅，再移除 `features/server-metrics/` 及其独立双语目录/聚合入口；ChatPageHeader 的可选插槽也可删除。完全移除网络采集时，再移除 Sampler、network 字段及 RemoteMetricsService 的少量接入；缓存快照接口可以独立保留供原 Overview 使用。不涉及 migration 或历史数据清理。

定向测试使用模拟 Broker、EventSource 端口和时钟。真实 Linux/SSH 采样未由这些测试证明，需在已授权目标上另行验收。
