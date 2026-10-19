# 使用统计代码路由

适用于全局用量概览、年度活动日历、模型用量、Agent 运行记录和工作区用量。HTTP 契约见 [statistics-api.md](../frontend/statistics-api.md)。

## 职责与依赖

- 后端独立链路为 `statistics-routes` → `StatisticsService` → `StatisticsQuery` → `SqliteStatisticsQuery`。只有 SQLite 实现知道已有表结构；不依赖 Chat、Terminal、Deployment、Provider Service 或它们的 Repository，不参与写入、事件、权限或恢复流程。
- `create-sqlite-management-backend` 只注入共享数据库和时钟；HTTP handler 在既有异常/Locale 边界内挂载 `/api/statistics/*`。共享 SQLite transaction ownership guard 继续生效，统计不绕过事务所有者访问连接。
- SQLite 实现注册只读、确定性的日期分桶函数，使用 IANA 时区；SQL 提取必要标量并聚合，不把消息正文、摘要、retained tail、工具输出或凭据发送到浏览器。
- v29 仅追加五个查询索引：消息时间、消息 Run 关联、Run 时间/ID、Workspace+Run 时间/ID，以及非空启动时间。不改写旧 migration 或历史用量，不新增统计事实表、轮询和采集任务。
- 前端 `features/statistics/` 独立持有契约校验、查询请求、URL 状态、四个 Tab、图表和样式。仅复用基础页面、Sidebar、HTTP 客户端和国际化，不依赖其他业务运行 Hook。切换 Tab 卸载旧查询，AbortSignal 与请求身份阻止旧响应覆盖新数据。

## 页面与统计口径

- `/statistics` 默认概览、最近 30 天、全部工作区/模型。`tab/range/start/end/workspaceId/model/timeZone/year/status/cursor/modelSort/workspaceSort/direction` 通过 URL 恢复；浏览器前进后退监听 `popstate`。模型身份编码为 `[providerId, modelId]`，避免跨 Provider 同名合并。
- 概览合并四张指标卡、日/周趋势与年度热力图。趋势切换 Token/费用/运行数；Token 图例可独立显隐。日历全年独立于顶部时间范围，但继续应用工作区/模型筛选。只查询当前 Tab，手动刷新，提供独立 loading/error/empty 状态。
- 模型表展示次数、四类 Token 与估算费用，支持次数/Token/费用排序；工作区表展示运行、活跃日、模型调用、Token 和费用，并按所选指标显示占比。运行列表默认 25 条，按 `(created_at DESC, id DESC)` 游标分页；行展开只读用量和已有安全失败说明，可跳回会话。
- 用量按顶层 `assistant`/`compact` 记录自身的时间、Provider 和模型归属，手动压缩的 null Run 同样计入；不遍历 retained tail。输入、输出、缓存读取、缓存写入相加，reasoning 已属于输出，不再次累加。
- `calls` 是保存的响应/压缩记录数，不是完整 HTTP 请求数；自动标题和未持久化重试开销不包含。四个 Token 分项完整、非负整数时才增加 `usageSamples`；历史费用有合法 total 才增加 `costSamples`。未上报用量/费用与已报告的 0 分别展示，部分缺失时提示覆盖范围。
- 费用沿用历史 `usage_json.cost`，不调用现价目录或重新定价，统一标为 USD 估算。常规费用最多显示四位小数，小额最多六位；更小的正数显示 `<` 下界提示。
- Run 数及其筛选按 Run 创建时间和运行模型归属；行内用量按 Run ID 先聚合全部生命周期的顶层响应，包含不同的压缩模型。完成率为 completed / (completed + failed + cancelled)，无已结束运行时为 null；有效已结束运行才参与平均/最长时长，包含等待审批/用户回答的时间。
- 活跃日是已保存响应/压缩或已启动 Run 所在的自然日；pending 且未启动不算。当前连续天数按截至今天的全部保留历史计算，今天无活动时允许从昨天接续；年内最长和活跃天数只计算所选年。未来日期无活动、不可聚焦。
- 时间区间为 `[from, to)`，默认浏览器 IANA 时区；服务端直接调用接口时缺省 Asia/Shanghai。午夜不存在的夏令时日期采用该自然日第一个有效时刻。零值日期补齐；“全部时间”趋势从首条相关记录开始。
- 数据随原有会话删除级联减少；模型下架仍保留历史标识。统计没有独立账本，不承诺覆盖已删除记录。

## UI 接入与维护

- Sidebar 底部在设置右边增加统计入口，收起后两个入口纵向排列；展开 footer 46px、收起 82px。统计入口沿用文件传输导航保护，窄屏使用已有抽屉。
- 统计正文采用独立的专业分析配色：中性灰画布、深色 KPI 卡、白色分析面板及分色图表；暗部主题使用对应的中性深色表面。局部语义变量仅覆盖统计页 main，Sidebar 及其他功能继续使用全局主题。ION 实验主题由 `features/theme/styles/ion.css` 覆盖统计页局部变量，使用紫色深色表面与琥珀、紫、蓝、玫红数据序列，沿用同一统计组件和数据口径。筛选栏、面板标题带、表头、等宽数字、隔行底色和状态标签加强信息层级；四个 Tab、统计字段、图表类型及口径保持不变。提供中英文独立目录，宽表/日历仅在自身容器滚动，390px 窄屏指标两列。
- 时间范围、工作区、模型、模型排序、运行状态、趋势粒度和年度选择统一复用基础 `CustomSelect`，不使用系统原生下拉菜单。统计局部样式提供主题菜单、选中标记、焦点和悬停态，固定箭头宽度与 12px 右留白；收起时长文本省略、展开选项完整换行、菜单限高滚动，窄屏筛选两列。
- 趋势柱状图和年度网格的详情统一使用 `statistics-tooltip.tsx`：固定定位浮层跟随鼠标，基于浮层实测尺寸在视口边缘翻转并保留 12px 安全距离。柱状图只在指针命中实际柱体时挂载详情，透明整列命中层不接收指针；离开柱体后卸载，进入另一柱体按日期重新挂载，键盘聚焦只保留精确数值标签。日历仅对 Token 或运行次数至少一项非零的日期显示浮层，键盘聚焦此类日期时以格子为锚；移出、失焦、滚动、窗口变化和 Escape 关闭。移除原底部详情及原生 title，保留图例、准确数值、aria-describedby 与日历的读屏播报；定位纯函数位于 `model/statistics-tooltip-position.ts`。
- 移除功能时移除统计页面/feature/双语目录、Sidebar 入口、HTTP 挂载和 runtime 装配即可；历史索引 migration 保留。
- 已核对共享挂载处原有 Chat、图片/附件、本地文件、Guard、Provider、Connection、SFTP、压缩、上下文、标题、沙盒、用户决策、Terminal 和页首监控链路；统计不修改其调用与生命周期。共享文件中的其他并行改动由各自功能文档维护。

## 源码入口与测试

| 职责 | 入口 |
|---|---|
| 独立 DTO | `packages/ssh-agent/src/domain/statistics.ts` |
| 查询端口、汇总及日期工具 | `packages/ssh-agent/src/application/statistics/` |
| SQLite 聚合、筛选与稳定分页 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-statistics-query.ts` |
| GET 路由及参数校验 | `packages/ssh-agent/src/api/statistics-routes.ts` |
| 页面、四个 Tab、SVG 与年度日历 | `packages/ssh-agent-web/app/statistics/page.tsx`、`packages/ssh-agent-web/features/statistics/` |
| 双语文案 | `packages/ssh-agent-web/features/i18n/messages/zh-CN/statistics.ts`、`en-US/statistics.ts` |
| 后端定向回归 | `packages/ssh-agent/test/statistics.test.ts` |
| 前端契约、图表、双语与请求竞态 | `packages/ssh-agent-web/tests/statistics.test.tsx`、`statistics-runtime.test.ts`、`statistics-tooltip.test.tsx`、`statistics-chart-interactions.test.tsx` |

定向测试使用隔离 SQLite、合成记录和模拟请求；浏览器验收使用临时数据库与 faux 模型，不连接真实 SSH 或付费模型。构建不表示真实供应商账单核对。
