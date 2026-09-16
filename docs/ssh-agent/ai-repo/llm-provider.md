# LLM Provider 功能代码路由

适用于 `pi-ai` 内置 Provider/Model 基线、SSH Agent 远端模型快照、应用级 LLM Provider Credential、SQLite 加密适配和管理 HTTP API。Chat Run 请求显式选择 Provider、Model 和 thinking level，本领域不保存默认模型。

## 当前边界

- Provider 定义和首次启动的 Model 基线来自 `@earendil-works/pi-ai`。SSH Agent 启动时及之后每两小时只枚举 `llm_provider_credentials`，从 `pi.dev/api/models/providers/:providerId` 拉取这些厂商的已校验目录。
- 一次成功响应会精确替换该 Provider 的 SQLite 快照：同 ID 覆盖、新 ID 新增、远端缺失 ID 删除。成功空数组会清空目录；网络、HTTP、解析或校验失败保留最后一次成功快照。
- 读取模型时优先使用 SQLite 快照；没有快照时使用 `pi-ai` 基线。模型列表与 Chat Run 使用同一个有效目录，避免列表可见但运行选择来源不同。
- 上游明确返回当前所选模型的 `ModelError` 且消息为 `Model <id> is not supported` 时，Chat Runtime 不再次拉取，而是从有效目录和 SQLite 快照中直接删除该模型，并返回稳定错误 `chat_model_not_supported`。删除会保留目录 ETag，远端目录未变化时的 `304` 不会重新加入该模型；远端目录版本变化后才重新精确替换。不维护 unavailable/deprecated 等中间状态。
- Provider 目录返回 `pi-ai` 声明的厂商名称和默认 `baseUrl`；没有固定地址时 `baseUrl` 为 `null`，它不代表运行期最终解析出的有效地址。
- 每个 `providerId` 最多保存一个应用级 Credential。当前 HTTP 只允许写入 `api_key`，OAuth 类型由底层 Store 支持但尚未开放多阶段登录 API。
- API Key 和 Provider 环境认证值只写；读接口只返回类型、revision 和时间。
- `SqliteLlmProviderCredentialStore` 实现 `pi-ai` 的 `CredentialStore`，OAuth 自动刷新未来可沿用同一个串行 `modify` 契约。
- Credential 使用 revision 做乐观并发控制；创建不传 `expectedRevision`，替换必须传当前 revision，删除通过查询参数传 revision。
- Provider 目录响应会调用 `pi-ai` 的 `checkAuth()`，因此 `configured` 同时反映 SQLite Credential 和环境/ambient auth。
- Model 目录使用 `pi-ai` 的 `getSupportedThinkingLevels()` 返回每个模型准确支持的思考强度；`reasoning` 不能替代该列表。
- Chat 图片输入依据 Model 目录的 `input` 能力判断；只有 `model.input` 包含 `image` 才能接收新图片或继续包含图片引用的有效历史。Provider Adapter 仍由 `pi-ai` 负责把标准 `ImageContent` 转换为厂商协议。
- 自定义 Provider 以完整聚合写入 SQLite，并在启动、创建和更新后通过 `MutableModels` 注册到同一运行时目录。支持 OpenAI Completions、OpenAI Responses、Anthropic Messages、Google Generative AI 四种标准协议，以及 API Key/无认证两种认证模式。
- 创建 API Key 自定义 Provider 时可同时提交只写 Credential；Provider、Credential 元数据和加密 Secret 由 Application Service 使用共享 transaction runner 原子写入，失败不会留下未配置 Provider。Credential Store 的管理写方法只参与调用方事务，`pi-ai` 直接调用的 `CredentialStore.modify/delete` 仍自行串行化。后续密钥补充和轮换仍使用独立 Credential API。
- 自定义 Provider ID 必须使用 `custom-` 前缀且不可修改；模型数组更新采用精确替换。Provider 更新和删除受 revision 乐观锁保护，存在 active Chat Run 时返回 `llm_provider_in_use`。
- 自定义 Provider 的创建规则集中在独立 factory；SQLite mapper 将行、`compat_json` 和 `models_json` 作为不可信数据完整校验，再构造领域对象。损坏的持久化聚合不会进入运行时 Model Catalog。
- 自定义 Provider 使用用户维护的静态模型目录，不参与 `pi.dev` 启动或两小时刷新。删除 Provider 会同步清除 Credential、Secret 和遗留目录快照；API Key 切换为无认证时也会原子清除 Credential。
- OAuth HTTP 流程不属于当前实现。
- Provider 管理和模型选择异常在 HTTP/Chat SSE 出口通过稳定 code 本地化；Provider/Model 名称与 ID、上游响应和模型输出不翻译，底层 Provider 异常不得直接返回浏览器。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 领域 DTO 和写入输入 | [llm-provider.ts](../../../packages/ssh-agent/src/domain/llm-provider.ts) |
| pi-ai CredentialStore 扩展端口 | [llm-provider-credential-store.ts](../../../packages/ssh-agent/src/application/repositories/llm-provider-credential-store.ts) |
| 模型快照持久化端口 | [llm-model-catalog-repository.ts](../../../packages/ssh-agent/src/application/repositories/llm-model-catalog-repository.ts) |
| 精确替换目录与远端响应校验 | [llm-model-catalog.ts](../../../packages/ssh-agent/src/application/services/llm-model-catalog.ts) |
| 两小时定时刷新 | [llm-model-refresh-scheduler.ts](../../../packages/ssh-agent/src/application/services/llm-model-refresh-scheduler.ts) |
| Provider、Model 和 Credential 用例 | [llm-provider-service.ts](../../../packages/ssh-agent/src/application/services/llm-provider-service.ts) |
| 自定义 Provider 聚合构造、用例和 Pi 运行时适配 | [custom-llm-provider-factory.ts](../../../packages/ssh-agent/src/application/custom-llm-provider-factory.ts)、[custom-llm-provider-service.ts](../../../packages/ssh-agent/src/application/services/custom-llm-provider-service.ts)、[custom-llm-provider-runtime.ts](../../../packages/ssh-agent/src/application/services/custom-llm-provider-runtime.ts) |
| HTTP 路由与校验 | [http-handler.ts](../../../packages/ssh-agent/src/api/http-handler.ts)、[request-validation.ts](../../../packages/ssh-agent/src/api/request-validation.ts) |
| Secret 加密 | [llm-provider-credential-cipher.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/llm-provider-credential-cipher.ts) |
| SQLite Store | [sqlite-llm-provider-credential-store.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-llm-provider-credential-store.ts) |
| SQLite 模型快照 | [sqlite-llm-model-catalog-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-llm-model-catalog-repository.ts) |
| SQLite 自定义 Provider Repository 和持久化边界校验 | [sqlite-custom-llm-provider-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-custom-llm-provider-repository.ts)、[custom-llm-provider-row.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/custom-llm-provider-row.ts) |
| pi-ai 目录装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts)、[main.ts](../../../packages/ssh-agent/src/server/main.ts) |
| 回归测试 | [llm-provider-api.test.ts](../../../packages/ssh-agent/test/llm-provider-api.test.ts)、[llm-model-catalog.test.ts](../../../packages/ssh-agent/test/llm-model-catalog.test.ts)、[custom-llm-provider-api.test.ts](../../../packages/ssh-agent/test/custom-llm-provider-api.test.ts) |

扩展认证方式时优先遵守 `pi-ai` 的 `CredentialStore` 和 Provider auth 契约。不要让 SSH Agent 依赖 `coding-agent` 的 `auth.json`、`models.json`、`ModelRuntime` 或设置目录。
