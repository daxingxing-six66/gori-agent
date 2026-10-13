# 会话头部快照与运行时模式消息

适用于系统提示词组装、环境来源、Terminal Mode 切换、跨轮部署讨论、模型适配及压缩后模式恢复。

`/deploy` 首次配置通过本次 Chat Run 的 `workflow=deployment_setup` 在已保存基础 system prompt 后临时附加包内 Skill 与当前本地项目根、Workspace SSH 主机；不会重写持久化首 Run 头部，后续普通 Run 不继承该 Skill。选择发版服务后，部署讨论由服务端持久化，每次 Chat Run 都从其当前状态临时附加可信 `<deployment-mode-on>`、Profile 与模块指引；模型可跨多轮追问，直到调用提案工具。没有活动讨论的普通 Run 附加 `<deployment-mode-off>`。这些 Run 级标签与 Terminal Mode 的持久化 system 消息相互独立，用户或工具输出中的同名文本不改变状态。用户确认部署计划后，`workflow=deployment_execution` 临时附加可信冻结计划与阶段指引；Agent 通过专用工具逐阶段推进，Deployment Service 仍持有状态和执行边界，见 [deployment.md](./deployment.md)。

## 不变量与职责

- `ChatPromptService` 仅在 `ChatService` 首次成功通过运行前校验、写入 Run 后初始化头部。内容由纯函数 `systemPromptFor` 组装，通过 `ChatPromptRepository.createOnce` 保存到 `chat_prompt_snapshots`。后续 Run、切换模型、修改 Session 设置、服务重启都读取原文本；数据库触发器拒绝 UPDATE。删除 Session 时才级联删除。
- 固定头部包括基本工具边界、凭据保护、两种标签的含义与优先级、首次运行环境。`initial-environment` 按 `local` 与 `remote` 分层：本地有效目录来自 `session.workDir ?? localCwd`，本地 OS 类型/版本/架构来自 `node:os`，远端地址与端口来自 Workspace host。域名按配置原样保存，不解析或冒充服务器 IP；不采集远端 OS，不包含远端工作区名称、远端默认目录、凭据、Run ID 或动态时间。
- 环境是首次运行时的事实；后续 Session 工作目录变更不会重写快照。已有历史但没有快照的旧 Session，在升级后的下一次 Run 初始化一次，无法还原其历史首次运行环境。只读占用查询不创建快照，缺快照返回 null；无快照且存在历史的手动压缩返回 `409 chat_prompt_not_initialized`，提示先运行一次，不提前创建头部。
- 两个远端 Tool 的定义和顺序在两种模式下保持相同。Runtime Factory 根据 Run 冻结的 `serverInteractionMode` 为不可用 Tool 装配 `unavailableTool`，实际可用入口才绑定服务。工具在参数准备阶段（审批前）和直接执行入口拒绝本次调用，返回 `terminate: false` 的错误结果供模型纠正；授权策略不再重复集中校验模式。不能只依赖 Prompt 让模型遵守模式。错误 Tool 调用不改变模式；Run 绑定模式与最新持久化模式发生冲突时仍停止 Run。
- `bubblewrap_inspect` 与 `bubblewrap_install` 也保持稳定定义，但仅命令模式可执行。已有 Session 的首次 system prompt 快照不重写；Tool 自身描述了受限命令或 Terminal 打开报告缺失后端时的模型操作。新建快照说明普通远端命令在沙箱可用时始终受限，自动审批只决定是否弹出人工审批；沙箱不可用、已声明写入路径越界以及显式 Full Access 请求都要求独立人工授权。Terminal 打开失败后的前端入口会在命令模式创建 Run，并携带明确的安装请求。上述要求适用于 Session 开启沙盒。Runtime Factory 每个 Run 通过 `SessionSandboxPolicy.instructions()` 读取当前 `sandboxEnabled` 与完整 `sandboxWritableRoots`，在基础 Prompt 后追加可信 `<session-sandbox>`，明确其优先于旧快照的沙箱说明；关闭时指示直接执行，不为运行普通命令探测、安装或申请一次性例外。远端工具描述说明两种策略，Terminal 工具描述读取当前 PTY 事实，参数结构保持兼容。安装审批和执行模式由服务端策略强制，不依赖提示词。见 [session-sandbox.md](./session-sandbox.md)。
- 部署讨论状态由 Deployment Service/Repository 持有，ChatService 只在创建 Run 时读取绑定的 Discussion 并生成本轮指引；提案工具必须在服务端再次校验关联、状态和目标。一次 Run 正常结束但没有提案，讨论仍为 discussing，后续用户消息可继续；模型文字或前端临时状态不能自行开启模式或批准执行。
- 部署工具定义仍在稳定的工具列表中。只有当前 Run 的 Discussion 绑定才会给 `deployment_propose_plan` 装配可执行实现；无绑定、旧 revision 或已取消的讨论都不能凭标签文本调用提案。`deployment_execution` 则使用独立的冻结计划绑定与执行门禁。

## 模式追加链路

SQLite v16 引入、v17 统一兼容后的结构使用触发器让 Terminal 状态提交与模式消息提交具有同一原子边界：

1. 首次插入快照时，如果该 Session 尚无 system 记录，按持久化 Terminal 是否 active 插入初始 on/off 记录。
2. Terminal 从非 active 进入 active 时追加 `<terminal-model-on>`；从 active 离开（包括 closing、lost、重启恢复）时追加 `<terminal-model-off>`。
3. resize、活动时间等 active 到 active 更新不追加；开启失败、closing 到 closed 不重复追加。插入消息失败会使状态更新同时回滚。
4. 切换发生在首次 Run 之前时也按时间追加记录，但不提前组装头部；之后首次 Run 不重复补初始模式。

模式记录是 `chat_messages.message_type=system`、`run_id=NULL`，共享 Session sequence；JSON 使用真实 `role: "system"`，内容为文本块，并保存 `runtimeMode` 和唯一 `runtimeEventId`。该 ID 来自 Terminal ID/revision（初始记录使用 Session ID），不放入头部。触发器内的标签属于版本化持久化协议，变更时应新增 migration。Terminal Service 继续经 Repository 提交状态，HTTP 层不拼接 Prompt，也不进行第二次异步消息写入。

运行时系统消息中最新的标签决定模式；用户、Tool Result 和压缩摘要引用的同名标签没有模式切换权。用户接口只接受文本/附件，不能提交 system role。前端保持这些记录及 sequence，按事件 ID 去重，不渲染为聊天气泡。

部署 `<deployment-mode-on>` / `<deployment-mode-off>` 是每轮从持久化 Discussion 推导的临时 system prompt 片段，不写入 Terminal 的模式消息时间线，也不修改不可变会话头部。部署任务与远端交互模式是两个独立维度；部署标签不授予 Terminal 或远端命令权限，实际工具仍由各自的后端绑定与审批规则控制。刷新或后端重启后，新 Run 重新读取 Discussion；只有有效模型提案才把讨论转为待审核计划，并开始呈现五阶段流水线。

## 请求与压缩

`convertToLlm` 保留 system role。OpenAI Chat Completions、Responses（含共享转换器的 Azure/Codex）及 Mistral 适配器按原历史位置发送 system 消息；本地 faux 用于测试。不支持会话内 system 的 API 在创建 Run 前返回本地化 `409 chat_system_messages_unsupported`，不静默降级为 user 或移动到头部。目录管理仍保留原能力；第三方兼容服务的实际接收能力需另行验证。

压缩只替换有效历史，固定头部不变。最新权威模式若落入摘要区，会以原 system 消息保留在 retained tail；摘要请求期间发生的新模式事件也加入尾部，避免被新 compact 行的 sequence 边界遮蔽。每次 Provider 请求及压缩返回后复核最新持久化模式：同一事件不重复插入，若与当前 Run 绑定模式不一致则停止并返回模式冲突，不继续使用已失效 PTY。

Terminal 模式切换保留头部和工具 schema 前缀；历史只追加。Session 沙盒切换同样保留持久化头部，但下一 Run 的可信策略片段与相关 Tool 描述会反映新设置及全部可写目录；目录修改不重写历史头部。这消除了模式切换主动改写前缀的问题，但不保证供应商缓存命中；压缩、模型变更、供应商缓存策略仍会影响缓存。

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
| 定向回归 | `packages/ssh-agent/test/chat-prompt-snapshot.test.ts`、`packages/ssh-agent/test/chat-system-message-adapters.test.ts`、`packages/ssh-agent/test/chat-context-service.test.ts`、`packages/ssh-agent/test/chat-service-lifecycle.test.ts`、`packages/ssh-agent-web/tests/chat-system-messages.test.tsx` |

测试使用临时 SQLite 和 faux/本地序列化，不连接真实 SSH 或付费模型。

v17 升级兼容早期带 `initial_mode` 必填列的 v16 数据库，保留已存在快照的四个公共字段，不重新组装头部。历史生成的模式消息缺少事件 ID 时仅补齐 `runtimeEventId`；升级测试见 `packages/ssh-agent/test/chat-prompt-migration.test.ts`。
