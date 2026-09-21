# SQLite 持久化代码路由

适用于数据库初始化、schema migration、实体映射、Repository 实现、Credential 密文和默认后端装配。

## 当前边界

- 使用 Node `node:sqlite`，启动时开启 foreign keys、busy timeout；文件数据库使用 WAL。
- schema 由版本化 migration 管理，当前版本为 v17；v7 增加 Session 本地配置、Chat Run、消息、队列、审批和 Agent Session 投影表，v8 为 Tool Approval 增加持久化描述，v9 增加每个 LLM Provider 的最后一次成功模型目录快照，v10 增加 TerminalSession、Interaction、Input、Observation、Timeline 和 Chat Run 交互模式字段，v11 增加自定义 LLM Provider 聚合，v12 为 Chat 消息增加类型、Provider 和 Usage 投影并移除旧 Agent Session 投影表，v13 为 Tool Approval 描述和 Terminal failure 增加可选 message key/values 元数据，v14 增加 Session Attachment 元数据、同名唯一约束和级联删除，v15 增加有序 `chat_message_attachments` 关系，v16 增加不可变 `chat_prompt_snapshots`，通过触发器原子记录初始模式及 Terminal active 边界变化。见 [session-prompt.md](./session-prompt.md)。
- v17 兼容开发期间已执行的两种 v16 结构：在同一事务内重建快照表，去除早期 `initial_mode NOT NULL` 列，逐字保留头部文本及其版本、创建时间，重建模式触发器；仅为缺失 `runtimeEventId` 的已生成模式消息补齐原消息 ID，不改变顺序和标签。不重新生成已有快照，也不清空业务数据。失败时表、触发器、消息修补与版本记录一起回滚；重复启动跳过已完成的版本。
- v1 到 v2 采用开发期重建策略：带业务数据的 v1 数据库会拒绝启动并提示人工备份、删除；程序不会自动删除或搬迁旧数据。
- Credential 元数据与认证材料分表。认证材料使用 AES-256-GCM，加密 AAD 绑定 `credentialId:authVersion`；32 字节密钥必须由进程外部注入。
- LLM Provider Credential 同样按元数据和 Secret 分表，使用独立 AAD `llm-provider:providerId:revision`，不会与 SSH Credential 混淆。
- `llm_provider_model_catalogs` 保存已配置 Provider 的最后一次成功远端模型数组、检查时间和 ETag。成功刷新整行覆盖；失败不写入，因而不会把暂时网络故障解释为模型下架。
- `llm_custom_providers` 保存用户定义的 Provider 元数据、协议、认证模式、兼容参数和完整模型数组。更新按 revision 精确替换聚合；SQLite mapper 会校验行标量以及 `compat_json`、`models_json` 的完整结构和领域约束，损坏数据不会穿透 Repository。删除 Provider 或从 API Key 切换为无认证时，相关 Credential/Secret 清理由 Application Service 在同一 SQLite 事务中编排。
- Guard 规则及其预设来源元数据以 JSON 保存；读取缺少来源字段的历史规则时按用户规则补齐默认值。Workspace 和 Session 使用独立表及外键约束。
- `credentials.workspace_id` 表示所有权并在 Workspace 删除时级联；内部 `is_active` 加 partial unique index 保证每个 Workspace 最多一个活动 Credential，API 不暴露该字段。
- `workspace_host_trusts.workspace_id` 同时是主键和级联外键；Workspace 创建时没有记录，首次 Tool 调用通过 `INSERT ... ON CONFLICT DO NOTHING` 固定唯一算法、SHA-256 指纹和后端时间。Credential 切换不修改该表。
- Workspace、首个 Credential、Secret 和 Guard 通过应用事务端口与 SQLite transaction runner 原子写入；同一数据库实例上的事务会排队执行，避免并发 HTTP 请求产生嵌套事务。
- 文件数据库、WAL 和 SHM 权限收紧为 `0600`。
- Connection、Channel、SFTP 内部阶段、监控快照、Chat delta、Terminal raw output/snapshot/replay 和文件内容不持久化。Terminal metadata、规范化 input/实际 bytes、Observation 和 Timeline 持久化；重启把遗留 live Terminal 收敛为 `lost`，写入中 Interaction 收敛为 `write_uncertain`，不会重放输入。
- SQLite backend 启动装配显式执行 Chat 与 Terminal interrupted recovery；业务 Service constructor 不隐式修改持久化状态。
- Session 最近模型选择直接查询最新 `chat_runs` 记录，不复制到 `sessions` 表，也不需要新增 migration。
- Chat 历史使用 `UNIQUE(session_id, sequence)` 索引完成正向和反向范围分页；反向查询在 SQLite 内取最接近边界的记录，Repository 返回前恢复为升序，不需要额外索引或 migration。
- Chat Run、File Transfer 和 Command Operation 的 JSON failure 继续保留英文 fallback，并可携带 `messageKey/messageValues`；存在元数据时公开查询可按当前 Locale 重新生成 message。旧记录没有 Key 时只使用稳定 code 的唯一映射或原 fallback，不解析历史字符串猜测参数。
- Attachment 表只保存后端生成的相对 `storage_path` 和文件元数据；文件字节保存在后端工作目录的 `attachments/sessions/{sessionId}`。数据库外键负责 Session 删除后的记录级联，磁盘目录由 Session Service 在删除成功后清理。
- 普通用户消息和 Attachment 的关联、顺序以 `chat_message_attachments` 为准；用户消息与关系在同一事务写入。同一 Attachment 可关联多条消息，消息或 Session 删除时关系级联清理。`message_json` 仍完整保存 `attachmentIds`，但读取投影按关系表恢复，并返回有序 Attachment 元数据。

- Chat `updateRun()` 在终态分支用一个事务更新 Run、安全 failure_json 及 pending 审批/队列；活动状态条件更新防止覆盖已完成结果，相同终态提交可重入。读取校验 failure 基本结构及版本身份；无版本的历史快照只读，不重写历史原因。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 数据库打开、PRAGMA 和文件权限 | [database.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/database.ts) |
| schema 和 migration | [migrations.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/migrations.ts) |
| 数据库行到领域实体映射 | [rows.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/rows.ts) |
| Credential 加密 | [credential-cipher.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/credential-cipher.ts) |
| LLM Provider Credential 加密和 pi-ai Store | [llm-provider-credential-cipher.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/llm-provider-credential-cipher.ts)、[sqlite-llm-provider-credential-store.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-llm-provider-credential-store.ts) |
| LLM 模型快照 Store | [sqlite-llm-model-catalog-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-llm-model-catalog-repository.ts) |
| 自定义 LLM Provider Store 和持久化边界校验 | [sqlite-custom-llm-provider-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-custom-llm-provider-repository.ts)、[custom-llm-provider-row.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/custom-llm-provider-row.ts) |
| Credential 元数据和 Secret Store | [sqlite-credential-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-credential-repository.ts) |
| Workspace、Host Trust、Session、Guard Repository | [sqlite-workspace-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-workspace-repository.ts)、[sqlite-workspace-host-trust-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-workspace-host-trust-repository.ts)、[sqlite-session-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-session-repository.ts)、[sqlite-guard-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-guard-repository.ts) |
| Command Operation 和事件 Repository | [sqlite-command-operation-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-command-operation-repository.ts) |
| File Transfer Repository | [sqlite-file-transfer-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-file-transfer-repository.ts) |
| Attachment Repository | [sqlite-attachment-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-attachment-repository.ts) |
| Chat Run、消息、Queue、Approval 和压缩 Repository | [chat-repository.ts](../../../packages/ssh-agent/src/application/repositories/chat-repository.ts)、[sqlite-chat-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts) |
| Terminal Repository | [terminal-repository.ts](../../../packages/ssh-agent/src/application/repositories/terminal-repository.ts)、[sqlite-terminal-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-terminal-repository.ts) |
| SQLite 事务实现 | [sqlite-transaction-runner.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-transaction-runner.ts) |
| 默认依赖装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 持久化和密文测试 | [management-api.test.ts](../../../packages/ssh-agent/test/management-api.test.ts)、[command-operation-service.test.ts](../../../packages/ssh-agent/test/command-operation-service.test.ts) |

修改 schema 时必须追加 migration，不能改写已经应用的 migration 语义；同时检查重建前置条件、行映射、Repository、事务回滚和文件数据库重开测试。

升级回归：`packages/ssh-agent/test/chat-prompt-migration.test.ts` 使用冻结的两种 v16 SQL fixture 验证带数据升级、空快照升级、原文保留、模式消息修补、不可变约束、级联删除、回滚重试及幂等性。
