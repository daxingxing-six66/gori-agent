# ChatGPT 订阅 Provider

适用于 `openai-chatgpt` 的 Sign in with ChatGPT 登录、动态注册、本机回调、加密凭据、token 刷新、账号模型发现和 Responses 请求适配。

## 当前边界

- Server 默认启用；直接调用 Backend 工厂时通过 `chatgpt` 选项装配。普通 OpenAI API Key 和原有 `openai-codex` 保持各自认证和端点，不导入 Codex 凭据。
- 一个 Provider 保存一个当前账号，所有 Workspace 共用。支持重新登录、使用其他账号和确认断开；新授权验证通过之前保留旧连接。当前不提供多个已保存账号的选择器。
- 初次发送 `client_id=dynamic_agent_client`、`agent_name_hint=Gori` 和稳定 host ID。回调 issued client ID 在换 token 前保存；重试和重新登录复用它，显式使用其他账号开始新注册。
- 安装 host/client/subject 映射保存在数据库目录旁的 `chatgpt-registration.json`，原子替换、Unix 权限 `0600`，没有 token。完整凭据复用 LLM Credential 加密表，不增加 migration。断开保留注册映射。
- 仅在 `127.0.0.1` 随机空闲端口监听 `/auth/callback`，授权与交换使用相同 URI。每次生成独立 state、nonce、PKCE verifier，校验 Host、路径、state 和 client ID，回调只消费一次。浏览器需与后端在同一台电脑；当前未实现远程 VM 凭据转移。
- 成功回调使用独立的静态 HTML 状态卡片，沿用 Gori 浅色与绿色视觉，提供中英文授权确认和返回 Gori 查看连接结果的提示，窄屏自适应；不将收到授权等同于后续凭据写入或模型发现均成功。页面不包含账号、token 或回调参数，不请求外部资源、不运行脚本、不自动跳转或关闭；内联样式通过 CSP SHA-256 精确允许，继续 no-store/no-referrer。失败仍返回原有纯文本安全诊断与 400 状态。
- ID token 校验 RS256/JWKS 签名、issuer、audience、有效期、iat/nbf、nonce 和原注册 subject。仅取得 `chatgpt.tokens.use.direct` 与 `resource.invoke` 后保存可用连接。token 不返回浏览器、不进入 URL、日志或前端存储，授权 URL 不含 id_token_hint。
- 整次授权默认 10 分钟；首次换 token 与身份网络请求各 30 秒；pi-ai 自动刷新与会话撤销各 15 秒；模型发现 20 秒。底层连接可更早失败。回调页、状态 API 和日志仅展示白名单阶段、原因、HTTP 状态和传输错误码，不把所有失败合并为超时，不公开上游响应正文。
- 刷新复用 pi-ai 的串行 CredentialStore.modify 并保存 rotating refresh token。断开在同一互斥边界先撤销会话再删除本地凭据；撤销失败保留连接供重试。通用 Credential DELETE 拒绝该 Provider。活动 ChatGPT Run 阻止换账号或断开，授权返回后写入前再复检。
- 模型使用同一 OAuth token 请求 `https://api.openai.com/v1/models`，只展示 `visibility=list`，保留服务端顺序，以 slug 调用。不经过 pi.dev，不写通用 SQLite 目录快照。同账号刷新失败保留最后成功目录；换账号先清空目录，禁止恢复旧账号的 pi-ai 内存快照。通过账号列表校验后，仅对可见的精确 ID 尝试从官方模型 Markdown 读取能力，不从公开说明新增账号模型。
- 能力优先使用本次官方说明或最近成功的公开能力快照，其次使用 OpenAI 基线、已有四模型的离线配置，最后才是 32768 本地上下文预算、4096 输出估算、纯文本和无已知思考档位的保守配置。模型上的订阅专属 `chatGptCapabilities` 标记 official-docs/baseline/bundled/fallback、抓取时间、陈旧状态与来源 URL；该元数据不进入推理请求，当前通用模型 HTTP DTO/前端不展示它。保守配置不声称为模型真实规格，未知档位不代表模型实际不能思考。订阅 cost 为零，表示不套用 API 单价；套餐/credits 账单以 ChatGPT 为准。
- 固定调用公开 `https://api.openai.com/v1/responses`。末端白名单过滤参数，强制 store=false/stream=true，发送完整 input，移除 max_output_tokens、temperature、previous_response_id 等字段。复用真实 SSE 解析器，流失败或缺少终态不能当作成功。
- 仅在此 Provider 的请求副本中把 system 转为同位置 developer；不改历史、头部或其他 Provider 的角色。函数/custom 工具放入 gori namespace，历史调用携带相同 namespace。工具仍由 Gori 按原 Guard、审批、沙盒规则执行，不启用 hosted MCP/tool_search 等托管工具。
- Provider 声明支持 `strict` 参数，使普通函数工具明确发送 `strict: false`，避免 Responses 在省略该字段时尝试将 schema 规范化为严格模式。该能力声明不默认启用严格采样；`terminal_interaction` 的 `input`、`key` 仍为可选字段，按 action 执行的互斥校验保持有效。规则依据：[官方函数工具 strict 模式说明](https://developers.openai.com/api/docs/guides/function-calling#strict-mode)。
- 套餐额度耗尽/不可用错误显示本地化用量管理提示。设置页分为“账号与密钥”和“自定义服务”两个页签：前者显示 ChatGPT 连接和内置 API Key，后者的服务行直接提供该服务密钥管理，避免重复显示。ChatGPT 使用紧凑独立卡片，不进入 API Key 表单；已连接时常显账号、套餐状态、查看模型、刷新模型和管理用量，重新登录、换账号及断开收进更多操作，断开仍二次确认。查看和刷新进入共用模型详情页，读取仅 GET，显式刷新使用统一 Provider 模型 POST；详情不显示 token，失败保留当前账号最后成功目录。可重新打开授权标签和取消等待；授权/写入/异步表单导航时禁止切页签，避免卸载取消在途授权。后端重启产生的 404 结束旧等待，授权成功但模型发现失败单独提示刷新。

## 模型能力与思考强度

动态获取和解析全部位于 `infrastructure/chatgpt/`：`chatgpt-model-capabilities.ts` 在已有启动、两小时与手动订阅模型刷新时请求 `https://developers.openai.com/api/docs/models/<精确ID>.md`，不在推理调用时请求说明；`chatgpt-model-metadata.ts` 只解析明确的 Model ID/列出的 Snapshot、窗口、输出上限、输入类型及 `reasoning.effort` 完整列表。支持 none 到 off 的映射，所有未列出的档位显式禁用，不按 GPT 前缀推断规格。只有数值、身份和完整档位通过校验才接纳；新模型和窗口变化通过数据刷新生效，无须新增模型名分支。

官方 Markdown 是公开文档格式，并非稳定的能力发现 API；格式变化、缺字段、未知档位、非法值和网络失败均不采纳新配置，保留旧快照并标记 stale，未有快照时回退本地能力。每次最多获取 128 个符合模型 ID URL 规则的说明，4 路并发，单说明 3 秒、整体 8 秒、正文最多 256 KiB，拒绝重定向；共享进程缓存最多 256 个精确 ID，只含公开能力。OAuth 只发送到账号模型接口，官方说明使用独立无认证请求。调用取消和旧刷新不能写入迟到结果。缓存可跨账号 Provider 重建复用，但从不恢复旧账号的可见模型列表；进程重启后重新获取，不增加磁盘文件、SQLite 表或通用目录职责。

已有四个精确 slug 的 1,050,000 Token 上下文窗口、128,000 Token 最大输出、文本/图片和下表档位仅作为缺少动态能力及基线时的离线配置。上下文窗口同时用于用量显示和自动压缩阈值计算。订阅请求仍按端点限制移除 `max_output_tokens`，输出元数据不意味着请求发送该参数。Session/Run 不持久化窗口规格；新建 Run 会从当前模型目录读取能力，已运行的 Run 保留开始时取得的模型对象。

| 缺少基线时补齐的 slug | Gori 可选档位 |
|---|---|
| `gpt-6.1-sol`、`gpt-6-astra` | low / medium / high / xhigh / max |
| `gpt-6-sol`、`gpt-6-luna` | off / low / medium / high / xhigh / max |

离线配置中 `off` 对应请求 `reasoning.effort=none`；四者均不提供 minimal。动态能力可以更新这些值。前端和 Run 校验仍读取 `getSupportedThinkingLevels()` 的结果，不根据名称猜测；切换到不支持 off 的模型时沿用现有回退规则选择首个可用档位，已选且仍支持的强度保留。请求适配保留所选 `reasoning.effort`，不强制提升为 high/max，也不修改其他 Provider 或全局默认值。精确 slug 离线配置优先级低于动态快照和完整基线，不把任意 GPT-6 前缀识别成已知模型。

能力与档位依据于 2026-10-20 核对的官方模型页：[GPT-6.1 Sol](https://developers.openai.com/api/docs/models/gpt-6.1-sol)、[GPT-6 Astra](https://developers.openai.com/api/docs/models/gpt-6-astra)、[GPT-6 Sol](https://developers.openai.com/api/docs/models/gpt-6-sol)、[GPT-6 Luna](https://developers.openai.com/api/docs/models/gpt-6-luna)。API 档位与 Codex 产品设置分别维护。

## HTTP

CLI 在创建 Backend 前通过 `server/environment-proxy.ts` 安装 undici 环境代理，让原生 fetch 和使用它的 SDK 采用同一路由，覆盖 token/JWKS/撤销、模型发现和 Responses。读取 `HTTP_PROXY`、`HTTPS_PROXY`、`NO_PROXY`，小写变量优先；仅有 HTTP_PROXY 时 HTTPS 复用它。始终绕过 localhost、127.0.0.1、[::1]，保留自定义 NO_PROXY 和 `*`。支持 HTTP/HTTPS 代理 URL，不将 SOCKS ALL_PROXY 用于 fetch；无配置时不替换 dispatcher。关闭时恢复原 dispatcher 并关闭代理连接，不记录可能带密码的代理 URL。

例如在启动 Gori 的同一个终端先执行 `proxy_on`（本机函数导出 HTTP/HTTPS 变量），再启动后端；已有进程不会获得之后导出的变量。项目不读取用户 Shell 配置，也不自动加载 `.env`。使用编译产物启动时需先构建更新。直接调用 Backend 工厂的宿主自行管理全局网络路由。

| API | 用途 |
|---|---|
| `GET /api/llm/chatgpt` | 连接、账号、套餐权限和管理用量链接，无 token |
| `POST /api/llm/chatgpt/sign-in` | JSON `{ newAccount?: boolean }`，返回 id、pending、授权 URL |
| `GET /api/llm/chatgpt/sign-in/:id` | pending/connected/cancelled/failed，安全 errorCode/failure |
| `DELETE /api/llm/chatgpt/sign-in/:id` | 取消本次授权并释放监听 |
| `POST /api/llm/chatgpt/models` | 重取当前账号模型，保留旧客户端兼容 |
| `POST /api/llm/providers/openai-chatgpt/models` | 共用设置入口重取当前账号模型，返回有效目录 |
| `DELETE /api/llm/chatgpt` | 撤销并断开连接 |

## 源码与验证

| 职责 | 入口 |
|---|---|
| 契约与安全诊断 | `packages/ssh-agent/src/domain/chatgpt.ts` |
| 授权端口与连接用例 | `packages/ssh-agent/src/application/chatgpt-authorization.ts`、`application/services/chatgpt-service.ts` |
| OAuth/JWT、回调、注册存储 | `packages/ssh-agent/src/infrastructure/chatgpt/chatgpt-oauth.ts`、`chatgpt-login.ts`、`chatgpt-registration-store.ts` |
| 静态授权成功页面及响应头 | 同目录 `chatgpt-callback-page.ts`，仅由回调监听器的成功分支使用 |
| Provider/模型/请求适配 | 同目录 `chatgpt-provider.ts`、`chatgpt-responses.ts`；`chatgpt-model-capabilities.ts` 管理订阅专属公开能力刷新/缓存，`chatgpt-model-metadata.ts` 校验和提取官方说明 |
| 路由与装配 | `packages/ssh-agent/src/api/chatgpt-routes.ts`、`runtime/create-sqlite-management-backend.ts` |
| Node 出站代理与回归 | `packages/ssh-agent/src/server/environment-proxy.ts`、`server/main.ts`、`test/environment-proxy.test.ts` |
| 前端 | `packages/ssh-agent-web/features/llm-provider/api/chatgpt-api.ts`、`components/chatgpt-connection.tsx`；设置与列表分工由 `components/llm-provider-settings.tsx`、`provider-list.tsx`、`provider-settings.css` 承担；共用 `provider-models-panel.tsx` 和 `api/llm-provider-api.ts` 提供目录查看/刷新，回归见 `tests/provider-models.test.tsx` |
| 测试 | `packages/ssh-agent/test/chatgpt-auth.test.ts`、`chatgpt-oauth.test.ts`、`chatgpt-responses.test.ts`、`chatgpt-model-capabilities.test.ts`、`chatgpt-test-fixture.ts` |

定向测试使用本机临时端口、临时 SQLite、合成 RSA 签名、模拟 OAuth/model 响应，以及真实 Responses SSE 解析器，覆盖授权、诊断、并发刷新、撤销、重启、账号隔离和工具往返。Responses 回归逐个覆盖上述四个模型的上下文窗口、输出元数据、输入类型、所有可选档位、off 到 none 的请求映射、完整基线优先和未知前缀保守兜底；使用真实 Terminal 工具定义检查基线/动态发现模型的最终 namespace 请求均包含 `strict: false`，并保留可选 `input`、`key`。尚未完成真实账号的完整推理验收，模拟测试不证明真实订阅可用性。

能力回归使用合成官方说明与假 fetch 验证未知新模型、同 ID 窗口和档位更新、精确 Snapshot、旧模型对象不变、无认证公开请求、账号列表隔离、来源标记、异常回退、非法/超大文档、取消与乱序刷新。另已只读获取公开 GPT-6.1 Sol/GPT-6 Sol Markdown 验证解析；不调用真实模型、读取账号凭据或修改生产数据。限制：本次不新增手动覆盖设置页或持久化能力存储；未知能力的通用 UI 显示仍沿用既有行为，真实性来源可从订阅模型对象检查。

已核对共享 HTTP/Backend 装配、目录、消息目录及依赖变化对现有 SSH、SFTP、Terminal、Deploy、Diagnose、Session、压缩和统计入口的影响；其业务生命周期与既有功能文档仍一致。代理定向回归检查原生 fetch 的 HTTP/HTTPS 路由、大小写优先级、NO_PROXY、loopback 绕过、关闭恢复及配置错误脱敏；公开身份端点的连通性不等于真实账号完整授权或付费推理验收。

实现依据：[Cookbook](https://developers.openai.com/cookbook/articles/sign-in-with-chatgpt)、[登录](https://developers.openai.com/siwc/token-sharing-open-source/sign-in)、[模型与推理](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference)、[预览限制](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations)。本地开源/个人使用与收费、面向其他用户的远程托管接入条件不同，以官方最新说明为准。


2026-10-21 缓存修复：主模型调用始终透传稳定 Session ID，接通已有 prompt_cache_key；全部 18 工具定义固定，运行状态以持久化消息追加。订阅适配继续只在原位置映射 developer，并发送完整历史。结构回归覆盖最终 input 的旧前缀保留；缓存指纹与实际 Usage 的口径和限制见 [runtime-context.md](./runtime-context.md)，不以离线测试推断订阅额度收益。
