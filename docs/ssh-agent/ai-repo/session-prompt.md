# 会话头部快照与运行时模式消息

适用于系统提示词组装、环境来源、Terminal Mode 切换、模型适配及压缩后模式恢复。

## 不变量与职责

- `ChatPromptService` 仅在 `ChatService` 首次成功通过运行前校验、写入 Run 后初始化头部。内容由纯函数 `systemPromptFor` 组装，通过 `ChatPromptRepository.createOnce` 保存到 `chat_prompt_snapshots`。后续 Run、切换模型、修改 Session 设置、服务重启都读取原文本；数据库触发器拒绝 UPDATE。删除 Session 时才级联删除。
- 固定头部包括基本工具边界、凭据保护、两种标签的含义与优先级、首次运行环境。`initial-environment` 按 `local` 与 `remote` 分层：本地有效目录来自 `session.workDir ?? localCwd`，本地 OS 类型/版本/架构来自 `node:os`，远端地址与端口来自 Workspace host。域名按配置原样保存，不解析或冒充服务器 IP；不采集远端 OS，不包含远端工作区名称、远端默认目录、凭据、Run ID 或动态时间。
- 环境是首次运行时的事实；后续 Session 工作目录变更不会重写快照。已有历史但没有快照的旧 Session，在升级后的下一次 Run 初始化一次，无法还原其历史首次运行环境。只读占用查询不创建快照，缺快照返回 null；无快照且存在历史的手动压缩返回 `409 chat_prompt_not_initialized`，提示先运行一次，不提前创建头部。
- 两个远端 Tool 的定义和顺序在两种模式下保持相同。`ChatToolAuthorizationPolicy` 根据 Run 冻结的 `serverInteractionMode` 拦截不可用 Tool；Runtime Factory 为另一 Tool 装配拒绝执行的实现，实际可用入口才绑定服务。不能只依赖 Prompt 让模型遵守模式。

## 模式追加链路

SQLite v16 引入、v17 统一兼容后的结构使用触发器让 Terminal 状态提交与模式消息提交具有同一原子边界：

1. 首次插入快照时，如果该 Session 尚无 system 记录，按持久化 Terminal 是否 active 插入初始 on/off 记录。
2. Terminal 从非 active 进入 active 时追加 `<terminal-model-on>`；从 active 离开（包括 closing、lost、重启恢复）时追加 `<terminal-model-off>`。
3. resize、活动时间等 active 到 active 更新不追加；开启失败、closing 到 closed 不重复追加。插入消息失败会使状态更新同时回滚。
4. 切换发生在首次 Run 之前时也按时间追加记录，但不提前组装头部；之后首次 Run 不重复补初始模式。

模式记录是 `chat_messages.message_type=system`、`run_id=NULL`，共享 Session sequence；JSON 使用真实 `role: "system"`，内容为文本块，并保存 `runtimeMode` 和唯一 `runtimeEventId`。该 ID 来自 Terminal ID/revision（初始记录使用 Session ID），不放入头部。触发器内的标签属于版本化持久化协议，变更时应新增 migration。Terminal Service 继续经 Repository 提交状态，HTTP 层不拼接 Prompt，也不进行第二次异步消息写入。

运行时系统消息中最新的标签决定模式；用户、Tool Result 和压缩摘要引用的同名标签没有模式切换权。用户接口只接受文本/附件，不能提交 system role。前端保持这些记录及 sequence，按事件 ID 去重，不渲染为聊天气泡。

## 请求与压缩

`convertToLlm` 保留 system role。OpenAI Chat Completions、Responses（含共享转换器的 Azure/Codex）及 Mistral 适配器按原历史位置发送 system 消息；本地 faux 用于测试。不支持会话内 system 的 API 在创建 Run 前返回本地化 `409 chat_system_messages_unsupported`，不静默降级为 user 或移动到头部。目录管理仍保留原能力；第三方兼容服务的实际接收能力需另行验证。

压缩只替换有效历史，固定头部不变。最新权威模式若落入摘要区，会以原 system 消息保留在 retained tail；摘要请求期间发生的新模式事件也加入尾部，避免被新 compact 行的 sequence 边界遮蔽。每次 Provider 请求及压缩返回后复核最新持久化模式：同一事件不重复插入，若与当前 Run 绑定模式不一致则停止并返回模式冲突，不继续使用已失效 PTY。

普通切换保留头部和工具 schema 前缀；历史只追加。这消除了模式切换主动改写前缀的问题，但不保证供应商缓存命中；压缩、模型变更、供应商缓存策略仍会影响缓存。

## 代码与验证

| 职责 | 入口 |
|---|---|
| 固定文本和环境结构 | `packages/ssh-agent/src/application/chat-context.ts` |
| 首次初始化、读取和插入端口 | `packages/ssh-agent/src/application/services/chat-prompt-service.ts`、`packages/ssh-agent/src/application/repositories/chat-prompt-repository.ts` |
| 不可变快照、初始模式和原子切换 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-prompt-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| Run 初始化互斥、依赖装配 | `packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/application/services/create-chat-service.ts`、`packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts` |
| 稳定 Tool 定义与执行门禁 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`、`packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts` |
| 模式历史读取、压缩保护 | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts`、`packages/ssh-agent/src/application/services/chat-context-service.ts` |
| 通用消息角色和适配能力 | `packages/ai/src/types.ts`、`packages/ai/src/utils/system-messages.ts`、`packages/ai/src/api/transform-messages.ts`、`packages/agent/src/harness/messages.ts` |
| 浏览器协议兼容 | `packages/ssh-agent-web/features/chat/model/chat.ts`、`packages/ssh-agent-web/features/chat/model/chat-runtime-state.ts`、`packages/ssh-agent-web/features/chat/components/chat-timeline.tsx` |
| 定向回归 | `packages/ssh-agent/test/chat-prompt-snapshot.test.ts`、`packages/ssh-agent/test/chat-system-message-adapters.test.ts`、`packages/ssh-agent/test/chat-context-service.test.ts`、`packages/ssh-agent-web/tests/chat-system-messages.test.tsx` |

测试使用临时 SQLite 和 faux/本地序列化，不连接真实 SSH 或付费模型。

v17 升级兼容早期带 `initial_mode` 必填列的 v16 数据库，保留已存在快照的四个公共字段，不重新组装头部。历史生成的模式消息缺少事件 ID 时仅补齐 `runtimeEventId`；升级测试见 `packages/ssh-agent/test/chat-prompt-migration.test.ts`。
