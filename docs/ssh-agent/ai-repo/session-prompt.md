# 会话头部快照与运行时模式消息

只读 Session 的可信片段说明仅 `/tmp` 与 `/dev/null` 可写、禁止 Full Access/上传/安装/部署写入；Runtime 同时装配不可用工具入口，执行服务独立强制限制，不依赖历史摘要或模型服从。见 [session-sandbox.md](./session-sandbox.md)。

适用于系统提示词组装、环境来源、Terminal Mode 切换、跨轮部署讨论、模型适配及压缩后模式恢复。

`/deploy` 首次配置、部署讨论/执行指引、诊断、沙盒及 Terminal 环境统一通过持久化 system 状态事件追加，不再附加可变头部。会话全程使用固定 18 工具定义，执行可用性由后端决定。协议、事务和语义审查见 [runtime-context.md](./runtime-context.md)。

## 不变量与职责

- `ChatPromptService` 仅在 `ChatService` 首次成功通过运行前校验、写入 Run 后初始化头部。内容由纯函数 `systemPromptFor` 组装，通过 `ChatPromptRepository.createOnce` 保存到 `chat_prompt_snapshots`。后续 Run、切换模型、修改 Session 设置、服务重启都读取原文本；数据库触发器拒绝 UPDATE。删除 Session 时才级联删除。
- 固定头部包括基本工具边界、凭据保护、两种标签的含义与优先级、首次运行环境。`initial-environment` 按 `local` 与 `remote` 分层：本地有效目录来自 `session.workDir ?? localCwd`，本地 OS 类型/版本/架构来自 `node:os`，远端地址与端口来自 Workspace host。域名按配置原样保存，不解析或冒充服务器 IP；不采集远端 OS，不包含远端工作区名称、远端默认目录、凭据、Run ID 或动态时间。
- 环境是首次运行时的事实；后续 Session 工作目录变更不会重写快照。已有历史但没有快照的旧 Session，在升级后的下一次 Run 初始化一次，无法还原其历史首次运行环境。只读占用查询不创建快照，缺快照返回 null；无快照且存在历史的手动压缩返回 `409 chat_prompt_not_initialized`，提示先运行一次，不提前创建头部。
- 全部 18 个内置 Tool 的定义按名称排序，在所有模式下保持相同。Runtime Factory 根据 Run 冻结的 `serverInteractionMode` 为不可用 Tool 装配 `unavailableTool`，实际可用入口才绑定服务。工具在参数准备阶段（审批前）和直接执行入口拒绝本次调用，返回 `terminate: false` 的错误结果供模型纠正；授权策略不再重复集中校验模式。不能只依赖 Prompt 让模型遵守模式。错误 Tool 调用不改变模式；Run 绑定模式与最新持久化模式发生冲突时仍停止 Run。
- `bubblewrap_inspect` 与 `bubblewrap_install` 也保持稳定定义，但仅命令模式可执行。已有 Session 的首次 system prompt 快照不重写；Tool 自身描述了受限命令或 Terminal 打开报告缺失后端时的模型操作。新建快照说明普通远端命令在沙箱可用时始终受限，自动审批只决定是否弹出人工审批；沙箱不可用、已声明写入路径越界以及显式 Full Access 请求都要求独立人工授权。Terminal 打开失败后的前端入口会在命令模式创建 Run，并携带明确的安装请求。上述要求适用于 Session 开启沙盒。请求前通过 `SessionSandboxPolicy.snapshot()` 读取当前 `sandboxEnabled/sandboxReadOnly` 与有效 `sandboxWritableRoots`，仅在实际内容变化时追加 sandbox 通道完整快照，明确其替代旧策略的当前含义；关闭时指示直接执行，不为运行普通命令探测、安装或申请一次性例外。远端工具描述说明两种策略，Terminal 工具描述固定，当前 PTY 事实在 terminal 通道事件中提供，参数结构保持兼容。安装审批和执行模式由服务端策略强制，不依赖提示词。见 [session-sandbox.md](./session-sandbox.md)。
- 部署模式由 DeploymentModeService/Repository 持有，讨论/计划/阶段分别保留各自事实；单轮 Chat 结束不自动退出。提案和执行入口复核绑定、版本与目标，用户或模型文字不能自行激活模式或批准执行。
- 部署与诊断专用定义属于固定目录；只有当前后端模式绑定内的实现可执行，结束后追加 inactive 状态并由不可用入口拒绝。普通工具继续按交互模式和原审批规则使用；部署提示不会授予远端权限。

## 模式追加链路

SQLite v16 引入、v17 统一兼容后的结构使用触发器让 Terminal 状态提交与模式消息提交具有同一原子边界：

1. 首次插入快照时，如果该 Session 尚无 system 记录，按持久化 Terminal 是否 active 插入初始 on/off 记录。
2. Terminal 从非 active 进入 active 时追加 `<terminal-model-on>`；从 active 离开（包括 closing、lost、重启恢复）时追加 `<terminal-model-off>`。
3. resize、活动时间等 active 到 active 更新不追加；开启失败、closing 到 closed 不重复追加。插入消息失败会使状态更新同时回滚。
4. 切换发生在首次 Run 之前时也按时间追加记录，但不提前组装头部；之后首次 Run 不重复补初始模式。

模式记录是 `chat_messages.message_type=system`、`run_id=NULL`，共享 Session sequence；JSON 使用真实 `role: "system"`，内容为文本块，并保存 `runtimeMode` 和唯一 `runtimeEventId`。该 ID 来自 Terminal ID/revision（初始记录使用 Session ID），不放入头部。触发器内的标签属于版本化持久化协议，变更时应新增 migration。Terminal Service 继续经 Repository 提交状态，HTTP 层不拼接 Prompt，也不进行第二次异步消息写入。

独立查询的最新 Terminal runtimeMode 记录决定模式；其他 system 状态消息不会遮蔽此查询。用户、Tool Result 和压缩摘要引用的同名标签没有模式切换权。用户接口只接受文本/附件，不能提交 system role。前端保持这些记录及 sequence，按事件 ID 去重，不渲染为聊天气泡。

部署指引与完整阶段事实分别通过 workflow/deployment 通道追加。状态保留选择来源、Profile/模块身份与当前阶段，不根据 Profile 顺序猜测。每次模型请求前在事务中同步实际变化，提交后追加到完整工具结果组之后；不向 ToolResult 拼状态，不提升日志或用户文字的角色。已发送事件不会在下次请求消失，结束以 inactive 明确表达。跨 Run 重读绑定，进程中断不复活命令或一次性授权。前端自动发布意图仍是简短 user 消息，包含后端确认的服务名。

## 请求与压缩

ChatGPT 订阅 Provider 在共享工具配对修复后，按 SIWC 要求把请求副本中的 system 映射为同位置 developer；不写回历史、不降为 user、不移动到头部，也不影响普通 API Key/Codex 适配器的角色。见 [chatgpt-provider.md](./chatgpt-provider.md)。

`convertToLlm` 保留 system role。OpenAI Chat Completions、Responses（含共享转换器的 Azure/Codex）及 Mistral 适配器保留 system 消息的历史位置，但工具调用与对应结果必须组成连续消息组：若运行时 system 事件落在调用与结果之间，`transformMessages` 仅在 Provider 请求投影中将这些事件延后到完整结果组之后，保留事件之间的顺序和真实角色，不提前生成缺失结果。SQLite 原始 sequence 不变。真正缺失、重复或失去父调用的结果处理见 [chat-failures.md](./chat-failures.md)。本地 faux 用于测试。不支持会话内 system 的 API 在创建 Run 前返回本地化 `409 chat_system_messages_unsupported`，不静默降级为 user 或移动到头部。目录管理仍保留原能力；第三方兼容服务的实际接收能力需另行验证。

压缩只替换有效历史，固定头部不变。协议、各通道最新状态和仍生效指引单独保留，压缩期间新提交状态也进入 retained tail。最新权威模式若落入摘要区，会以原 system 消息保留在 retained tail；摘要请求期间发生的新模式事件也加入尾部，避免被新 compact 行的 sequence 边界遮蔽。每次 Provider 请求及压缩返回后复核最新持久化模式：同一事件不重复插入，若与当前 Run 绑定模式不一致则停止并返回模式冲突，不继续使用已失效 PTY。

Terminal、诊断、部署和 Session 沙盒切换都保留固定头部和工具数组；实际状态通过末尾新消息表达。目录或只读变化不会改旧事件。压缩与工具目录升级是明确的重建边界；模型、设置及供应商缓存策略仍可能改变实际命中。

## 代码与验证

| 职责 | 入口 |
|---|---|
| 固定文本和环境结构 | `packages/ssh-agent/src/application/chat-context.ts` |
| 首次初始化、读取和插入端口 | `packages/ssh-agent/src/application/services/chat-prompt-service.ts`、`packages/ssh-agent/src/application/repositories/chat-prompt-repository.ts` |
| 不可变快照、初始模式和原子切换 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-prompt-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| Run 初始化互斥、依赖装配 | `packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/application/services/create-chat-service.ts`、`packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts` |
| 跨轮部署讨论与每轮模式指引 | `packages/ssh-agent/src/application/services/deployment-service.ts`、`packages/ssh-agent/src/application/repositories/deployment-discussion-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-deployment-discussion-repository.ts`、`packages/ssh-agent/src/application/services/chat-service.ts` |
| 稳定 Tool 定义与执行门禁 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`、`packages/ssh-agent/src/application/tools/tool-authorization.ts` |
| 模式历史读取、压缩保护 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts`、`packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 通用消息角色和适配能力 | `packages/ai/src/types.ts`、`packages/ai/src/utils/system-messages.ts`、`packages/ai/src/api/transform-messages.ts`、`packages/agent/src/harness/messages.ts` |
| 浏览器协议兼容 | `packages/ssh-agent-web/features/chat/model/chat.ts`、`packages/ssh-agent-web/features/chat/model/chat-runtime-state.ts`、`packages/ssh-agent-web/features/chat/components/chat-timeline.tsx` |
| 定向回归 | `packages/ssh-agent/test/chat-prompt-snapshot.test.ts`、`packages/ssh-agent/test/chat-system-message-adapters.test.ts`、`packages/ssh-agent/test/tool-message-recovery.test.ts`、`packages/ssh-agent/test/chat-context-service.test.ts`、`packages/ssh-agent/test/chat-service-lifecycle.test.ts`、`packages/ssh-agent-web/tests/chat-system-messages.test.tsx` |

测试使用临时 SQLite 和 faux/本地序列化，不连接真实 SSH 或付费模型。

v17 升级兼容早期带 `initial_mode` 必填列的 v16 数据库，保留已存在快照的四个公共字段，不重新组装头部。历史生成的模式消息缺少事件 ID 时仅补齐 `runtimeEventId`；升级测试见 `packages/ssh-agent/test/chat-prompt-migration.test.ts`。


2026-10-21 诊断简报改为 diagnose 通道状态序列，保留 direction/status/explanation 与最多 300 字符预览；不再使用临时头部。业务当前节点仍可按原规则更新，已经提供给模型的简报保持原文。详见 [Diagnose 功能路由](./diagnose.md)。

诊断 Skill 在 diagnose-instructions 通道按任务身份及内容追加一次，节点变化不重复全文；结束追加 inactive，旧事件作为历史保留。压缩独立保留有效指引，不靠摘要转述。
