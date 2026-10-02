# `/deploy` 代码路由

适用于当前 Session 的模型驱动部署、Deployment Profile、首次配置 Skill、阶段安全边界和会话历史回显。

## 当前行为

- `/deploy` 是已有 Session 的 Composer 工具入口；新 Session 创建前显示禁用入口。选择入口只打开部署面板，不向 Agent 发送自由执行部署的 Prompt。首版只扫描 Session 本地工作目录的 `.gori/deploy-*.md`，只展示 `target.host` 与当前 Workspace SSH 主机一致的 Profile；文件可保留其他主机的 Profile，但运行时不会跨 Workspace 选择主机或凭据。
- Profile 是 Markdown + YAML front matter v1。后端用 `yaml` 严格解析并校验版本、模块 ID、相对本地路径、绝对远端文件路径和必填命令；`.gori` 与 Profile 文件不能是符号链接。`connection.profile` 仅供显示，不作为凭据查找键。缺少 Profile 时，Chat Run 临时加载包内 `gori-deployment-spec` Skill，让 Agent 通过 `ask_user_decision` 确认信息、展示草案并经用户确认保存；创建配置不会自动部署。
- `DeploymentService` 是流水线唯一状态所有者。Prepare 解析 Profile、固定当前 SSH 身份、探测受限远端命令能否启动、验证工作目录、远端可写目录与 Guard，持久化计划并等待用户确认。仅当探测明确返回 `sandbox_unavailable` 或 `sandbox_partial_enforcement` 时，计划改为 `full_access` 并为 RESTART 和可选 VERIFY 分别建立待人工审批的命令；其余探测、配置或连接错误仍直接失败。探测只是能力检查；受限命令的实际约束仍由派发时的启动确认决定。用户确认后创建带 `workflow=deployment_execution` 和 Deployment Run ID 的 Chat Run，ChatService 为本次 Run 注入可信计划，创建 Agent Runtime 后让 DeploymentService 重新校验 Profile、SSH 身份和审批并通过 SQLite 条件更新原子认领。模型逐阶段调用 `deployment_execute_next`，只提交阶段名；服务端锁定计划命令、路径和目标，验证顺序、绑定关系和实际权限后执行一个阶段。每阶段结果返回模型，模型判断后自动推进下一阶段；失败后不自动重试，模型可解释日志并在现有 Guard 与人工审批约束下诊断。变更部署命令或目标须准备新计划并重新经用户确认。`POST .../confirm` 已停用，返回 `deployment_agent_required`。
- SFTP 子系统不运行在 Landlock 启动器内；上传路径通过规范远端目录检查边界，不能将上传步骤表述为 Landlock 已约束。远端目录符号链接在检查和上传之间仍可能发生外部竞态。首版只支持单个普通文件产物；目录产物需由 Profile 的构建命令先打包。
- `deployment_runs` v23 保存计划、绑定的 Agent Run ID、开始时间、各阶段和 Full Access 人工决策快照，读取时校验 JSON 及阶段顺序；旧计划没有 `remoteAccess` 时按原有受限模式解释。进程重启将未确认的 preparing 计划取消并说明尚未开始执行，把 running 部署标记 failed、提示检查远端副作用；待决审批标记 rejected。`WorkspaceEventHub` 的 `deployments` topic 推送结构化快照；前端以有界游标分页读取历史部署，未确认计划用创建时间、已开始部署用认领时间与 Chat 消息合并回显，点击历史项可只读展开五阶段与日志。远端命令失败另保存退出码、失败代码、安全详情及命令记录 ID，供模型诊断和页面展开查看。关闭前端卡片不取消运行；取消会中止阶段并停止对应 Agent Run。
- 计划确认覆盖展示的固定构建、目标文件覆盖、重启与验证命令。Full Access 是另一个明确决策：用户须在部署卡片中逐条批准准确的 RESTART/VERIFY 命令，全部审批有效才可确认并启动整个流水线；普通计划确认、`autoAudit` 或 Chat 工具审批均不能代替它。单条审批须在五分钟内用于确认开始部署，过期可重新批准；拒绝会取消该部署。确认后授权在本次流水线运行期间有效，每条准确命令只能消费一次，结束时清理未使用授权，因此较长的 BUILD/UPLOAD 不会中途使已开始的部署失效。审批快照用 SQLite 条件更新，防止迟到的决定覆盖较新的状态。Guard 在实际执行时仍会复检，SSH 身份变化会拒绝执行；原受限命令执行失败后不会自动重放为 Full Access。

## 代码实现概要

### 两条入口

1. 用户在已有 Session 的 Composer 选择 /deploy。ChatConsole 调用 useDeployment.show，前端通过 GET /api/sessions/{sessionId}/deployments 读取当前主机、可用 Profile、解析错误和最近一次 Run。此时不创建 Agent Run，也不执行命令。新 Session 尚无固定的 Workspace/Session 上下文，入口显示为禁用。
2. 若有可用 Profile，用户选择 Profile 和模块，再调用准备接口。若没有，界面显示“创建部署配置”；点击后才创建带有 `deployment_setup` 标记的 Chat Run。ChatService 只给该 Run 的 system prompt 附加内置 Skill 与 Schema，不修改 Session 保存的基础 Prompt。Agent 按 Skill 检查项目、使用 ask_user_decision 解决未确定的信息，经用户明确同意后写入 Profile；配置生成与部署执行是两次独立操作。
3. 用户审阅计划并完成必要的 Full Access 逐条审批后，点击确认。前端以所选付费或本地模型创建 `deployment_execution` Chat Run，并传递准确的 Deployment Run ID。模型获得该次运行的计划和阶段快照；后端认领后模型可调用专用阶段工具，不会由确认接口直接循环执行整条流水线。

### 组件分工

| 层 | 状态和职责 | 后续调整位置 |
|---|---|---|
| Profile 与计划 | DeploymentProfile 定义可编辑的项目部署知识；DeploymentPlan 固定命令、路径、模块、Profile 摘要、SSH 目标身份与远端访问模式；DeploymentRun 保存阶段和 Full Access 决策状态。Markdown 正文只供人阅读，不参与执行。 | domain/deployment.ts、Skill 的 profile-schema.md |
| HTTP 边界 | deployment-routes.ts 解析发现、游标历史、准备、查看、逐条批准/拒绝和取消；Chat 创建请求校验 `deployment_execution` 与 Run ID 配对。旧确认接口明确拒绝绕开 Agent 的调用。 | api/deployment-routes.ts、api/request-validation.ts |
| 应用服务 | DeploymentService 是状态所有者，负责 Profile 发现、认领复核、严格阶段顺序、取消、日志与事件发布；SSH/SFTP/Sandbox/Guard 由注入的现有服务执行。ChatService 持有 Agent 生命周期，模型选择下一阶段；Chat 终态提交前必须先收敛部署状态。 | application/services/deployment-service.ts、application/services/chat-service.ts、application/services/chat-run-executor.ts、application/tools/deployment-agent-tool.ts |
| 持久化 | DeploymentRepository 隔离 SQLite。v23 deployment_runs 表保存完整快照和 Agent Run 绑定，SQLite 负责原子认领、按 Session 游标分页以及重启恢复。 | application/repositories/deployment-repository.ts、infrastructure/sqlite/sqlite-deployment-repository.ts、migrations.ts |
| 前端投影 | useDeployment 处理 REST、SSE、游标历史与当前面板状态；ChatTimeline 把部署记录按计划创建或实际认领时间与消息合并，历史可只读展开。DeploymentPanel 用细轨道和小状态点展示五阶段，仅运行中的点作遵守减少动态效果设置的轻微呼吸动画。上传来源和目标分行显示，完整日志按节点展开；Full Access 决策贴在对应远端节点。计划确认需要模型可用，服务端仍独立校验。 | features/deploy/api、model、runtime、components、features/chat/components/chat-timeline.tsx |
| 运行时装配 | create-sqlite-management-backend 将部署服务连接到当前 Session、Workspace、SSH 目标、沙箱、命令和 SFTP 服务，并在关闭时中止运行中的部署。 | runtime/create-sqlite-management-backend.ts |

部署 HTTP 接口集中在同一 Session 路径下；前端 deployment-api.ts 会在接收时校验响应结构和 Session ID。

| 方法与路径 | 作用 |
|---|---|
| GET /api/sessions/{sessionId}/deployments | 返回当前主机、有效 Profile、文件错误及最近一次 Run。 |
| GET /api/sessions/{sessionId}/deployments/history?limit=50&cursor=... | 按展示时间（认领时间、旧记录的打包开始时间或计划创建时间）及 ID 稳定倒序返回部署快照、`hasMore` 和不透明 `nextCursor`，供会话历史逐页加载。 |
| POST /api/sessions/{sessionId}/deployments | 提交 Profile 文件名和模块 ID，生成待确认计划。 |
| GET /api/sessions/{sessionId}/deployments/{runId} | 读取指定 Run 的持久化快照。 |
| POST /api/sessions/{sessionId}/deployments/{runId}/approvals/{stage}/{approvalId}/approve 或 /reject | 对准确的 restart/verify 命令作人工决定；拒绝会取消准备中的部署。 |
| POST /api/sessions/{sessionId}/chat/runs | 使用 `workflow=deployment_execution` 与 `deploymentRunId` 创建绑定模型的 Run；后端原子认领计划。 |
| POST /api/sessions/{sessionId}/deployments/{runId}/confirm | 旧入口返回 409 `deployment_agent_required`，不能绕开模型流程。 |
| POST /api/sessions/{sessionId}/deployments/{runId}/cancel | 取消准备中或运行中的部署。 |

### 从计划到执行

| 时点 | 具体代码行为 |
|---|---|
| 发现 Profile | 以 Session 的本地 workDir 为项目根；未设置时使用后端配置的 localCwd。只扫描其 .gori/deploy-*.md，要求 .gori 是实体目录、Profile 是普通文件，按 Profile 内的 target.host 与当前 Workspace 主机精确匹配。文件名不是可信目标身份。解析错误单独返回，避免让一份坏文件隐藏其他有效配置。 |
| 准备计划 | 解析 YAML front matter v1，限制整体大小、字段和模块数量；拒绝重复键、别名、未知字段、越界本地路径和非规范远端文件路径。解析模块后确认本地构建目录的 realpath 仍在项目内，获取当前 SSH 目标快照，探测受限远端命令能力。只有明确不可用或 ABI 不足才生成 Full Access 待审批计划；其他探测故障继续失败关闭。随后检查 SFTP 规范化的目标父目录在 Workspace 可写根内，并对重启/验证命令做 Guard 预检。成功后保存 status=preparing，准备阶段记 success，其余阶段 pending。 |
| Full Access 审批与用户确认 | 界面展示本地构建命令与目录、产物、会覆盖的远端文件、重启和验证命令。Full Access 计划另显示各远端命令的逐条批准/拒绝入口；没有预先批准就不能开始 BUILD/UPLOAD。批准五分钟内有效，过期需重新批准。用户确认会创建 Chat Run；ChatService 准备 Runtime 后调用 `claimForAgent`，重新读取 Profile 并比对 SHA-256、计划字段、本地目录、SSH 身份及审批有效期。SQLite 条件更新只允许 preparing 转 running，且同一 Workspace 同时最多一个 running 部署。 |
| 模型推进 | `deployment_inspect` 返回绑定计划与阶段事实，`deployment_execute_next({stage})` 只接受阶段名，Session、Agent Run、Deployment Run 都由服务端闭包绑定。DeploymentService 拒绝越序、重复副作用和其他 Agent；同一进行中阶段的并发调用共享任务。模型收到结构化结果后判断并自动调用下一阶段。普通部署 Run 中工具定义仍稳定，但无法执行部署阶段。 |
| BUILD | 在本机以计划中的工作目录启动 shell 命令，超时为 30 分钟。取消时终止子进程组；退出码必须为零，产物 realpath 必须仍在工作目录内且为普通文件。当前版本不会自动把目录打包。 |
| UPLOAD | 再核对 SSH 目标和远端目录；FileTransferService 创建 SFTP 上传任务，明确使用 overwrite=true。上传任务固定的目标身份与计划不一致时拒绝传输。阶段记录字节进度；只有传输状态 completed 才进入下一步。 |
| RESTART、VERIFY | 分别用 CommandOperationService.submit 派发 Profile 声明的远端命令，显式传入计划中的 `workspace_write` 或 `full_access`。Full Access 使用部署专属的一次性授权范围，和 Chat Run 身份分开；派发前后校验绑定的 SSH 身份，命令服务仍进行 Guard、沙箱准备与审计。受限命令还需启动器确认。非 completed 结果使阶段失败，并保留可公开的命令故障字段供模型诊断；未配置 verify 时记 skipped。 |
| 结束 | VERIFY 成功或按计划跳过后才记部署成功；失败或取消后停止后续阶段，清理未使用的 Full Access 授权，不自动回滚、重试或切换模式。模型提前结束、Run 取消和后端关闭均由 `finishAgent` 收敛部署状态，随后才提交 Chat Run 终态。若阶段写库失败，结算会读取最后持久化快照，将残留的运行中阶段标为失败并提示检查副作用；若结算仍无法落库，暂不提交 Chat 终态，下次 Session 访问重试原结算而不重跑模型。各阶段日志在服务端保留最近 128 KiB，工具结果仅返回限长尾部。 |

### 状态、刷新与取消

- Run 状态为 preparing、running、success、failed、cancelled；每个阶段独立使用 pending、running、success、failed、skipped。Full Access 决策另有 pending、approved、rejected 状态及批准时间/到期时间。后端每次保存快照后发布 deployment.updated，Workspace SSE 的 deployments topic 将更新推给当前 Session 的界面。
- 页面首次进入时读取最近一页部署记录，SSE 更新任意可见 Run，重连时用 REST 补齐；“加载更早”按不透明游标逐页读取。历史卡片与 Chat 消息按时间排列，展开历史卡片只读；`/deploy` 可打开最新计划的交互面板。关闭面板只改变浏览器显示状态。准备中取消通过 SQLite 条件更新完成；执行中取消阶段 AbortController 并联动停止 Chat Run，即使部署结算写库报错也会尝试停止对应 Chat Run。BUILD、UPLOAD、远端命令分别接收取消信号。
- 后端重启不能继续原来的进程、SFTP 或 SSH 命令，也不会恢复内存授权。启动时将未执行的 preparing 计划记为 cancelled；将已认领的 running 部署记为 failed，并提示检查可能发生的远端副作用。待决 Full Access 审批标为 rejected；不会重复执行之前的步骤。

### 安全边界和首版限制

- 本地 BUILD 运行在 Gori 服务所在机器，不受远端 Landlock 约束；用户在计划确认时会看到确切命令。远端 Landlock 能力探测也不代表命令已经受保护，RESTART/VERIFY 的实际启动确认才是约束生效的依据。
- UPLOAD 使用 SFTP，并非 Landlock 内的进程。当前代码用规范化远端目录限制目标范围，但检查与上传之间的目录符号链接仍有外部竞态。它不应被描述成 Landlock 保证的文件写入隔离。
- Full Access 只用于探测明确无法提供要求的 Landlock 约束时的 RESTART/VERIFY，不扩大 SFTP 上传根、不提升 SSH 用户权限；准备期间可发生能力探测和远端目录读取，但本地 BUILD 与 SFTP UPLOAD 必须等审批和计划确认完成才开始。运行中的受限命令失败不会触发事后自动升级。
- 部署 Agent Run 的普通 `bash`、`write`、`remote_server_call` 和 Terminal submit 即使启用 `autoAudit` 仍需逐次人工审批；SFTP Tool 和 Terminal 控制键在该 Run 内不可用，Terminal observe 可读。专用阶段工具不通过 Chat 普通审批来替代计划确认：它只执行后端固定计划并继续走原有 Guard、沙箱和 Full Access grant。模型可用受审批约束的普通工具诊断异常，但不能据此改写已认领的部署计划；修订命令、产物、目录或目标需要新计划。
- 本机 HTTP API 与 Agent 的本地 `bash` 进程处在同一用户权限边界，现有接口不能从请求本身强证明 Full Access 审批来自人的点击。部署 Agent Run 强制对本地命令逐次人工审批，但若普通 Run 启用了 `autoAudit`，本机进程仍可能直接请求本地接口。若未来需要对同机恶意 Agent 强隔离，必须重设计批准渠道和进程权限边界，单靠可被本机进程获取的前端令牌不足以证明用户意图。
- 当前仅部署到 Session 所属 Workspace 的 SSH 主机。connection.profile 是文档标签，不选择凭据；多份 Profile 可同时保存在项目中，跨 Workspace 主机选择尚未实现。
- 同一 Workspace 的部署认领互斥，即使由不同 Session 发起也不会并行执行。若用户将同一 SSH 主机保存为不同 Workspace，当前互斥不会跨 Workspace 生效；此类共享目标需要单独的主机/路径冲突策略。
- 产物只支持一个普通文件。没有目录递归上传、自动打包、回滚、版本切换或跨后端重启续跑。若这些能力加入，优先扩展 Profile/Plan 版本和 DeploymentService 的阶段协议，并同步数据库及前端响应校验，避免只修改界面或 Skill。

### 常见改动从哪里开始

| 要改的行为 | 首先检查 |
|---|---|
| 新增 Profile 字段或部署模块选项 | domain/deployment.ts 的解析与类型、Skill Schema、前端 Plan 展示、确认时的字段复核和两个边界校验测试。 |
| 更改步骤或加入回滚 | DEPLOY_STAGES、DeploymentService.executeStageForAgent/stage、deployment-agent-tool、DeploymentRun 快照校验、前端 DEPLOY_STAGES 与阶段卡片、重启恢复策略。 |
| 支持另一台已保存主机 | Workspace/Session 目标绑定和凭据选择规则、Profile target 校验、计划确认、传输固定目标校验；不能仅放宽前端 Profile 过滤。 |
| 更改沙箱或审批规则 | DeploymentService 的能力探测、审批状态/有效期与 CommandOperationService.submit，RemoteSandboxApprovalStore 的一次性 grant；实际约束和 Guard 仍由命令服务负责，SFTP 需单独设计边界。 |
| 更改页面呈现或恢复 | useDeployment、DeploymentPanel、DeploymentHistoryCard、conversationHistory、ChatTimeline、ChatConsole；服务端 Run 快照仍应保持唯一可信状态。 |

## 入口与所有者

| 关注点 | 代码位置 |
|---|---|
| Profile v1、计划、阶段领域类型 | `packages/ssh-agent/src/domain/deployment.ts` |
| 流水线状态、校验、构建、上传与命令编排 | `packages/ssh-agent/src/application/services/deployment-service.ts` |
| 绑定 Agent 的阶段工具与 Chat 工作流 | `packages/ssh-agent/src/application/tools/deployment-agent-tool.ts`、`packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/application/services/chat-run-executor.ts`、`packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts` |
| 持久化端口、SQLite 实现与 v23 迁移 | `packages/ssh-agent/src/application/repositories/deployment-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-deployment-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| HTTP 校验、运行时装配、Workspace SSE | `packages/ssh-agent/src/api/deployment-routes.ts`、`packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts`、`packages/ssh-agent/src/application/workspace-event-hub.ts` |
| 首次配置 Skill 与 Schema | `packages/ssh-agent/resources/skills/gori-deployment-spec/SKILL.md`、`packages/ssh-agent/resources/skills/gori-deployment-spec/references/profile-schema.md` |
| `/deploy` 入口、API 校验、恢复、流水线 UI | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/deploy/` |
| 定向回归 | `packages/ssh-agent/test/deployment-profile.test.ts`、`packages/ssh-agent/test/deployment-service.test.ts`、`packages/ssh-agent/test/deployment-routes.test.ts`、`packages/ssh-agent-web/tests/deployment-model.test.ts`、`packages/ssh-agent-web/tests/deployment-panel.test.tsx` |
