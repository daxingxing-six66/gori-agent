# `/deploy` 代码路由

适用于当前 Session 的模型驱动部署、Deployment Profile、首次配置 Skill、阶段安全边界和会话历史回显。

## 当前行为

- `/deploy` 是已有 Session 的 Composer 工具入口，菜单标题按语言显示“部署”或“deploy”；新 Session 创建前显示禁用入口。每次主动选择入口都从空白模块选择开始，不选中上次的部署记录，也不向 Agent 发送自由执行部署的 Prompt。首版只扫描 Session 本地工作目录的 `.gori/deploy-*.md`，只展示 `target.host` 与当前 Workspace SSH 主机一致的 Profile；文件可保留其他主机的 Profile，但运行时不会跨 Workspace 选择主机或凭据。
- Profile 是 Markdown + YAML front matter。v2 的模块记录服务工作目录、构建/重启/验证说明和允许上传的远端目录；它提供稳定知识，不固定本次要构建的命令和 jar 清单。旧 v1 的单产物字段继续可读。后端严格校验版本、相对本地目录、规范绝对远端目录、大小和未知字段；`.gori` 与 Profile 文件不能是符号链接。`connection.profile` 仅供显示，不作为凭据查找键。缺少 Profile 时，Chat Run 临时加载包内 `gori-deployment-spec` Skill，Agent 使用 `ask_user_decision` 确认缺失信息，向用户展示草案并经同意后保存；创建配置不会自动部署。
- 选择服务只开启持久化的部署讨论，不创建 Deployment Run，也不展示尚无实际参数的五阶段流水线。讨论与 Session、Profile、模块及当前目标绑定，允许跨多个 Chat Run 延续；每轮模型请求由 ChatService 从服务端讨论状态注入可信的 `<deployment-mode-on>` 指引，普通无讨论请求注入 `<deployment-mode-off>`。模型检查当前项目、Git 变化与模块依赖，可通过 `ask_user_decision` 或普通文字与用户澄清；一次回复没有提交计划时，讨论仍可继续。信息齐备后，模型调用 `deployment_propose_plan` 提交本次准确的 1–8 个本地构建步骤、1–16 个普通文件产物及各自远端目标、重启命令和可选验证命令；重启/验证可分别声明已知远端写入路径 `writePaths`。`DeploymentService` 校验本地路径、Profile 允许目录、Workspace 远端根、当前 SSH 身份和 Guard，逐条探测远端沙箱并冻结执行模式；模型调用本身不构建、上传或批准沙箱例外。服务按 planning Agent Run ID 和提案摘要去重，SQLite v24 唯一索引防止竞争写入。旧 Plan v1 无版本字段，保留历史读取；旧 Profile v1 仍可用于规划，其 `upload.target` 的父目录是允许上传的范围。
- 用户核对完整提案，并仅对需要 Full Access 的远端命令批准标记为 `remote_sandbox_exception` 的例外后，才创建 `workflow=deployment_execution` 的 Chat Run。ChatService 注入已确认计划，DeploymentService 复核 Profile、SSH 身份和例外审批并经 SQLite 条件更新原子认领。模型调用 `deployment_execute_next` 逐阶段推进，只能提交阶段名；受限命令按当前 `autoAudit` 自动或逐条人工批准，但批准后仍在沙箱内执行。服务端锁定本次计划的命令、产物、目录和目标，复检顺序与权限。Plan v2 阶段失败后进入 `recovering`，保留已完成阶段和失败尝试；模型可在当前 Run 或新的 `deployment_recovery` Run 中检视结果，用 `deployment_propose_recovery` 仅提出失败阶段的修订。用户比较前后方案并确认后，服务更新有效计划版本，重置失败阶段，只有仍需 Full Access 的未完成命令需要新的例外审批，再用新的执行 Run 从该阶段继续。拒绝提案可继续讨论；没有自动重试。旧 Plan v1 仍按原逻辑结束为 failed。旧 `POST .../confirm` 返回 `deployment_agent_required`。
- SFTP 子系统不在 Landlock 启动器内；上传要通过规范远端目录与 Profile 允许目录检查，不能称为 Landlock 保护。远端目录符号链接在检查和上传之间仍可能发生外部竞态。可上传多个普通文件，不支持目录递归上传；目录产物要在本次构建步骤中先打包。
- `deployment_runs` v23 保存计划、执行 Agent Run、阶段与 Full Access 决策快照；v24 为规划 Agent Run 建立唯一索引；v25 单独保存部署讨论和其每轮 Chat Run 绑定；v26 允许 `recovering` 状态。快照保留初始计划、当前修订版、各阶段尝试、修订提案及历次绑定的 Agent Run，旧记录的可选字段保持兼容。SQLite 读取时校验 Discussion 和 Plan v1/v2、审批、阶段顺序及修订链；旧计划没有 `remoteAccess` 时按原有受限模式解释。重启时讨论与已落库的待修复提案可继续；未确认计划取消，正在运行的部署记失败并提示检查远端副作用，不自动续跑。`WorkspaceEventHub` 的 `deployments` topic 分别发布 `deployment.discussion.updated` 与 `deployment.updated`；前端部署功能独立订阅，刷新用 REST 补齐，历史按创建时间和 ID 稳定分页。关闭卡片不取消讨论或运行；取消讨论会使其后续提案失效，取消执行会中止阶段及对应执行 Run。
- RESTART/VERIFY 各有冻结的 `access`：有效 Landlock/Bubblewrap 且已声明写入路径均在允许范围内时使用 `workspace_write`；脚本未声明的副作用由实际沙箱约束。沙箱不可用或已声明写入路径越界时使用 `full_access`，生成带 `remote_sandbox_exception` 工具名、原因和准确命令的人工审批；`autoAudit` 不会批准例外。批准须在五分钟内用于启动，过期可重批；启动后每条授权只用于本次流水线中的准确命令一次，结束时清理。若原先因沙箱不可用获批，认领和命令派发前都会重新探测；能力已变化则拒绝旧例外，要求重新审阅计划。受限命令失败不会自动以 Full Access 重放，须诊断、提出修订并重新获人工审批。Guard 在实际执行时复检，SSH 身份变化会拒绝执行。历史计划缺少逐阶段 `access` 时继续按其原有 `remoteAccess` 执行。

## 代码实现概要

### 从选择服务到执行

1. 用户在已有 Session 的 Composer 选择 /deploy。ChatConsole 调用 useDeployment.show，前端通过 GET /api/sessions/{sessionId}/deployments 读取当前主机、可用 Profile 和解析错误；接口仍返回最近一次 Run 供会话恢复使用，但这次主动唤起不选中它。此时不创建 Agent Run，也不执行命令。新 Session 尚无固定的 Workspace/Session 上下文，入口显示为禁用。
2. 若有 Profile，面板汇总可选模块。用户选中模块后，服务端开启部署讨论，随后启动首轮 `deployment_planning` Chat Run。讨论期间，所选服务与讨论状态卡片按 Discussion 的创建时间插入 Chat 时间线，先显示卡片，再在其下方显示首轮及后续讨论消息；切换 Session 后仍按持久化创建时间重建顺序。尚未选定模块的选择面板仍位于时间线末尾。模型可进行多轮检索、提问和普通聊天回复，每一轮都由持久化讨论重新绑定 Profile、模块和提案工具。模型调用 `deployment_propose_plan` 并通过后端校验后，才产生待确认的 Deployment Run 和五阶段计划卡片。前端从 `deployment.discussion.updated` 与 `deployment.updated` SSE 获取状态和计划；规划时不构建、上传或执行远端命令。若没有 Profile，界面提供“创建部署配置”；用户点击后才创建 `deployment_setup` Chat Run，按内置 Skill 与 Schema 生成配置。配置生成和本次发布是独立操作。
3. 用户核对计划和每个产物目标，仅完成沙箱例外命令的逐条 Full Access 审批，再点击“开始部署”。前端分别读取 RESTART/VERIFY 的 `access`，只为 `full_access` 阶段显示例外原因、审批按钮和有效期；旧计划没有逐阶段 `access` 时回退到 `remoteAccess`。前端创建携带 Deployment Run ID 的 `deployment_execution` Chat Run；后端认领后模型才可调用专用阶段工具。沙箱内 RESTART/VERIFY 由当前自动/手动审批模型决定，手动批准不改变沙箱模式。失败时卡片留在同一历史位置，模型提出局部修订，用户确认后创建新的执行 Run 继续；已完成阶段不会重做。全部阶段完成后，执行指引要求模型在最终回复中概述实际部署和验证结果；成功结算后，该回复作为普通 Assistant 消息显示在部署卡片之后的主时间线。

### 组件分工

| 层 | 状态和职责 | 后续调整位置 |
|---|---|---|
| Profile、讨论与计划 | DeploymentProfile v2 定义可编辑的部署知识；DeploymentDiscussion 冻结选定的 Profile、模块和目标身份；DeploymentPlan v2 记录本次发布的准确步骤、产物、命令和权限模式。DeploymentRun 持有唯一的执行状态、修订链、尝试结果和 Agent Run 历史；v1 继续用于旧数据。Markdown 正文只供人阅读。 | domain/deployment.ts、Skill 的 profile-schema.md |
| HTTP 边界 | deployment-routes.ts 处理 Profile 发现、Discussion 创建/取消/恢复、计划历史/查看、逐条 Full Access 审批、修订确认/拒绝与取消；旧 v1 的直接准备接口仍兼容。Chat 创建请求校验 planning、execution、recovery 各自的绑定 ID，旧确认接口拒绝绕过 Agent。 | api/deployment-routes.ts、api/request-validation.ts |
| 应用服务 | DeploymentService 持有讨论、部署和恢复的状态，校验模型提案、认领复核、阶段顺序、局部修订、取消、日志与事件。参数校验集中于 deployment-plan-proposal.ts 和 deployment-recovery-proposal.ts。ChatService 从持久化状态注入对应工作流指引；模型只能提出待审修订，不能自行批准或越过阶段工具执行。 | application/deployment-plan-proposal.ts、application/deployment-recovery-proposal.ts、application/services/deployment-service.ts、application/services/chat-service.ts、application/tools/deployment-agent-tool.ts |
| 持久化 | DeploymentDiscussionRepository 单独保存讨论及每轮 Run 绑定；DeploymentRepository 保存计划、修订和阶段。v26 扩充运行状态约束；SQLite 用条件更新时间实现待修复提案与确认的并发控制，校验完整修订链、历史分页与重启恢复。 | application/repositories/deployment-discussion-repository.ts、application/repositories/deployment-repository.ts、infrastructure/sqlite/sqlite-deployment-repository.ts、migrations.ts |
| 前端投影 | useDeployment 独立处理 REST、`deployment.updated` SSE、讨论、历史与当前选择。DeploymentPanel 默认只显示服务、进度、阶段状态与故障，命令、产物路径、日志、尝试历史及主机指纹按需展开；各级展开入口使用统一的文字、向下箭头与键盘焦点样式。前端按 RESTART/VERIFY 各自的沙箱模式投影例外审批并校验计划，允许两阶段混合 `workspace_write`/`full_access`；修订先展示差异再提供人工确认。绑定的规划、执行和诊断过程归入原部署卡片；仅成功部署的最新执行 Run 的最终文字回复留在主时间线。展开的模型记录最高 34rem，超出后内部滚动。Chat SSE 仍按原链路解析，前端只投影已持久化消息，不复制或改写消息。 | features/deploy/api、model、runtime、components、features/chat/components/chat-timeline.tsx |
| 运行时装配 | create-sqlite-management-backend 将部署服务连接到当前 Session、Workspace、SSH 目标、命令审批和 SFTP 服务，并在关闭时中止运行中的部署。 | runtime/create-sqlite-management-backend.ts |
| 远端命令执行 | CommandOperationService 保留 FIFO 后的执行顺序与结果分类；CommandExecutionPolicy 复核 Guard、消费部署专属 grant 并检查目标/cwd；CommandOperationRecorder 保存命令状态、输出和沙箱事实。submit 契约与部署阶段结算保持兼容，不把部署 grant 改为普通 Chat 授权。 | application/services/command-operation-service.ts、application/services/command-execution-policy.ts、application/services/command-operation-recorder.ts |

部署 HTTP 接口集中在同一 Session 路径下；前端 deployment-api.ts 会在接收时校验响应结构和 Session ID。

| 方法与路径 | 作用 |
|---|---|
| GET /api/sessions/{sessionId}/deployments | 返回当前主机、有效 Profile、文件错误、活动讨论及最近一次 Deployment Run。 |
| POST /api/sessions/{sessionId}/deployments/discussions | 选定 Profile 和模块后创建新讨论；旧活动讨论转为 cancelled，尚不创建 Deployment Run。 |
| GET /api/sessions/{sessionId}/deployments/discussions/active | 单独获取当前 discussing 的讨论或 null，供刷新后恢复。 |
| GET /api/sessions/{sessionId}/deployments/discussions/{discussionId} | 按 Session 和 ID 读取历史讨论快照。 |
| POST /api/sessions/{sessionId}/deployments/discussions/{discussionId}/cancel | 结束仍在 discussing 的讨论；不能取消已经提出的 Deployment Run。 |
| GET /api/sessions/{sessionId}/deployments/history?limit=50&cursor=... | 按计划创建时间及 ID 稳定倒序返回部署快照、`hasMore` 和不透明 `nextCursor`，供会话历史逐页加载；后续认领不会让记录越过分页游标。 |
| POST /api/sessions/{sessionId}/deployments | 旧 v1 Profile 的直接准备兼容入口；v2 须由模型规划工具提交。 |
| GET /api/sessions/{sessionId}/deployments/{runId} | 读取指定 Run 的持久化快照。 |
| POST /api/sessions/{sessionId}/deployments/{runId}/approvals/{stage}/{approvalId}/approve 或 /reject | 仅对需要沙箱例外的准确 restart/verify 命令作人工决定；拒绝会取消准备中的部署。 |
| POST /api/sessions/{sessionId}/deployments/{runId}/recovery/{proposalId}/approve 或 /reject | 对当前失败阶段的修订提案作决定；重复相同决定幂等，冲突决定拒绝。批准后仍需例外的未完成远端命令须重新审批。 |
| POST /api/sessions/{sessionId}/chat/runs | 首轮 `deployment_planning` 携带 Discussion ID；后续普通用户消息也会自动绑定活动 Discussion。`deployment_execution` 携带 Deployment Run ID 原子认领计划；`deployment_recovery` 携带同一个 ID 绑定失败状态，只能检视与提出修订。 |
| POST /api/sessions/{sessionId}/deployments/{runId}/confirm | 旧入口返回 409 `deployment_agent_required`，不能绕开模型流程。 |
| POST /api/sessions/{sessionId}/deployments/{runId}/cancel | 取消准备中或运行中的部署。 |

### 从计划到执行

| 时点 | 具体代码行为 |
|---|---|
| 发现 Profile | 以 Session 的本地 workDir 为项目根；未设置时使用后端配置的 localCwd。只扫描其 .gori/deploy-*.md，要求 .gori 是实体目录、Profile 是普通文件，按 Profile 内的 target.host 与当前 Workspace 主机精确匹配。文件名不是可信目标身份。解析错误单独返回，避免让一份坏文件隐藏其他有效配置。 |
| 模型讨论、规划与冻结 | 选择模块建立服务端部署讨论；`deployment_planning` 可跨多个 Chat Run，普通文字追问导致本轮结束时不会结束讨论。ChatService 每轮从讨论绑定 Profile 和当前项目根，注入 `<deployment-mode-on>` 并开放提案工具；模型检索项目/Git/依赖后调用 `deployment_propose_plan`。工具参数是相对项目根的 build workdir、构建命令、各产物 source、绝对远端 target，以及准确 restart/verify 命令与可选 `writePaths`。服务限制 1–8 步、1–16 个普通文件目标和每条命令最多 16 个声明路径，验证目录、重名目标、Profile 允许目录、Workspace 根、SSH 快照和 Guard。读态沙箱探测决定每条命令的 `access`；未知脚本写入不按字符串猜测，先受限执行。成功后持久化 v2 Plan 与规划 Run ID/提案摘要，阶段为 prepare 成功、其余 pending；讨论和规划不会产生部署副作用。 |
| 沙箱例外审批与用户确认 | 界面展示构建步骤、所有会覆盖的远端文件、重启与验证命令。只有沙箱不可用或已声明写入路径超界的远端命令生成 `remote_sandbox_exception` 人工审批；没有必要的预批就不能开始 BUILD/UPLOAD。例外批准五分钟内有效，过期重批。用户确认创建执行 Chat Run，`claimForAgent` 重新读取 Profile 并比对 SHA-256、计划路径、SSH 身份和审批有效期。SQLite 条件更新只允许 preparing 转 running，同一 Workspace 最多一个 running 部署。 |
| 模型推进 | `deployment_inspect` 返回绑定计划与阶段事实，`deployment_execute_next({stage})` 只接受阶段名，Session、Agent Run、Deployment Run 都由服务端闭包绑定。DeploymentService 拒绝越序、重复副作用和其他 Agent；同一进行中阶段的并发调用共享任务。失败后模型可读日志并调用 `deployment_propose_recovery` 提交当前版本、失败阶段、原因与修订参数；服务端再次校验路径、目标和权限，修订不产生部署副作用。 |
| BUILD | 在本机顺序运行已确认的 1–8 个 shell 构建步骤，各步限时并可取消；失败立即停止。所有计划上传的产物 realpath 必须仍在项目内且为普通文件，不自动把目录打包。 |
| UPLOAD | 对计划中的 1–16 个产物逐个复核 SSH 目标、Profile 允许目录和 Workspace 远端根，以 SFTP `overwrite=true` 上传；目标身份不符或任一传输失败即停止。阶段记录累计字节进度；全部 completed 才进入重启。 |
| RESTART、VERIFY | 分别用 CommandOperationService.submit 派发本次 Plan 冻结的远端命令与逐阶段模式。有可用沙箱且已声明写入路径在根内时用 `workspace_write`；无需 Full Access 例外，`autoAudit=false` 时 `deployment_execute_next` 的远端阶段经普通 Chat 工具人工审批后仍在沙箱内执行。只有标记过并获批准的例外才用 `full_access` 与部署专属一次性授权。命令服务仍进行 Guard、授权校验与审计。非 completed 结果使阶段失败并保留可公开故障字段；未配置 verify 时记 skipped。历史 `deployment_policy` 计划保留原有 `cwd=/`。 |
| 结束与恢复 | VERIFY 成功或按计划跳过后才记部署成功；Plan v2 的阶段失败记为 `recovering`，后续阶段停止，释放当前一次性授权。用户可让模型诊断，确认局部修订后从失败阶段继续；此前成功阶段保持原结果。Plan v1、取消、Agent 提前结束及运行时后端重启仍可能成为终态，不自动回滚或重试。若阶段写库失败，结算读取最后持久化快照并提示检查副作用；若结算仍无法落库，暂不提交 Chat 终态。各阶段日志保留最近 128 KiB，工具结果只返回限长尾部。 |

### 状态、刷新与取消

- 部署讨论与 Deployment Run 是不同生命周期：Discussion 状态为 discussing、proposed、cancelled；讨论中没有可执行阶段，模型的普通文字追问结束一轮 Chat Run 后仍可继续讨论。每轮规划 Run 绑定时 Discussion revision 递增，提案原子转为 proposed 并创建 Deployment Run。Deployment Run 状态为 preparing、running、recovering、success、failed、cancelled；阶段状态为 pending、running、success、failed、skipped。修订提案为 pending、approved、rejected，最多保存 64 个；单阶段尝试最多 64 次。待决提案不会被另一个修复 Run 覆盖；批准后生成新计划版本并使旧阶段授权失效。Workspace SSE 的 `deployments` topic 发布 `deployment.discussion.updated` 和 `deployment.updated`，Chat 消息仍走原有 Chat SSE 链路。
- 页面首次进入时读取活动讨论与最近一页部署记录；活动讨论可在刷新后恢复并打开，`deployment.discussion.updated` 更新讨论状态，`deployment.updated` 更新任意可见 Run，重连时用 REST 补齐；“加载更早”按不透明游标逐页读取。讨论卡按 Discussion 创建时间与 Chat 消息合流，同毫秒时卡片排在消息前；历史部署卡也按时间排列，展开历史卡片只读。主动选择 `/deploy` 始终进入新的模块选择，不跳转或复用旧记录。此时旧讨论仍有效，直到用户选中新服务后创建新讨论并取消旧讨论。关闭面板只改变浏览器显示状态。取消或替换讨论时，先通过 SQLite 条件更新使后续提案无效，再尽力取消其最新绑定的 Chat Run；取消 Run 失败不会恢复已失效讨论。准备中的部署取消通过条件更新完成。执行中取消阶段 AbortController 并联动停止 Chat Run，即使部署结算写库报错也会尝试停止对应 Chat Run。BUILD、UPLOAD、远端命令分别接收取消信号。
- 后端重启不能继续原来的进程、SFTP 或 SSH 命令，也不会恢复内存授权。启动时将未执行的 preparing 计划记为 cancelled；将已认领的 running 部署记为 failed，并提示检查可能发生的远端副作用。已在 `recovering` 的修订提案保持可审阅，但未执行远端阶段的旧 Full Access 批准会换成新的待批请求；不会重复执行之前的步骤。

### 安全边界和首版限制

- 本地 BUILD 运行在 Gori 服务所在机器，不受远端沙箱约束；用户在计划确认时会看到确切命令。新部署计划的 RESTART/VERIFY 默认先探测 Landlock/Bubblewrap 并在有完整约束时使用沙箱；模型声明的 `writePaths` 只用于已知目标的预判，不能证明脚本没有其他副作用。执行时沙箱拒绝会使阶段失败，服务不会自动升级权限重放。
- UPLOAD 使用 SFTP，并非 Landlock 内的进程。当前代码用规范化远端目录限制目标范围，但检查与上传之间的目录符号链接仍有外部竞态。它不应被描述成 Landlock 保证的文件写入隔离。
- Full Access 仅用于本次部署计划中的 RESTART/VERIFY 沙箱例外，不扩大 SFTP 上传根、不提升 SSH 用户权限；准备期间可发生远端目录读取，但本地 BUILD 与 SFTP UPLOAD 必须等必要例外审批和计划确认完成才开始。例外在快照中带 `remote_sandbox_exception` 与原因；恢复修订只重批仍未完成且需要例外的命令。历史计划缺少逐阶段 `access` 时继续使用其 `remoteAccess` 与原有 `deployment_policy` 等原因。
- 部署规划、执行和修复 Run 的普通本地 `bash`、`write`、Terminal submit 与受限 `remote_server_call` 都按当前 `autoAudit` 自动或逐次人工批准；后两者仍走各自的远端预检与沙箱路由，Full Access 例外始终要求单独的人工决定。SFTP Tool 和 Terminal 控制键在部署 Run 内不可用，Terminal observe 可读。规划与修复工具只提交候选计划，阶段工具只执行用户确认的当前版本；均不能代替沙箱例外人工决定。模型可用受审批约束的普通工具诊断异常；失败后的新命令、产物与目标须经局部修订提案和用户确认。部分上传、重启等远端副作用可能已发生，确认重试前应检查实际状态。
- 本地 `bash` 在 Gori 服务所在机器执行，与右侧远端 Terminal 的 Landlock/Bubblewrap 沙箱无关；开启 `autoAudit` 会允许部署 Run 中的普通本地 Shell 命令自动执行，不能从命令文本可靠判定其只读。本机 HTTP API 与该进程处在同一用户权限边界，现有接口不能从请求本身强证明 Full Access 审批来自人的点击。若未来需要对同机恶意 Agent 强隔离，必须重设计批准渠道和进程权限边界，单靠可被本机进程获取的前端令牌不足以证明用户意图。
- 当前仅部署到 Session 所属 Workspace 的 SSH 主机。connection.profile 是文档标签，不选择凭据；多份 Profile 可同时保存在项目中，跨 Workspace 主机选择尚未实现。
- 同一 Workspace 的部署认领互斥，即使由不同 Session 发起也不会并行执行。若用户将同一 SSH 主机保存为不同 Workspace，当前互斥不会跨 Workspace 生效；此类共享目标需要单独的主机/路径冲突策略。
- 本次最多 8 个构建步骤、16 个普通文件产物；没有目录递归上传、自动打包、回滚、版本切换或跨后端重启续跑。新增能力要同步调整 Profile/Plan、DeploymentService 阶段协议、SQLite 与前端响应校验。

部署 Run 的工具冲突由 Runtime Factory 装配到各工具入口：SFTP、Bubblewrap 安装/检查和 Terminal 控制键在审批前拒绝，也保护直接执行调用。`deployment-agent-tool.ts` 的 `prepareDeploymentStageAuthorization` 负责受限 RESTART/VERIFY 的普通审批方案；授权策略只分发并提供当前 `autoAudit` 与 Deployment Run ID。已知请求错误交回模型，阶段顺序、目标、确认版本与专属 Full Access 授权仍由 DeploymentService 校验。

### 常见改动从哪里开始

| 要改的行为 | 首先检查 |
|---|---|
| 新增 Profile 字段或部署模块选项 | domain/deployment.ts 的解析与类型、Skill Schema、前端 Plan 展示、确认时的字段复核和两个边界校验测试。 |
| 改变讨论与提案衔接 | DeploymentDiscussion 的状态、bindPlanningRun 与 proposeForDiscussion 的 CAS、ChatService 的 Run 级模式指引、HTTP/SQLite 边界及刷新恢复；不能只调整模型提示词或前端卡片。 |
| 更改步骤或加入回滚 | DEPLOY_STAGES、DeploymentService.executeStageForAgent/stage、deployment-agent-tool、DeploymentRun 快照校验、前端 DEPLOY_STAGES 与阶段卡片、重启恢复策略。 |
| 支持另一台已保存主机 | Workspace/Session 目标绑定和凭据选择规则、Profile target 校验、计划确认、传输固定目标校验；不能仅放宽前端 Profile 过滤。 |
| 更改沙箱或审批规则 | DeploymentService 的逐阶段 `access`、共享 remote-sandbox-routing 探测、deployment-agent-tool 的阶段审批准备与 ChatToolAuthorizationPolicy 分发、例外状态/有效期与 CommandOperationService.submit，RemoteSandboxApprovalStore 的一次性 grant；SFTP 需单独设计边界。 |
| 更改页面呈现或恢复 | useDeployment、DeploymentPanel、DeploymentHistoryCard、conversationHistory、ChatTimeline、ChatConsole；服务端 Run 快照仍应保持唯一可信状态。 |

## 入口与所有者

| 关注点 | 代码位置 |
|---|---|
| Profile v1/v2、Plan v1/v2、阶段领域类型 | `packages/ssh-agent/src/domain/deployment.ts` |
| 模型初始计划与局部修订的参数校验 | `packages/ssh-agent/src/application/deployment-plan-proposal.ts`、`packages/ssh-agent/src/application/deployment-recovery-proposal.ts` |
| 流水线状态、校验、构建、上传与命令编排 | `packages/ssh-agent/src/application/services/deployment-service.ts` |
| 绑定 Agent 的阶段工具与 Chat 工作流 | `packages/ssh-agent/src/application/tools/deployment-agent-tool.ts`、`packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/application/services/chat-run-executor.ts`、`packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts` |
| 持久化端口、SQLite 实现与 v23–v26 迁移 | `packages/ssh-agent/src/application/repositories/deployment-discussion-repository.ts`、`packages/ssh-agent/src/application/repositories/deployment-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-deployment-discussion-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-deployment-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| HTTP 校验、运行时装配、Workspace SSE | `packages/ssh-agent/src/api/deployment-routes.ts`、`packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts`、`packages/ssh-agent/src/application/workspace-event-hub.ts` |
| 首次配置 Skill 与 Schema | `packages/ssh-agent/resources/skills/gori-deployment-spec/SKILL.md`、`packages/ssh-agent/resources/skills/gori-deployment-spec/references/profile-schema.md` |
| `/deploy` 入口、API 校验、恢复、模块选择与流水线 UI | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/deploy/runtime/use-deployment.ts`、`packages/ssh-agent-web/features/deploy/components/deployment-module-picker.tsx`、`packages/ssh-agent-web/features/deploy/components/deployment-panel.tsx` |
| 定向回归 | `packages/ssh-agent/test/deployment-profile.test.ts`、`packages/ssh-agent/test/deployment-discussion.test.ts`、`packages/ssh-agent/test/deployment-service.test.ts`、`packages/ssh-agent/test/deployment-routes.test.ts`、`packages/ssh-agent/test/chat-service-lifecycle.test.ts`、`packages/ssh-agent-web/tests/deployment-model.test.ts`、`packages/ssh-agent-web/tests/deployment-panel.test.tsx`、`packages/ssh-agent-web/tests/use-deployment-selection.test.ts`、`packages/ssh-agent-web/tests/use-deployment-races.test.ts` |
