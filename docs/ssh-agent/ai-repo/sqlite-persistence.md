# SQLite 持久化代码路由

适用于数据库初始化、schema migration、实体映射、Repository 实现、Credential 密文和默认后端装配。

历史 v18 为 Workspace 增加 `remote_default_cwd`，v21 合并旧可写根，v28 将其迁成 Workspace/Session 独立 `sandbox_writable_roots_json`。当前 v32 删除 `remote_default_cwd`；保留可写目录原文、本地 `default_cwd`、Session `work_dir`、revision 及历史快照，不猜测或重写已有权限。`workspace-directories.test.ts` 使用冻结 v11/v27 schema 验证升级、外键和重复迁移。

v19 追加 nullable `workspaces.remote_sandbox_root` 及 `command_operations.agent_run_id/sandbox_json/sandbox_justification`。v21 将已有独立可写根优先迁入 `remote_default_cwd`，再删除 `remote_sandbox_root`；旧根不存在时保留原远端目录。历史命令的约束事实不改写。Operation 保存实际 mode/backend/enforcement/ABI/规范根及可能副作用事实；Repository 按模式、后端和确认状态校验 `sandbox_json`，同时保留旧记录的未知及确认前事实。一次性 Full Access grant 只存内存。旧 v4/v15 回归使用冻结 schema fixture，避免从最新结构反向删表。见 [remote-sandbox.md](./remote-sandbox.md)。

Bubblewrap 事实沿用现有 JSON 列，无 schema migration：保存 `backend=bubblewrap`、版本和规范根，不写 Landlock ABI。`stored-command-sandbox.ts` 与 `stored-terminal-sandbox.ts` 分别在 Command/Terminal Repository 读取边界严格解析新旧事实，按后端与记录类型分成小方法；Terminal 的旧 `approvedAt`、`source/detectedAt` 与 null 只用于历史读取，不恢复授权或放宽 opening/active 约束；Session 主动关闭后的 Terminal 新事实使用 `source=session_setting/configuredAt`，要求请求与实际模式均为 `full_access`，不沿用历史自动回退的请求模式例外。Command 的 `authorizationSource=session_setting` 仅允许 `full_access/backend=none`；事实读取不授予后续权限。安装仍按单条 Full Access Command Operation 留下审计，grant 不持久化。

## 当前边界

- ChatGPT OAuth 沿用现有 LLM Credential 加密表，无 schema migration。数据库旁的注册文件只存 host/client/subject，无 token；账号模型只在进程内发现，不作为通用目录快照恢复。见 [chatgpt-provider.md](./chatgpt-provider.md)。

- v22 新增 `chat_user_decisions`：持久化 Session/Run/Tool Call 绑定、问题 JSON、答案 JSON 和 pending/answered/cancelled/interrupted 状态。Repository 在读取边界解析问题与答案，按每题实际选项数量校验推荐项与答案索引，不限定为三个选项；启动恢复将遗留 pending 决策标记为 interrupted，Run 仍按现有重启逻辑失败。见 [user-decision.md](./user-decision.md)。

- 使用 Node `node:sqlite`，启动时开启 foreign keys、busy timeout；文件数据库使用 WAL。
- schema 由版本化 migration 管理，统计索引迁移为 v29；后续版本见 migration 源码；v7 增加 Session 本地配置、Chat Run、消息、队列、审批和 Agent Session 投影表，v8 为 Tool Approval 增加持久化描述，v9 增加每个 LLM Provider 的最后一次成功模型目录快照，v10 增加 TerminalSession、Interaction、Input、Observation、Timeline 和 Chat Run 交互模式字段，v11 增加自定义 LLM Provider 聚合，v12 为 Chat 消息增加类型、Provider 和 Usage 投影并移除旧 Agent Session 投影表，v13 为 Tool Approval 描述和 Terminal failure 增加可选 message key/values 元数据，v14 增加 Session Attachment 元数据、同名唯一约束和级联删除，v15 增加有序 `chat_message_attachments` 关系，v16 增加不可变 `chat_prompt_snapshots`，通过触发器原子记录初始模式及 Terminal active 边界变化。v20 保存 Terminal 实际沙箱事实，v21 合并远端目录，v22 保存 Agent 用户决策，v23 保存 Deployment Run 计划、阶段和 Full Access 决策快照，v24 为同一 Session 的模型规划 Run 增加唯一关联索引，v25 保存部署讨论、每轮 Chat Run 绑定和单 Session 活动讨论唯一约束，v26 为 `deployment_runs` 增加 `recovering` 状态约束；v27 为 Session 增加非空布尔 `sandbox_enabled`，默认 1，升级不改其他设置或 revision。见 [session-prompt.md](./session-prompt.md) 和 [deployment.md](./deployment.md)。
- v17 兼容开发期间已执行的两种 v16 结构：在同一事务内重建快照表，去除早期 `initial_mode NOT NULL` 列，逐字保留头部文本及其版本、创建时间，重建模式触发器；仅为缺失 `runtimeEventId` 的已生成模式消息补齐原消息 ID，不改变顺序和标签。不重新生成已有快照，也不清空业务数据。失败时表、触发器、消息修补与版本记录一起回滚；重复启动跳过已完成的版本。
- v1 到 v2 采用开发期重建策略：带业务数据的 v1 数据库会拒绝启动并提示人工备份、删除；程序不会自动删除或搬迁旧数据。
- Credential 元数据与认证材料分表。认证材料使用 AES-256-GCM，加密 AAD 绑定 `credentialId:authVersion`；32 字节密钥必须由进程外部注入。
- LLM Provider Credential 同样按元数据和 Secret 分表，使用独立 AAD `llm-provider:providerId:revision`，不会与 SSH Credential 混淆。
- `llm_provider_model_catalogs` 保存已配置 Provider 的最后一次成功远端模型数组、检查时间和 ETag。成功刷新整行覆盖；失败不写入，因而不会把暂时网络故障解释为模型下架。
- `llm_custom_providers` 保存用户定义的 Provider 元数据、协议、认证模式、兼容参数和完整模型数组。更新按 revision 精确替换聚合；SQLite mapper 会校验行标量以及 `compat_json`、`models_json` 的完整结构和领域约束，损坏数据不会穿透 Repository。删除 Provider 或从 API Key 切换为无认证时，相关 Credential/Secret 清理由 Application Service 在同一 SQLite 事务中编排。
- Guard 规则及其预设来源元数据以 JSON 保存；读取缺少来源字段的历史规则时按用户规则补齐默认值。Workspace 和 Session 使用独立表及外键约束。
- `credentials.workspace_id` 表示所有权并在 Workspace 删除时级联；内部 `is_active` 加 partial unique index 保证每个 Workspace 最多一个活动 Credential，API 不暴露该字段。
- `workspace_host_trusts.workspace_id` 同时是主键和级联外键；Workspace 创建时没有记录，首次 Tool 调用通过 `INSERT ... ON CONFLICT DO NOTHING` 固定唯一算法、SHA-256 指纹和后端时间。Credential 切换不修改该表。
- Workspace、首个 Credential、Secret 和 Guard 通过应用事务端口与 SQLite transaction runner 原子写入；同一数据库实例上的事务会排队执行。同步事务闭包执行完即提交，不额外跨一个微任务持有连接；事务确需跨异步等待时，runner 通过 AsyncLocalStorage 标识所有者，并在共享 SQLite 连接的 `prepare`、已编译语句执行及 `exec` 边界拒绝其他请求读写，避免无关的部署记录被卷入后续回滚。非事务请求遇到该短暂占用会收到明确错误；此处尚未为所有同步 Repository 操作增加自动重试队列。
- 文件数据库、WAL 和 SHM 权限收紧为 `0600`。
- Connection、Channel、SFTP 内部阶段、监控快照、Chat delta、Terminal raw output/snapshot/replay 和文件内容不持久化。Terminal metadata、规范化 input/实际 bytes、Observation 和 Timeline 持久化；重启把遗留 live Terminal 收敛为 `lost`，写入中 Interaction 收敛为 `write_uncertain`，不会重放输入。
- Deployment 的 `session_sandbox_disabled` 原因表示 Session 直接授权，不要求沙箱例外审批；JSON 解析与前端投影都区分该来源。Deployment Snapshot 的 SQLite 读取边界校验 `remoteAccess`、绑定的 Agent Run 和历史、阶段顺序、阶段尝试、修订版本和提案链，以及逐阶段审批与当前命令的一致性；旧记录缺少 `remoteAccess` 时沿用原受限模式，不追认 Full Access。`deployment_runs` 按 Session、固定的 `createdAt` 和 ID 稳定分页；同一 Workspace 的运行中部署通过原子条件更新互斥。`recovering` 的提案与确认通过 `updated_at` 比较更新防竞争，重启后可继续审阅已保存提案；未执行远端阶段的旧 Full Access 批准重置为待批。后端启动时将尚未执行的 preparing 计划取消，把 running 部署标记 failed 并提示检查远端副作用，待决审批标记 rejected；一次性 Full Access grant 只存内存，不随快照恢复。SQLite backend 启动装配显式执行 Chat、Terminal 与 Deployment interrupted recovery；业务 Service constructor 不隐式修改持久化状态。
- `deployment_discussions` 与 `deployment_discussion_runs` 独立于 Deployment Run 保存讨论身份、修订号、状态、Profile/目标绑定和每轮 Chat Run 关联。Repository 在 SQLite 读取边界校验行与 JSON 快照的一致性；同一 Session 至多一个 `discussing` 记录。讨论取消或替换通过 revision 条件更新，提案与 Deployment Run 插入在同一事务提交。重启后仍可在新的 Chat Run 中继续有效讨论，旧活动 Chat Run 按 Chat 恢复规则结束。
- Session 最近模型选择直接查询最新 `chat_runs` 记录，不复制到 `sessions` 表，也不需要新增 migration。
- Chat 历史使用 `UNIQUE(session_id, sequence)` 索引完成正向和反向范围分页；反向查询在 SQLite 内取最接近边界的记录，Repository 返回前恢复为升序，不需要额外索引或 migration。
- Chat Run、File Transfer 和 Command Operation 的 JSON failure 继续保留英文 fallback，并可携带 `messageKey/messageValues`；存在元数据时公开查询可按当前 Locale 重新生成 message。旧记录没有 Key 时只使用稳定 code 的唯一映射或原 fallback，不解析历史字符串猜测参数。
- Attachment 表只保存后端生成的相对 `storage_path` 和文件元数据；文件字节默认保存在数据目录（`SSH_AGENT_DATA_DIR` 或 `~/.gori-agent`）的 `attachments/sessions/{sessionId}`。数据库外键负责 Session 删除后的记录级联，磁盘目录由 Session Service 在删除成功后清理。
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
| Command/Terminal 沙箱事实解码与历史兼容 | [stored-command-sandbox.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/stored-command-sandbox.ts)、[stored-terminal-sandbox.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/stored-terminal-sandbox.ts) |
| File Transfer Repository | [sqlite-file-transfer-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-file-transfer-repository.ts) |
| Attachment Repository | [sqlite-attachment-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-attachment-repository.ts) |
| Chat Run、消息、Queue、Approval 和压缩 Repository | [chat-repository.ts](../../../packages/ssh-agent/src/application/repositories/chat-repository.ts)、[sqlite-chat-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts) |
| Terminal Repository | [terminal-repository.ts](../../../packages/ssh-agent/src/application/repositories/terminal-repository.ts)、[sqlite-terminal-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-terminal-repository.ts) |
| Deployment Run 与审批快照 Repository | [deployment-repository.ts](../../../packages/ssh-agent/src/application/repositories/deployment-repository.ts)、[sqlite-deployment-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-deployment-repository.ts) |
| 部署讨论与每轮 Chat Run 绑定 Repository | [deployment-discussion-repository.ts](../../../packages/ssh-agent/src/application/repositories/deployment-discussion-repository.ts)、[sqlite-deployment-discussion-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-deployment-discussion-repository.ts) |
| SQLite 事务实现 | [sqlite-transaction-runner.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-transaction-runner.ts) |
| 默认依赖装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 持久化和密文测试 | [management-api.test.ts](../../../packages/ssh-agent/test/management-api.test.ts)、[command-operation-service.test.ts](../../../packages/ssh-agent/test/command-operation-service.test.ts) |

修改 schema 时必须追加 migration，不能改写已经应用的 migration 语义；同时检查重建前置条件、行映射、Repository、事务回滚和文件数据库重开测试。

升级回归：`packages/ssh-agent/test/chat-prompt-migration.test.ts` 使用冻结的两种 v16 SQL fixture 验证带数据升级、空快照升级、原文保留、模式消息修补、不可变约束、级联删除、回滚重试及幂等性。

`context-compaction-api.test.ts` 从冻结的 `test/fixtures/schema-v11.sql` 创建带合法 Workspace/Session 与消息的旧库，在外键开启时验证升级到当前 v35、消息原文和顺序保留、类型/Usage 回填及重复迁移幂等性。不要从最新 schema 反向删表模拟旧版，以免遗留后续版本的触发器与外键。`llm-provider-api.test.ts` 的重开测试验证当前 schema 下凭据可解密、迁移记录及执行时间不被重写，不冒充 v3 升级测试。

v28 为 Workspace 与 Session 追加 nullable `sandbox_writable_roots_json` 数组列。旧 Workspace 的非根远端 cwd 原样回填为单元素列表，`/` 回填为空列表；已有 Session 复制所属 Workspace 的范围。migration 不改 revision、头部、历史命令或 Terminal 事实。nullable 仅兼容旧 Repository 调用；`stored-sandbox-writable-roots.ts` 将 null 解释为缺省，显式空列表表示未配置，不回退到 cwd，非空列表完整校验路径和数量。服务创建时总是保存独立列表。

新的 Command/Terminal 审计保存完整 `sandboxRoots` 及首根别名 `sandboxRoot`，SQLite 读取校验非空规范路径、无重复、首项一致；只有单根的历史事实继续可读。部署 Plan/Discussion 的目标绑定可携带完整 `sandboxWritableRoots`，读取时同样校验，缺省仅用于历史读取；执行时视为空列表，不从旧 writableRoot 推导授权，范围不一致须重新审阅。回归见 `sandbox-writable-roots.test.ts`（冻结 `fixtures/schema-v27-sandbox.sql`、文件重开、原文及历史保留）、`multiple-sandbox-roots.test.ts` 和 `deployment-sandbox-roots.test.ts`。


v30 新增 `deployment_sessions`，单 Session 活动身份通过唯一索引约束；Discussion/模式同事务创建，触发器追加一条正式 custom 历史消息。v31 新增 `deployment_stage_executions` 与 `deployment_logs`，请求幂等、单一 running 执行、阶段日志 sequence 与游标持久化；模式终态与当前 Run 结果同事务结算，完整日志不受快照尾部上限影响。重启只恢复持久化事实，不重放执行或恢复内存 grant；无计划讨论保持活动，对已结束 Run 的模式收敛使用 `MAX(created_at, now)`，避免时钟回拨违反结束时间约束。`deployment-mode.test.ts` 覆盖运行中退出竞争、迟到日志拒绝、结果提交失败后的明确结算和回拨恢复。对应 Repository 与回归见 [deployment.md](./deployment.md)。

v29 为独立使用统计追加消息时间/Run、Run 时间/ID、工作区+Run 时间/ID和非空启动时间索引，不改历史消息、Usage、Run 或业务恢复语义。查询实现独立读取已有表，遵守共享事务连接所有权；Token 和费用覆盖率在统计 DTO 中区分缺失与零。见 [statistics.md](./statistics.md)。

v33 新增 `deployment_history_finished` 触发器：模式首次进入终态时，在同一结算事务内把稳定 ID 的正式部署消息移动到 Session 最大 sequence 之后，更新消息时间和结果元数据；不插入第二条消息。重入结束不再次移动。升级只为已有终态入口补充 `legacy_finished` 和结束结果，保留旧 sequence/created_at，前端按结束时间投影；普通 Chat 消息原文与顺序不变。`deployment-mode.test.ts` 使用冻结 v27 schema + `fixtures/schema-v32-deployment.sql` 扩展验证真实 v32 带数据升级、重复迁移、外键、同一消息身份与失败/取消结算顺序。

v34 为 Session 追加 `sandbox_read_only`，默认 0，并要求只读时 `sandbox_enabled=1`。既有 Session 的 revision、目录与历史保持不变，Repository 保存和恢复新标记；实际受限审计仍使用 `workspace_write` 与 `/tmp` 根。升级、幂等和文件重开回归见 `read-only-sandbox.test.ts`。

UI 历史单独使用 `sqlite-chat-history-query.ts`，复用 SqliteChatRepository 的消息/附件投影：正式部署消息优先，缺失正式消息的旧 Run/活动讨论合成精简 custom 条目，v33 旧结束入口按结束位置挂接原始 sequence。按锚点分组分页，附属卡片 historyOrder=1，空 transcript 的锚点为 0；同组不拆开。该读模型不新增迁移、不更新消息、Run 或 Discussion；模型、压缩和 Usage 原读取方法继续读取原 transcript。回归见 `chat-message-pagination-api.test.ts`，包括原始消息逐字保持。


2026-10-19 Diagnose 接入：v35 追加 diagnose_tasks/nodes/tool_calls 三个业务表，以及 diagnose_chat_runs/requests 两个 Chat 技术关联表。单 Session 活动唯一、当前节点条件写与历史/终态 UPDATE 触发器保证顺序规则；结论、节点收口和终态原子提交，回执同事务去重。稳定 diagnose 历史消息创建/标题更新/结束移动由触发器完成，继续使用统一 Chat 历史读取。重启保留诊断任务，不重放执行。 详见 [Diagnose 功能路由](./diagnose.md)。
