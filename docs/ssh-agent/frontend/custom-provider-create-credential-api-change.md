# 创建自定义 LLM Provider 时保存 API Key

## 接口变更

`POST /api/llm/custom-providers` 新增可选、只写字段 `credential`。前端可以在创建自定义 Provider 时同步提交 API Key，不需要用户配置服务端环境变量。

```json
{
  "id": "custom-example",
  "name": "Example",
  "baseUrl": "https://api.example.com/v1",
  "api": "openai-completions",
  "authMode": "api_key",
  "credential": {
    "type": "api_key",
    "apiKey": "sk-example"
  },
  "compat": {},
  "models": [
    {
      "id": "example-model",
      "name": "Example Model",
      "api": "openai-completions",
      "reasoning": false,
      "input": ["text"],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  ]
}
```

新增字段类型：

```ts
interface CreateCustomLlmProviderCredential {
  type: "api_key";
  apiKey: string;
}

interface CreateCustomLlmProviderRequest {
  // 原有字段保持不变
  credential?: CreateCustomLlmProviderCredential;
}
```

## 字段规则

- `credential` 仅用于创建接口，不属于 Provider 更新接口的字段。
- `credential` 仅允许在 `authMode` 为 `api_key` 时提交。
- `credential.apiKey` 去除首尾空白后必须非空，最大长度为 65536 个字符。
- `credential` 可省略。省略时仍可创建 Provider，但该 Provider 暂时处于未配置 Credential 的状态。
- `authMode` 为 `none` 时提交 `credential`，返回 `400 validation_error`：

```json
{
  "error": {
    "code": "validation_error",
    "message": "credential is not valid when authMode is none",
    "field": "credential"
  }
}
```

## 成功响应

状态码为 `201`，响应体仍为原有 `CustomLlmProvider`。响应中不会返回 `credential` 或 API Key：

```json
{
  "id": "custom-example",
  "name": "Example",
  "baseUrl": "https://api.example.com/v1",
  "api": "openai-completions",
  "authMode": "api_key",
  "compat": {},
  "models": [
    {
      "id": "example-model",
      "name": "Example Model",
      "api": "openai-completions",
      "reasoning": false,
      "input": ["text"],
      "cost": {
        "input": 0,
        "output": 0,
        "cacheRead": 0,
        "cacheWrite": 0
      },
      "contextWindow": 128000,
      "maxTokens": 8192
    }
  ],
  "revision": 1,
  "createdAt": "2026-09-02T00:00:00.000Z",
  "updatedAt": "2026-09-02T00:00:00.000Z"
}
```

前端不能依赖创建响应回显 API Key。创建成功后，可通过 `GET /api/llm/providers` 中对应 Provider 的 `configured` 和 `credential` 元数据确认配置状态。

## 原子性

Provider、Credential 元数据和加密后的 Secret 在同一个数据库事务中写入。API Key 加密或保存失败时，整个创建请求失败，不会留下已创建但未配置的 Provider。

失败响应沿用现有错误结构。例如 Secret 保存失败时返回：

```json
{
  "error": {
    "code": "secret_store_failed",
    "message": "LLM Provider Credential could not be stored"
  }
}
```

## 后续补充或轮换 API Key

已有 Provider 的 API Key 仍使用原接口保存或轮换：

`PUT /api/llm/providers/:providerId/credential`

```json
{
  "type": "api_key",
  "apiKey": "sk-new-value",
  "expectedRevision": 1
}
```

本次没有改变该接口，也没有改变 Provider 更新接口。
