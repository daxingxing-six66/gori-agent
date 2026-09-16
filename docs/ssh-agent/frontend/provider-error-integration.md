# 模型请求错误联调

本次仅改变新错误的展示文案，不改变响应解析结构、HTTP 状态映射、业务 code 或 SSE event type。无需新增前端错误类型分支。

## 读取位置

| 出口 | 字段 |
|---|---|
| HTTP 错误（包括手动压缩） | `error.message` |
| `run.updated`、Run 查询 | `failure.message` |
| Assistant 历史消息及 Chat SSE 内嵌消息 | `errorMessage` |
| `compaction.failed` | `message` |

示例：

```json
{
  "error": {
    "code": "chat_context_compaction_failed",
    "message": "上下文压缩失败：Country, region, or territory not supported (HTTP 403)",
    "retryable": false
  }
}
```

HTTP 仍返回压缩业务原有的 `502`，示例中的 `403` 是模型服务状态，不代表用户访问 SSH Agent 被拒绝。不要从 message 中解析状态码或参数。

普通聊天示例：`模型请求失败：max_tokens must be at most 8192 (HTTP 400)`。余额、地区、参数等说明保留厂商原语言，只有场景前缀跟随 Locale。被下架的模型继续从目录移除，提示同时包含厂商原因和重新选择模型的说明。

## 行为约定

- REST 使用 `Accept-Language`，EventSource 使用 `locale`；默认中文。刷新及同进程 SSE 重放复用已保存的安全描述，语言可重新选择。
- 展示为普通文本，不将厂商文案作为 HTML 执行。正常 LLM 输出与 Thinking 不受本次调整影响。
- 原因最长 2,000 字符（不含场景前缀及 HTTP 状态后缀），已清理控制字符、常见凭证和认证 URL。无法可靠识别或安全提取时仍显示通用提示，详细错误查看后端本地日志。
- `retryable=false` 用于参数、认证、权限、地区、余额/额度耗尽及未知错误；临时限流、网络故障和 5xx 通常为 true。额度耗尽优先于 429 判断。该字段不代表后端新增自动重试。
- 原有上下文超限恢复成功时，中间错误不进入失败时间线；恢复后再次失败显示最终错误。已输出的内容不会回滚。
- 不增加数据库字段；仅实现后的新错误携带安全描述。历史记录不迁移，不从旧错误字符串反向解析厂商原因。
- 不公开 `providerFailure`、消息描述符、diagnostics、请求 Header 或异常栈。
