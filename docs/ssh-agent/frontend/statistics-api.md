# 使用统计 HTTP 契约

所有接口位于 `/api/statistics/`，只接受 GET，成功返回 `Cache-Control: no-store`。沿用通用 REST Locale 和公开异常边界；不新增 SSE。

## 查询参数

| 参数 | 语义 |
|---|---|
| `from` / `to` | 毫秒时间戳，左闭右开，`from < to`；缺省最近 30 个自然日截至当前时刻，0 表示全部历史起点。范围限制在 1970–2101。 |
| `timeZone` | 合法 IANA 时区，缺省 Asia/Shanghai；前端发送浏览器时区。 |
| `workspaceId` | 可选，精确匹配工作区。 |
| `providerId` / `modelId` | 可选，精确匹配保存的历史标识；提交 modelId 时必须同时提交 providerId。 |
| `year` | 概览活动日历年份，1970–2100，缺省当前年；不受 from/to 限制。 |
| `sort` / `direction` | 模型与工作区表支持 tokens/cost/calls，工作区另支持 runs；方向 asc/desc，缺省 desc。 |
| `status` | 运行记录可选 pending/running/completed/failed/cancelled。 |
| `limit` / `cursor` | 运行记录分页，缺省 25、最大 100；cursor 是上一响应给出的不透明字符串。 |

日期、数值、时区、状态和游标非法返回既有 `400 validation_error`，携带 field。不存在的工作区/历史模型筛选返回空统计，不触发业务查询或供应商请求。

## 接口

| GET 路径 | 响应 |
|---|---|
| `/options` | `{ workspaces: [{id,name,hostname}], models: [{providerId,modelId}], earliestAt: number \| null }`；来自现有工作区、响应/压缩及 Run 记录。 |
| `/overview` | `{ generatedAt, range, usage, runs, trend, calendar }`。 |
| `/models` | `{ generatedAt, range, rows: [{providerId,modelId,usage}] }`。 |
| `/runs` | `{ generatedAt, range, summary }`；状态筛选只作用于下方记录列表，不改变本摘要。 |
| `/run-records` | `{ generatedAt, range, rows, nextCursor: string \| null }`。 |
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

模型归属、时间、费用及删除边界详见 [统计功能路由](../ai-repo/statistics.md)。
