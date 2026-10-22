# 使用统计代码路由

适用于全局用量概览、年度活动日历、模型用量、逐次模型调用缓存率、Agent 运行记录和工作区用量。HTTP 契约见 [statistics-api.md](../frontend/statistics-api.md)。

## 职责与依赖

- 后端独立链路为 `statistics-routes` → `StatisticsService` → `StatisticsQuery` → `SqliteStatisticsQuery`。只有 SQLite 实现知道已有表结构；不依赖 Chat、Terminal、Deployment、Provider Service 或它们的 Repository，不参与写入、事件、权限或恢复流程。
- `create-sqlite-management-backend` 只注入共享数据库和时钟；HTTP handler 在既有异常/Locale 边界内挂载 `/api/statistics/*`。共享 SQLite transaction ownership guard 继续生效，统计不绕过事务所有者访问连接。
- SQLite 实现注册只读、确定性的日期分桶函数，使用 IANA 时区；SQL 提取必要标量并聚合，不把消息正文、摘要、retained tail、工具输出或凭据发送到浏览器。
- v29 仅追加五个查询索引：消息时间、消息 Run 关联、Run 时间/ID、Workspace+Run 时间/ID，以及非空启动时间。不改写旧 migration 或历史用量，不新增统计事实表、轮询和采集任务。
- 前端 `features/statistics/` 独立持有契约校验、查询请求、URL 状态、五个 Tab、图表和样式。仅复用基础页面、Sidebar、HTTP 客户端和国际化，不依赖其他业务运行 Hook。切换 Tab 卸载旧查询，AbortSignal 与请求身份阻止旧响应覆盖新数据。

## 页面与统计口径

- `/statistics` 默认概览、最近 30 天、全部工作区/模型。`tab/range/start/end/workspaceId/providerId/model/timeZone/year/status/cursor/modelSort/workspaceSort/direction` 通过 URL 恢复；浏览器前进后退监听 `popstate`。厂商与模型采用两级筛选：先选择厂商，再选择该厂商的模型；未选择厂商时二级模型禁用，可仅筛选厂商并保留“全部模型”。模型身份仍编码为 `[providerId, modelId]`，避免跨厂商同名合并。旧链接只有 model pair 时推导厂商；显式厂商优先，冲突模型会被清除。切换厂商清模型和游标，清空模型仍保留厂商；旧选择不在 options 中时保持筛选及回显，不静默退到全部。
- 概览合并四张指标卡、日/周趋势与年度热力图。趋势切换 Token/费用/运行数；Token 图例可独立显隐。日历全年独立于顶部时间范围，但继续应用工作区/模型筛选。只查询当前 Tab，手动刷新，提供独立 loading/error/empty 状态。
- 模型表展示次数、四类 Token 与估算费用，支持次数/Token/费用排序；工作区表展示运行、活跃日、模型调用、Token 和费用，并按所选指标显示占比。运行列表默认 25 条，按 `(created_at DESC, id DESC)` 游标分页；行展开只读用量和已有安全失败说明，可跳回会话。
- 用量按顶层 `assistant`/`compact` 记录自身的时间、Provider 和模型归属，手动压缩的 null Run 同样计入；不遍历 retained tail。输入、输出、缓存读取、缓存写入相加，reasoning 已属于输出，不再次累加。
- `calls` 是保存的响应/压缩记录数，不是完整 HTTP 请求数；自动标题和未持久化重试开销不包含。四个 Token 分项完整、非负整数时才增加 `usageSamples`；历史费用有合法 total 才增加 `costSamples`。未上报用量/费用与已报告的 0 分别展示，部分缺失时提示覆盖范围。
- 费用沿用历史 `usage_json.cost`，不调用现价目录或重新定价，统一标为 USD 估算。常规费用最多显示四位小数，小额最多六位；更小的正数显示 `<` 下界提示。
- Run 数及其筛选按 Run 创建时间和运行模型归属；行内用量按 Run ID 先聚合全部生命周期的顶层响应，包含不同的压缩模型。完成率为 completed / (completed + failed + cancelled)，无已结束运行时为 null；有效已结束运行才参与平均/最长时长，包含等待审批/用户回答的时间。
- 活跃日是已保存响应/压缩或已启动 Run 所在的自然日；pending 且未启动不算。当前连续天数按截至今天的全部保留历史计算，今天无活动时允许从昨天接续；年内最长和活跃天数只计算所选年。未来日期无活动、不可聚焦。
- 时间区间为 `[from, to)`，默认浏览器 IANA 时区；服务端直接调用接口时缺省 Asia/Shanghai。午夜不存在的夏令时日期采用该自然日第一个有效时刻。零值日期补齐；“全部时间”趋势从首条相关记录开始。
- 数据随原有会话删除级联减少；模型下架仍保留历史标识。统计没有独立账本，不承诺覆盖已删除记录。

## 逐次模型调用与真实缓存率

“模型调用”页签独立请求 `GET /api/statistics/call-records`，按响应/压缩记录的保存时间、展开后的稳定 ID 倒序分页，使用原时间、工作区及实际响应模型筛选。表格展示会话、工作区、模型、调用类型、API 总输入、API 缓存命中 Token 及缓存率；不使用 Run 聚合结果代替单次调用。分页继续为默认 25、最多 100 条，所有查询只读，不加载提示词、工具结果或摘要正文。

缓存率严格为 **API 明确返回的缓存命中 Token / API 明确返回的总输入 Token**。总输入包含命中输入及 API 计入的缓存写入，不包含输出或 reasoning；不使用总 Token、字符估算、费用、缓存开关、前缀指纹或缓存写入量冒充命中量。

- `Usage.cacheReadDetails={inputTokens,cachedTokens}` 在 Provider 适配边界、原始字段被默认成 0 之前采集。共享 Responses（含订阅/Azure/Codex 链路）、Completions 及 Mistral 仅在两个原始字段均明确存在、是非负安全整数且命中不超过总输入时保存。没有可靠采集的协议保持未上报。
- `reported` 表示有合法来源；总输入大于 0 时计算 0–1 的 hitRate。明确命中 0 才显示 0%，明确全命中才显示 100%；微小正值显示 `<0.01%`，接近但未到全命中显示 `>99.99%`，同时展示精确计数。总输入和命中均为 0 时比例未定义，显示“无输入”。
- `unreported` 表示 API 未上报完整可用字段，或旧记录没有保存来源信息；`invalid` 表示已保存的明细结构/数字不合法。两者均返回 null 计数/比例，不回退到旧的标准化 input/cacheRead/cacheWrite，不能把缺失当作真实 0%。不修改历史数据以猜测缓存率。
- 普通 assistant 每条记录对应已保存的响应。新 compact 的聚合 Usage 额外保存 `requests` 原始用量列表：单请求一条，history/turnPrefix 双请求保留两条；统计展开每条后分别计算，kind=compact。合计 Token/费用仍按原顶层记录计算，不能把 requests 再加到概览或 Run 合计中。
- 旧 compact 没有 requests 时显示 kind=compact_summary 的“历史压缩汇总”，比例一律未上报，不冒充一次请求。自动标题、未保存的 HTTP 重试与失败压缩开销仍不包含，页面明确按当前保留记录统计。
- 同步修正 `cache.usage` 日志的 cacheRate：只从同一可信明细计算，缺失/零输入为 null，并用 cacheReported 区分；统计查询直接读 SQLite 的已保存明细，不依赖日志。

不新增数据库表或迁移；可选元数据随既有 usage_json 保存，服务重启后仍可查询，删除会话继续级联删除。其他统计聚合、费用、权限与模型请求组织不变。基础类型与 JSON 向后兼容，但旧标准化数字不能证明是否为 API 明确返回，不能追认历史缓存率。

## UI 接入与维护

- Sidebar 底部在设置右边增加统计入口，收起后两个入口纵向排列；展开 footer 46px、收起 82px。统计入口沿用文件传输导航保护，窄屏使用已有抽屉。
- 统计正文采用独立的专业分析配色：中性灰画布、深色 KPI 卡、白色分析面板及分色图表；暗部主题使用对应的中性深色表面。局部语义变量仅覆盖统计页 main，Sidebar 及其他功能继续使用全局主题。ION 实验主题由 `features/theme/styles/ion.css` 覆盖统计页局部变量，使用紫色深色表面与琥珀、紫、蓝、玫红数据序列，沿用同一统计组件和数据口径。筛选栏、面板标题带、表头、等宽数字、隔行底色和状态标签加强信息层级；五个 Tab、统计字段、图表类型及口径保持不变。提供中英文独立目录，宽表/日历仅在自身容器滚动，390px 窄屏指标两列。
- 时间范围、工作区、厂商、模型、模型排序、运行状态、趋势粒度和年度选择统一复用基础 `CustomSelect`，不使用系统原生下拉菜单。统计局部样式提供主题菜单、选中标记、焦点和悬停态，固定箭头宽度与 12px 右留白；收起时长文本省略、展开选项完整换行、菜单限高滚动，窄屏筛选两列。
- 趋势柱状图和年度网格的详情统一使用 `statistics-tooltip.tsx`：固定定位浮层跟随鼠标，基于浮层实测尺寸在视口边缘翻转并保留 12px 安全距离。柱状图只在指针命中实际柱体时挂载详情，透明整列命中层不接收指针；离开柱体后卸载，进入另一柱体按日期重新挂载，键盘聚焦只保留精确数值标签。日历仅对 Token 或运行次数至少一项非零的日期显示浮层，键盘聚焦此类日期时以格子为锚；移出、失焦、滚动、窗口变化和 Escape 关闭。移除原底部详情及原生 title，保留图例、准确数值、aria-describedby 与日历的读屏播报；定位纯函数位于 `model/statistics-tooltip-position.ts`。
- 移除功能时移除统计页面/feature/双语目录、Sidebar 入口、HTTP 挂载和 runtime 装配即可；历史索引 migration 保留。
- 已核对共享挂载处原有 Chat、图片/附件、本地文件、Guard、Provider、Connection、SFTP、压缩、上下文、标题、沙盒、用户决策、Terminal 和页首监控链路；统计不修改其调用与生命周期。共享文件中的其他并行改动由各自功能文档维护。

## 源码入口与测试

| 职责 | 入口 |
|---|---|
| 独立 DTO | `packages/ssh-agent/src/domain/statistics.ts` |
| 查询端口、汇总及日期工具 | `packages/ssh-agent/src/application/statistics/` |
| Provider 原始缓存计数采集 | `packages/ai/src/utils/reported-cache-usage.ts`、`api/openai-responses-shared.ts`、`api/openai-completions.ts`、`api/mistral-conversations.ts` |
| 压缩逐请求用量保留 | `packages/agent/src/harness/compaction/compaction.ts`、`packages/ai/src/types.ts` |
| SQLite 聚合、筛选与稳定分页 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-statistics-query.ts` |
| GET 路由及参数校验 | `packages/ssh-agent/src/api/statistics-routes.ts` |
| 页面、五个 Tab、SVG 与年度日历 | `packages/ssh-agent-web/app/statistics/page.tsx`、`packages/ssh-agent-web/features/statistics/` |
| 双语文案 | `packages/ssh-agent-web/features/i18n/messages/zh-CN/statistics.ts`、`en-US/statistics.ts` |
| 后端定向回归 | `packages/ssh-agent/test/statistics.test.ts`、`provider-cache-usage.test.ts` |
| 前端契约、图表、双语与请求竞态 | `packages/ssh-agent-web/tests/statistics.test.tsx`、`statistics-runtime.test.ts`、`statistics-tooltip.test.tsx`、`statistics-chart-interactions.test.tsx`、`statistics-model-filters.test.tsx` |

定向测试使用隔离 SQLite、合成记录和模拟请求；浏览器验收使用临时数据库与 faux 模型，不连接真实 SSH 或付费模型。构建不表示真实供应商账单核对。

缓存回归使用真实适配器加假 SSE、临时 SQLite 与 HTTP handler，验证真实 0/部分/全命中、未报告不推断、总输入为零、非法/缺失字段、输出不入分母、缓存写入不算命中、原始字段持久化后查询、双摘要逐次展开、旧汇总、游标及只读边界。无真实 Provider 或账单调用。已核对共享 Usage 可选字段对消息角色、图片投影、失败分类、校准、头部稳定及原有费用/Token聚合无行为变化。

两级筛选由 `components/statistics-model-filters.tsx` 组合两个 CustomSelect，二级按厂商 ID 重建以关闭旧菜单；共用 statisticsParams 向所有 Tab 传 providerId/可选 modelId，options 保持全局读取。回归覆盖厂商独立筛选、跨厂商同名、旧 URL、冲突/历史身份、切换清理、浏览器历史和中英文。
