# LLM 模型目录刷新前端接口说明

> 本次是后端模型厂商目录管理优化，不要求修改前端源码。本文只用于确认现有接口兼容性。

## 1. 结论

前端无需改动。没有新增刷新接口，也没有修改 Provider、Model、Chat Run 或 SSE DTO。前端继续使用：

```http
GET /api/llm/providers
GET /api/llm/providers/:providerId/models
POST /api/sessions/:sessionId/chat/runs
GET /api/sessions/:sessionId/chat/runs/:runId/events
```

## 2. 模型列表的新语义

后端启动时以及之后每两小时，只刷新 `llm_provider_credentials` 中存在 Credential 的 Provider。不存在用户或前端主动触发的刷新接口。前端不需要启动定时器，也不需要直接访问厂商或 `pi.dev`。

一次远端成功响应会精确替换 Provider 的模型列表：

- 相同 `modelId`：使用最新定义覆盖。
- 新 `modelId`：新增。
- 远端不再返回的 `modelId`：删除。
- 成功返回空数组：模型列表变为空。
- 网络失败、非成功 HTTP、JSON 或模型字段校验失败：继续返回最后一次成功列表。

`GET /api/llm/providers` 的 `modelCount` 与 `GET /api/llm/providers/:providerId/models` 使用同一份有效快照。后端没有 `unavailable`、`deprecated` 等中间状态，前端也不需要增加对应字段或分支。

## 3. 模型运行时下架

如果厂商在 Chat Run 中明确返回：

```json
{
  "type": "ModelError",
  "message": "Model <当前 modelId> is not supported"
}
```

后端会立即完成三件事：

1. 从该 Provider 的有效模型目录删除当前模型并持久化。
2. 将最终 assistant 消息的 `errorMessage` 改为：`当前模型已不可用，已从模型列表中移除，请重新选择模型。`
3. 通过现有 `run.updated` SSE 发送失败 Run：

```json
{
  "status": "failed",
  "failure": {
    "code": "chat_model_not_supported",
    "message": "当前模型已不可用，已从模型列表中移除，请重新选择模型。",
    "retryable": false
  }
}
```

后端保留该目录的 ETag。后续定时刷新若远端目录未变化，`304` 不会把已删除模型加回来；只有远端发布新目录版本时才重新应用完整目录。

这不是可重试错误。现有前端可以继续按通用 Run 失败逻辑展示 `failure.message`，不需要识别新的业务分支。

如果未来希望增强体验，可以选择在收到 `chat_model_not_supported` 后：

- 展示 `failure.message`。
- 重新请求 `GET /api/llm/providers/:providerId/models`。
- 清除已删除模型的当前选择，要求用户重新选择。
- 不自动重试原 Chat Run。

如果旧选择之后再次创建 Run，后端返回：

```http
404
```

```json
{
  "error": {
    "code": "chat_model_not_found",
    "message": "当前模型不可用，请重新选择模型"
  }
}
```

现有通用 HTTP 错误处理可以直接兼容。自动刷新模型列表并清除旧选择属于可选体验增强，不是本次后端改动的前置要求。

## 4. 兼容性确认

- 不需要新增刷新按钮或刷新 API 调用。
- 不需要新增模型可用性中间状态。
- 不需要修改 Provider、Model、Chat Run 或 SSE 类型。
- 不需要为 `chat_model_not_supported` 增加专用处理；现有通用错误展示继续有效。
- 后端模型列表在下一次现有查询时自然反映最新快照。
