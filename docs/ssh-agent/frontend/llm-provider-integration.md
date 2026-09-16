# LLM Provider 前端联调文档

> 状态：MVP v1
>
> Server origin：`http://127.0.0.1:3001`
>
> API base URL：`http://127.0.0.1:3001/api`

## 1. 业务背景与前端流程

SSH Agent 直接使用 `pi-ai` 提供的内置 Provider 和 Model 目录，不把这些只读数据复制到 SQLite。目录会随着 `pi-ai` 升级变化，前端不能硬编码 Provider ID、Model ID、名称或数量。

`LlmProviderCredential` 是应用级资源，不属于 Workspace。每个 `providerId` 最多保存一个 Credential，所有 Workspace 和聊天会话共享这份 Provider 认证配置。模型由用户在聊天输入框右下角选择，本批次不保存默认模型，也不提供模型选择写接口。

推荐流程：

```text
打开模型选择器
  ├─ GET /api/llm/providers
  ├─ 按 Provider 请求 /models
  └─ 只允许选择 configured = true 的 Provider 模型

配置 API Key
  ├─ PUT Provider credential（Secret 只写）
  ├─ 重新 GET /api/llm/providers
  └─ configured = true 后允许选择模型
```

安全约束：

- `apiKey` 和 `environment` 中的值只写，不能进入日志、持久化前端状态、错误追踪或 analytics。
- 后端响应绝不返回 API Key、OAuth Token 或环境认证值。
- 创建 Credential 时不传 `expectedRevision`；替换时必须携带最后读取到的 revision。
- OAuth 能力会显示在 Provider 的 `auth.oauth` 中，但当前没有 OAuth HTTP 登录流程，前端不能手工提交 access/refresh token。
- Provider 的 `configured` 也可能来自后端进程环境或云平台 ambient credentials；此时 `credential` 可以为 `null`。

## 2. 接口定义、请求体与响应体

通用约定：JSON 使用 `camelCase`，时间为 Unix epoch milliseconds，所有响应包含 `Cache-Control: no-store`。revision 冲突返回 `409 revision_conflict`。

### 2.1 DTO

```ts
interface LlmProviderCredential {
  providerId: string;
  type: "api_key" | "oauth";
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface LlmProvider {
  id: string;
  name: string;
  custom: boolean;
  baseUrl: string | null;
  auth: {
    apiKey: boolean;
    oauth: boolean;
  };
  configured: boolean;
  credential: LlmProviderCredential | null;
  modelCount: number;
}

interface LlmModel {
  id: string;
  providerId: string;
  name: string;
  api: string;
  reasoning: boolean;
  supportedThinkingLevels: Array<"off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max">;
  input: Array<"text" | "image">;
  contextWindow: number;
  maxTokens: number;
}
```

`baseUrl` 是 `pi-ai` Provider 声明的默认基础地址；依赖区域、账户或运行期配置的 Provider 返回 `null`。它不保证等于认证或请求阶段最终解析出的有效地址。`configured` 表示后端当前可以解析出完整认证信息；`credential !== null` 只表示 SQLite 中保存了 Credential，两者不能互相替代。

### 2.2 获取 Provider 列表

```http
GET /api/llm/providers
```

请求体：无。成功返回 `200`：

```json
{
  "providers": [
    {
      "id": "anthropic",
      "name": "Anthropic",
      "custom": false,
      "baseUrl": "https://api.anthropic.com",
      "auth": { "apiKey": true, "oauth": true },
      "configured": true,
      "credential": {
        "providerId": "anthropic",
        "type": "api_key",
        "revision": 1,
        "createdAt": 1787539200000,
        "updatedAt": 1787539200000
      },
      "modelCount": 12
    }
  ]
}
```

Provider 按 `name, id` 排序。

`custom` 为 `true` 时表示该 Provider 由 SSH Agent 自定义 Provider API 管理；内置 Provider 为 `false`。

### 2.3 自定义 Provider DTO

```ts
type CustomProviderApi =
  | "openai-completions"
  | "openai-responses"
  | "anthropic-messages"
  | "google-generative-ai";

interface CustomLlmModel {
  id: string;
  name: string;
  reasoning: boolean;
  input: Array<"text" | "image">;
  cost: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow: number;
  maxTokens: number;
}

interface CustomLlmProvider {
  id: string;
  name: string;
  baseUrl: string;
  api: CustomProviderApi;
  authMode: "api_key" | "none";
  compat: Record<string, boolean | "max_tokens" | "max_completion_tokens">;
  models: CustomLlmModel[];
  revision: number;
  createdAt: number;
  updatedAt: number;
}

interface CreateCustomLlmProviderCredential {
  type: "api_key";
  apiKey: string; // 只写
}
```

### 2.4 自定义 Provider CRUD

```http
GET    /api/llm/custom-providers
POST   /api/llm/custom-providers
GET    /api/llm/custom-providers/:providerId
PUT    /api/llm/custom-providers/:providerId
DELETE /api/llm/custom-providers/:providerId?expectedRevision=N
```

列表成功返回 `{ "providers": CustomLlmProvider[] }`。创建成功返回 `201 CustomLlmProvider`；读取和更新返回 `200 CustomLlmProvider`；删除返回 `204`。

创建示例：

```json
{
  "id": "custom-local-llm",
  "name": "Local LLM",
  "baseUrl": "http://127.0.0.1:11434/v1",
  "api": "openai-completions",
  "authMode": "api_key",
  "credential": {
    "type": "api_key",
    "apiKey": "write-only"
  },
  "compat": { "supportsDeveloperRole": false },
  "models": [
    {
      "id": "local-model",
      "name": "Local Model",
      "contextWindow": 32768,
      "maxTokens": 8192
    }
  ]
}
```

`credential` 只允许出现在创建请求中，并且是可选字段。提交后，Provider、Credential 元数据和加密 Secret 在同一个事务中创建；任一写入失败时不会留下未配置的 Provider。成功响应仍为 `CustomLlmProvider`，不会返回 `credential.apiKey` 或其他 Secret。

更新请求不包含 `id`，必须携带完整 Provider 配置、完整 `models` 数组和 `expectedRevision`。模型数组采用精确替换，空数组表示删除该 Provider 的全部模型。

模型默认值：`reasoning=false`、`input=["text"]`、四项 cost 均为 `0`。`id` 必须以 `custom-` 开头且创建后不可修改；`baseUrl` 只接受 HTTP/HTTPS，不会在保存时发起探测请求。

兼容参数按协议限制：

- `openai-completions`：`supportsDeveloperRole`、`supportsReasoningEffort`、`supportsUsageInStreaming`、`maxTokensField`
- `openai-responses`：`supportsDeveloperRole`、`supportsStrictMode`
- `anthropic-messages`：`supportsTemperature`、`supportsStrictTools`、`forceAdaptiveThinking`
- `google-generative-ai`：不接受兼容参数

`authMode=api_key` 时，创建表单可以直接提交 `credential`；不提交时 Provider 仍可创建，但通用 Provider 列表返回 `configured=false`，之后使用现有 Credential API 补充或轮换密钥。`authMode=none` 时禁止提交 `credential`，否则返回 `400 validation_error`，成功创建后返回 `auth.apiKey=false`、`configured=true`。从 `api_key` 更新为 `none` 会删除原 Credential。

Provider 正被 Chat Run 使用时不能更新或删除，返回 `409 llm_provider_in_use`。ID 冲突返回 `409 llm_provider_conflict`，revision 过期返回 `409 revision_conflict`。

### 2.5 获取 Provider 的模型

```http
GET /api/llm/providers/:providerId/models
```

请求体：无。成功返回 `200`：

```json
{
  "providerId": "anthropic",
  "models": [
    {
      "id": "claude-sonnet-4-6",
      "providerId": "anthropic",
      "name": "Claude Sonnet 4.6",
      "api": "anthropic-messages",
      "reasoning": true,
      "supportedThinkingLevels": ["off", "minimal", "low", "medium", "high"],
      "input": ["text", "image"],
      "contextWindow": 200000,
      "maxTokens": 64000
    }
  ]
}
```

Model 按 `name, id` 排序。`supportedThinkingLevels` 由 `pi-ai` 的 `getSupportedThinkingLevels(model)` 生成，是 Chat Run 可提交强度的唯一事实来源；非推理模型只返回 `["off"]`，`xhigh` 和 `max` 只有模型显式支持时才会出现。前端不能只根据 `reasoning` 推断可选强度。未知 Provider 返回 `404 not_found`。模型目录为空是合法状态，动态 Provider 可能尚未刷新目录。

### 2.6 获取所有已保存 Credential

```http
GET /api/llm/provider-credentials
```

成功返回 `200`：

```json
{
  "credentials": [
    {
      "providerId": "anthropic",
      "type": "api_key",
      "revision": 1,
      "createdAt": 1787539200000,
      "updatedAt": 1787539200000
    }
  ]
}
```

### 2.7 获取单个 Credential

```http
GET /api/llm/providers/:providerId/credential
```

成功返回 `200 LlmProviderCredential`；未保存时返回 `404 not_found`。响应不包含 Secret。

### 2.8 创建或替换 API Key Credential

```http
PUT /api/llm/providers/:providerId/credential
Content-Type: application/json
```

首次创建：

```json
{
  "type": "api_key",
  "apiKey": "write-only"
}
```

部分 Provider 需要额外的认证环境值，可以提交：

```json
{
  "type": "api_key",
  "apiKey": "write-only",
  "environment": {
    "CLOUDFLARE_ACCOUNT_ID": "write-only",
    "CLOUDFLARE_GATEWAY_ID": "write-only"
  }
}
```

替换已有 Credential：

```json
{
  "type": "api_key",
  "apiKey": "new-write-only-key",
  "expectedRevision": 1
}
```

`apiKey` 和 `environment` 至少提供一个。成功返回 `200 LlmProviderCredential`。已有资源不传 revision 或 revision 过期时返回 `409 revision_conflict`；未知 Provider 返回 `404 not_found`；当前 HTTP 不接受 `type: "oauth"`。

### 2.9 删除 Credential

```http
DELETE /api/llm/providers/:providerId/credential?expectedRevision=2
```

成功返回 `204`，Secret 同步级联删除。不存在返回 `404 not_found`，revision 过期返回 `409 revision_conflict`。

### 2.10 错误处理

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "LLM Provider Credential was modified by another request",
    "field": "expectedRevision"
  }
}
```

| HTTP | code | 前端处理 |
|---|---|---|
| 400 | `validation_error` | 定位字段并提示，不自动重试 |
| 404 | `not_found` | 刷新 Provider 或 Credential 状态 |
| 409 | `revision_conflict` | 重新读取 Credential，要求用户再次确认覆盖或删除 |
| 409 | `llm_provider_conflict` | 刷新 Provider 列表并更换自定义 Provider ID |
| 409 | `llm_provider_in_use` | 等待当前 Chat Run 完成后重试更新或删除 |
| 500 | `secret_store_failed` | 展示通用保存失败；不得记录原始请求体 |
