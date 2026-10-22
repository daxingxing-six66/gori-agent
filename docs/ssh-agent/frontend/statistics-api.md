# 使用统计 HTTP 契约

所有接口位于 `/api/statistics/`，只接受 GET，成功返回 `Cache-Control: no-store`。沿用通用 REST Locale 和公开异常边界；不新增 SSE。

## 查询参数

| 参数 | 语义 |
|---|---|
| `from` / `to` | 毫秒时间戳，左闭右开，`from < to`；缺省最近 30 个自然日截至当前时刻，0 表示全部历史起点。范围限制在 1970–2101。 |
| `timeZone` | 合法 IANA 时区，缺省 Asia/Shanghai；前端发送浏览器时区。 |
| `workspaceId` | 可选，精确匹配工作区。 |
| `providerId` / `modelId` | 可选，精确匹配保存的历史标识；providerId 可单独筛选整个厂商，提交 modelId 时必须同时提交 providerId。 |
| `year` | 概览活动日历年份，1970–2100，缺省当前年；不受 from/to 限制。 |
| `sort` / `direction` | 模型与工作区表支持 tokens/cost/calls，工作区另支持 runs；方向 asc/desc，缺省 desc。 |
| `status` | 运行记录可选 pending/running/completed/failed/cancelled。 |
| `limit` / `cursor` | 运行记录与模型调用记录分页，缺省 25、最大 100；cursor 是对应接口上一响应给出的不透明字符串，不在两个列表间混用。 |

日期、数值、时区、状态和游标非法返回既有 `400 validation_error`，携带 field。不存在的工作区/历史模型筛选返回空统计，不触发业务查询或供应商请求。

## 接口

| GET 路径 | 响应 |
|---|---|
| `/options` | `{ workspaces: [{id,name,hostname}], models: [{providerId,modelId}], earliestAt: number \| null }`；来自现有工作区、响应/压缩及 Run 记录。 |
| `/overview` | `{ generatedAt, range, usage, runs, trend, calendar }`。 |
| `/models` | `{ generatedAt, range, rows: [{providerId,modelId,usage}] }`。 |
| `/runs` | `{ generatedAt, range, summary }`；状态筛选只作用于下方记录列表，不改变本摘要。 |
| `/run-records` | `{ generatedAt, range, rows, nextCursor: string \| null }`。 |
| `/call-records` | `{ generatedAt, range, rows: StatisticsCallRow[], nextCursor: string \| null }`；逐条模型响应/压缩请求及明确标记的历史压缩汇总。 |
| `/workspaces` | `{ generatedAt, range, rows: [{workspaceId,name,hostname,runs,activeDays,usage}] }`。 |

`range` 为 `{from,to,timeZone}`。生成时间与统计范围均由服务端返回。

`usage`：

```ts
{
  calls: number;
  usageSamples: number;
  costSamples: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  cost: {input: number; output: number; cacheRead: number; cacheWrite: number; total: number};
}
```

`calls` 统计顶层响应/压缩记录。`usageSamples/costSamples` 表示有完整 Token/已报告费用的记录数；聚合数值的 0 不能独立用于判断是否未上报。浏览器以样本数区分缺失和真实零，并提示部分缺失。

`summary`/概览 `runs`：`total,pending,running,completed,failed,cancelled` 加 `completionRate,averageDurationMs,longestDurationMs`；后面三个在无有效样本时为 null，完成率是 0–1。

`trend` 和 `calendar.days` 的每一项为 `{date: YYYY-MM-DD, usage, runs, active}`。趋势按所选时间补齐日数据，前端可按周合并；日历为完整年份，`runs` 按实际启动日期计数，pending 不算活跃。`calendar` 另有 `year,from,to,activeDays,currentStreak,longestStreak,peakTokens`；currentStreak 是截至今天的全历史连续天数，其余年内指标使用所选年。

运行记录包含：`id,createdAt,startedAt,finishedAt,sessionId,sessionName,workspaceId,workspaceName,providerId,modelId,status,durationMs,failure,usage`。起止/时长可为 null；failure 是安全 `{code,message}` 或 null，不返回异常栈、消息正文或工具输出。记录按创建时间和 ID 稳定倒序；行内 usage 包含该轮完整生命周期、所有实际响应模型的用量。

## 单次模型调用与缓存率

前端“模型调用”页签使用 `tab=calls`，独立读取 `/call-records`。按响应保存时间、实际响应 Provider/Model 及工作区筛选，不把 Run 的累计用量当作一次调用。列表展示时间、会话、工作区、模型、调用类型、API 总输入 Token、缓存命中输入 Token 和缓存率；筛选或切换页签时清空分页游标。

每行结构：

```ts
interface StatisticsCallRow {
  id: string;
  createdAt: number;
  sessionId: string;
  sessionName: string;
  workspaceId: string;
  workspaceName: string;
  runId: string | null;
  providerId: string;
  modelId: string;
  kind: "assistant" | "compact" | "compact_summary";
  cache: {
    status: "reported" | "unreported" | "invalid";
    inputTokens: number | null;
    cachedTokens: number | null;
    hitRate: number | null;
  };
}
```

- `assistant` 表示一条已保存的模型响应。新压缩记录按实际摘要请求分别保存来源，`compact` 每行对应其中一次模型请求；一次压缩若调用两次模型，会显示两行，不能用两次合计计算单次缓存率。
- `compact_summary` 明确显示为“历史压缩汇总”：旧记录可能聚合多次请求，无法恢复逐次来源时保留汇总标记，`cache.status=unreported`，不将其伪装为单次请求。手动压缩的 `runId` 可以为 null。
- `reported` 仅使用可验证的模型 API 返回值：`inputTokens` 为 API 总输入，`cachedTokens` 为其中实际缓存命中的输入；两者是非负安全整数且 `cachedTokens <= inputTokens`。`hitRate = cachedTokens / inputTokens`，范围为 0–1。输出和缓存写入不算命中；缓存写入若属于 API 总输入，仍属于分母。
- API 总输入为 0 时，两个计数可显示真实 0，`hitRate` 为 null，界面说明“输入为 0”，不显示 0%。总输入大于 0 且 API 明确返回缓存命中为 0 时才显示 0%。
- API 没有返回所需字段，或历史记录缺少可验证来源时为 `unreported`；来源字段或数值无效时为 `invalid`。两类的 `inputTokens/cachedTokens/hitRate` 均为 null，界面分别显示“无可验证数据”或“数据无效”。不使用上下文估算、请求指纹、归一化默认 0、费用或其他指标补齐，也不回填旧记录猜测命中率。
- 百分比显示最多两位小数，同时保留精确 Token 分子分母。极小正值显示 `<0.01%`；接近 100% 但未全命中的值显示 `>99.99%`，避免舍入成真实 0% 或 100%。

此列表覆盖当前保留的响应与已保存摘要请求，不代表所有 HTTP 尝试：自动标题、未保存的失败或内部重试不在其范围。现有聚合 `usage.calls` 继续按顶层响应/压缩记录计数，因此不能与拆分后的请求行数直接等同。接口不返回提示词、工具参数、模型正文或凭据。

模型归属、时间、费用及删除边界详见 [统计功能路由](../ai-repo/statistics.md)。


## 厂商与模型两级筛选

统计页使用两个独立选择器：一级“厂商”，二级仅列出该厂商的“模型”。未选厂商时二级禁用；只选厂商时请求仅带 providerId，选具体模型后再带 modelId。“全部模型”只清 modelId，保留厂商；切换或清空厂商同时清模型和分页游标。

页面 URL 增加 providerId，model 仍为 JSON 编码的 [providerId,modelId]。旧链接没有独立 providerId 时从 pair 恢复；显式厂商与 pair 冲突时保留厂商并清模型。浏览器前进/后退恢复两级选择；options 加载失败或历史身份暂不在目录时仍保留原筛选。所有 Tab 共用此请求规则，REST 参数与后端统计口径不变。
