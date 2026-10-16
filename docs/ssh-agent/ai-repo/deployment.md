# `/deploy` 代码路由

适用于 Deployment Profile、Session 部署模式、模型规划与修订、阶段执行、日志和右侧 Deploy Tab。重构依据及逐项验收见 [Deploy 重构实现依据](../design/deploy-refactor.md) 第 16–17 节。本次范围已经实现并完成 macOS 本地构建、Linux 目标和授权模型的真实交互验收；跨平台及不同沙箱后端的实际执行范围分别说明。

## 身份、事实与入口

- `/deploy` 只是打开功能页面。没有活动模式时展示模块选择；有活动模式时定位当前任务。浏览配置不创建部署或运行模型。缺少服务时，即使已有其他 Profile，仍可从“添加服务配置”进入配置讨论；保存 Profile 不自动发布。
- Profile 从 Session 本地 `workDir`（未配置时为后端 `localCwd`）的 `.gori/deploy-*.md` 发现。只显示 `target.host` 与 Workspace 主机相符的文件；错误独立返回。`.gori` 必须是实体目录，Profile 必须是普通文件。`connection.profile` 是文档标签，不选择凭据。
- Profile v2 保存长期构建/重启/验证知识和允许上传目录；本次 Plan v2 固定准确的 1–8 个本地构建步骤、1–16 个普通文件产物及远端目标、重启和可选验证命令。构建目录和产物 source 是相对项目根的模型输入，冻结为规范绝对路径。远端命令可声明最多 16 个 `writePaths`。Profile/Plan v1 保持兼容读取。
- 选择服务后创建稳定部署 ID：新 Discussion、Session 模式和正式历史消息同事务提交；后续 Run 沿用 Discussion ID。`deployment_sessions` 只保存身份、活动绑定和终态，`deployment_runs` 仍是计划与当前阶段事实来源。每个 Session 只有一个活动部署，同一 Workspace 仍只允许一个 running 部署。
- 正式消息位于 `chat_messages`，`message_type=deployment`、`customType=deployment`，按 Session sequence 排序，持有稳定 ID/标题。`deployment.message.created` 发布实际持久化消息，REST 历史和 SSE 通过相同消息 ID/sequence 去重。它是 UI 元数据，在模型与压缩投影中过滤，不能变成 user 指令。

## 从讨论到明确结束

1. 用户选定服务，开启 Session 部署模式，并启动首轮 `deployment_planning` Chat Run。后续普通用户消息由后端当前绑定决定讨论、待审、执行或诊断用途，不由 Tab 是否打开决定。
2. 模型检查项目与变更，用普通文字或 `ask_user_decision` 补充信息，通过 `deployment_propose_plan` 提交准确参数。后端复核路径、Profile hash、目标身份、Guard 和逐命令沙箱来源；提案本身没有构建、上传、重启副作用。
3. 中间 Agent 会话中的 `DeploymentReview` 展示完整计划、修订差异及必要的人工 Full Access 例外。用户确认后创建 `deployment_execution` Run，服务原子认领；旧 `POST .../confirm` 仍拒绝绕开 Agent。
4. 模型使用 `deployment_execute_next({stage})` 串行推进。成功后检查结果；失败后模式保持，允许诊断、重试原命令或提交修订。模型一轮结束、失败或取消不会自动结束新部署。
5. 用户通过结束接口取消，或模型通过 `deployment_finish` 明确成功/失败结束。成功须核验全部必要阶段；失败必须给原因。统一用例先收敛当前操作，再同事务保存最终 Run 与模式终态。竞争时首个终态获胜，结算失败保留原请求重试，不重放阶段。迟到请求不能恢复模式。
6. VERIFY 成功或合法 skipped 后仍等明确结束。最终结论由模型在中间 Agent 会话输出。

Discussion 状态为 discussing/proposed/cancelled；Run 状态为 preparing/running/recovering/success/failed/cancelled；阶段为 pending/running/success/failed/skipped。已批准修订只有在当前没有新失败时才表示等待继续；修订后再次失败会重新进入可诊断路径，不能被历史 approved 状态锁住。

## 阶段执行和重做

| 阶段 | 执行事实与边界 |
|---|---|
| prepare | 初始计划通过校验；尚无计划的讨论不伪造执行进度。 |
| build | `deployment-local-build.ts` 通过现有 `NodeExecutionEnv` 与 `executeShellWithCapture()` 在后端机器顺序运行本次步骤，支持输出、取消和 1800 秒超时；不另用一套 spawn。本地产物 realpath 需在项目根内且是普通文件。 |
| upload | 逐文件复核 Profile 允许目录和 SSH 身份，再调用原 SFTP 服务 overwrite 上传。记录累计进度与当前文件 source、remotePath、真实 bytesTransferred/totalBytes。它不是 Landlock 内的操作。 |
| restart / verify | 调用 CommandOperationService，保留 Guard、目标复核、沙箱事实和普通审批。缺少 verify 命令时合法 skipped。失败保留退出码、故障码和可公开详情。 |

新模式使用 `deployment_stage_executions`：每次实际执行有独立 ID、计划版本、调用请求、阶段、时间和结果。请求键绑定 Agent Run 与 toolCallId；同一请求附着或返回原执行，新请求表达明确重做。每个部署最多一个 running 执行，其他请求返回忙。

允许重新执行同阶段或较早阶段，前序必须成功或合法跳过；不能从构建跳到重启。较早阶段重做使其及下游的当前结果、步骤/产物进度与相关一次性权限失效，保留历史输出与审计。界面始终只有五个稳定阶段，不新增 2-1 节点。旧未接入模式的历史 Run 保留兼容分支的结算行为。

`deployment_propose_recovery` 可在新模式修改当前或较早阶段，不能在实际阶段运行中更改计划，也不能越过前序条件。参数仍经完整计划校验和目标复核；用户审阅后更新有效版本并重置受影响下游。每阶段尝试和修订历史分别最多 64 条。拒绝或失败不会隐式退出模式。

## 日志、事件与恢复

- v31 `deployment_logs` 按部署分配有序 sequence，关联阶段和执行 ID；每条输出、执行边界和结束结果追加保存。新阶段执行不会清空失败日志。单个事件拆到 16 KiB 字符以内，持久化日志当前不丢弃历史。
- Run 快照只保留各阶段最近 128 KiB 字符尾部、logCursor 和截断标记；模型工具结果每段只返回 8192 字符尾部。用户完整历史从日志表分页读取，不能把模型尾部当作完整日志。
- `DeploymentExecutionRecorder` 保存开始/结果及有序输出；结果提交失败保留待提交事实，同一次结算并发合并。重试先结算再检查请求身份，不重新运行副作用。执行结束后的迟到日志不能追加到另一次执行。
- Workspace `deployments` topic 包含 `deployment.started`、`deployment.message.created`、`deployment.stage.updated`、`deployment.log.appended`、`deployment.finished`，并保留 `deployment.updated` 和 `deployment.discussion.updated` 快照。前端状态来自部署事实，模型文字仍走 Chat。
- `DeploymentLogStore` 为挂载的 Session 保留日志，REST 游标补齐和 SSE 按 sequence 合并去重，重连补读。右侧日志按执行分组展开，支持时间、跟随输出与错误定位；查看旧输出不强制滚回底部。
- 后端启动不复活进程、不重放命令、不恢复内存 grant。未开始 preparing 计划取消，running Run 失败并记录中断原因，running 执行记录标为 interrupted。已有 recovering 提案保留，但未完成远端命令的旧例外需重新决定；对应已终结 Run 的 Session 绑定一起结算，结束时间不早于模式创建时间，兼容系统时钟回拨。无执行计划的讨论可继续。

## 模型 harness 与权限

`ChatAgentRuntimeFactory` 只在绑定部署模式时装配真实专用定义，结束后从下一请求移除；入口复读绑定和所有权。Schema、阶段/执行预检在普通审批之前运行；副作用前再次检查当前计划、Session、目标和权限。已知 4xx 请求错误作为非终止工具错误交回模型修正，内部错误不统一改成参数错误。

参数/规则错误返回精确 `code/message/field`，必要时含路径、允许目录及文件系统错误类别 `details`。初次提案与修订共用逐字段校验，指出数组索引、未知/缺失字段、路径格式/范围及数量限制；Profile 文件缺失/权限、构建 cwd、产物普通文件检查、Guard 对应阶段、执行顺序、完成条件和日志查询均保留具体原因。Tool 授权与执行捕获、HTTP 规范化不抹掉字段和详情。已知路径 errno 生成可修正错误，未知 I/O/SQLite 故障继续按内部故障处理；阶段结果保存精确错误文字及原日志。回归 `deployment-validation.test.ts`、Service 与 routes 测试。

每个工具结束和模型请求前刷新可信部署状态；包括普通诊断工具的结果，状态仅在 provider 投影加入，不写入聊天或日志，也不无界累加。普通 bash/write、SFTP、Terminal submit/控制键和其他工具按原交互模式、Guard、沙箱与审批规则使用，其结果不会推进部署阶段。

RESTART/VERIFY 各自冻结 `access`。Session 开启且沙箱完整可用、声明写入在根内时使用 workspace_write；不可用或写入超界的准确命令需要单独人工 Full Access 例外，autoAudit 不批准例外。批准启动时有效期五分钟；实际远端调用绑定执行身份与目标，一次消费。阶段重做或修订后受影响权限重新申请，不能复用已消费 grant。Session 主动关闭沙箱时来源是 session_sandbox_disabled，保留 Guard 与普通审批，不创建例外 grant。受限执行失败不自动提权重放。

Profile hash、SSH 主机指纹、凭据版本、远端用户、Workspace revision、Session 沙箱来源及 `sandboxWritableRoots` 都需复核。上传仅依据 Profile 的允许目录（v1 使用其 target 父目录）做词法及 SFTP canonical 父目录校验，不与 Workspace/Session 沙盒根叠加。新绑定不再写 writableRoot，历史字段仅作审计读取；缺失 sandboxWritableRoots 的历史计划不会从该字段恢复权限。远端符号链接在检查和上传间仍有外部竞态。本地构建不受远端沙箱保护；普通工具不能靠命令字符串证明只读。

## 前端职责与当前完成边界

- `ChatConsole` 负责装配 Terminal/Deploy Tab，通用 TaskContainer 没有部署业务导入。`DeploymentTaskPage` 展示服务、目标、横向阶段、当前步骤、文件真实字节（自适应 B/KiB/MiB/GiB）、结束原因和日志；放大复用原容器，不覆盖左侧导航。Tab × 只隐藏，退出部署走独立接口；只有所展示任务确实是当前活动部署才提供退出按钮，配置选择页没有退出行为。
- `use-deployment-tasks.ts` 只保存服务端活动模式和任务事实，`use-deployment-catalog.ts` 保存 Profile/分页 Run，`use-deployment.ts` 装配选择/显示；唯一 SSE adapter 是 `deployment-event-stream.ts`。关闭和用户历史选择优先于迟到恢复，Session 切换丢弃旧响应；活动审批目标不随历史选择改变。
- 所有规划、执行、诊断和最终文字在中间 ChatTimeline。`conversationHistory` 对正式部署入口保持消息顺序，旧无正式消息的 Run 使用时间回显，不再按 Agent Run 把模型文字归组进部署卡片。`ChatMessageRow` 显式区分 custom 与 assistant，避免字符串 content 调用数组方法。
- `DeploymentReview`、普通工具审批和 UserDecisionPanel 在中间交互。放大页仅显示待处理提示与返回入口；简洁补充框复用同一 Session 的 submit/queue 链路，不展示另一套聊天。发送同步锁阻止同一帧重复提交；成功只清空已提交且未改写的文本，旧 Session 迟到响应不清空新 Session 草稿。结束或停靠后的隐藏表单不接受提交。
- 日志折叠状态在增量追加时保留；错误定位先展开对应执行分组，再于 DOM 提交后仅滚动日志视口并聚焦，避免移动外层任务页面。主动浏览旧日志时停止跟随，隐藏视口不使用零高度滚动测量；兼容历史尾部可定位错误但不伪造执行记录。
- 已用独立 Java 项目完成真实配置讨论、构建失败与同阶段修复重试、SFTP 上传、启动和健康检查；验证失败刷新、正式消息回显、关闭后历史重开、Terminal/Deploy 切换、日志位置与折叠、放大草稿和同 Session 排队输入、返回中间决策、窄屏与明暗主题。三类明确结束均有真实记录；手动退出的取消语义和队列竞争已修复并复验。旧 `DeploymentPanel` 与 `DeploymentModelActivity` 已移除，相应测试改测新任务页与中间审阅组件；旧数据仅保留必要的读取兼容。

## HTTP 入口

以下路径均以 `/api/sessions/{sessionId}/deployments` 为根，返回值按 Session 和 ID 校验。

| 方法与后缀 | 用途 |
|---|---|
| GET 根；POST /discussions | 发现 Profile；选定服务并开始讨论/模式。旧 POST 根仅兼容 v1 直接准备。 |
| GET /mode；GET /tasks/{id}/state | 当前活动模式或指定历史任务。 |
| POST /tasks/{id}/finish | 用户 cancelled 或 failed 结束；failed 要有 reason，不接受用户伪造 success。 |
| GET /discussions/active；GET /discussions/{id}；POST /discussions/{id}/cancel | 讨论读取与兼容取消，新模式取消共用明确结束用例。 |
| GET /history?limit=50&cursor=...；GET /{id} | 稳定历史分页与指定 Run 快照。 |
| GET /{id}/logs?stage=build&afterSequence=0&limit=200 | 阶段日志游标补齐；limit 1–500，拒绝重复/未知参数和无效游标。 |
| POST /{id}/approvals/{restart或verify}/{approvalId}/approve 或 reject | 准确远端命令的人工例外决定；新模式拒绝保留待审，不当作退出。 |
| POST /{id}/recovery/{proposalId}/approve 或 reject | 修订决定；重复同决定幂等，冲突拒绝。 |
| POST /{id}/cancel；POST /{id}/confirm | 前者兼容取消；后者拒绝绕过 Agent。 |

## 代码所有者与验证

| 职责 | 主要入口 |
|---|---|
| 模式生命周期 | `domain/deployment-session.ts`、`deployment-mode-service.ts`、Deployment Session Repository 与 SQLite 实现 |
| 阶段顺序/失效、执行和日志 | `deployment-stage-state.ts`、`deployment-service.ts`、`deployment-execution-recorder.ts`、`domain/deployment-execution.ts`、Execution Repository/SQLite |
| Plan 与修订校验、本地构建复用 | `deployment-plan-proposal.ts`、`deployment-recovery-proposal.ts`、`deployment-validation.ts`、`deployment-file-system-error.ts`、`deployment-local-build.ts` |
| Chat 绑定、工具与模型投影 | `chat-service.ts`、`chat-agent-runtime-factory.ts`、`deployment-agent-tool.ts`、`deployment-runtime-context.ts`、`deployment-history-message.ts` |
| API、迁移与装配 | `deployment-routes.ts`、`migrations.ts` v23–26/v30–32、`create-sqlite-management-backend.ts`、`workspace-event-hub.ts` |
| 页面、审批与日志 | `features/deploy/components/deployment-task-page.tsx`、`deployment-logs.tsx`、`deployment-review.tsx`、`deployment-task.css` |
| 前端 API 与状态 | `features/deploy/api/deployment-api.ts`、`model/deployment-task.ts`、`runtime/use-deployment.ts`、`use-deployment-tasks.ts`、`use-deployment-catalog.ts`、`deployment-event-stream.ts`、`deployment-log-store.ts` |
| Profile 配置规范 | `packages/ssh-agent/resources/skills/gori-deployment-spec/SKILL.md`、`references/profile-schema.md` |

新增回归重点在 `deployment-mode.test.ts`、`chat-agent-runtime-factory.test.ts`、`deployment-task.test.tsx`、`deployment-task-interactions.test.tsx`、`chat-custom-messages.test.tsx`；原 Profile、Discussion、Service、HTTP、SQLite、Chat、沙箱 roots 和 Terminal/TaskContainer 测试仍需按变更定向运行。交互处理器回归覆盖草稿、双提交、跨 Session 迟到响应、折叠错误定位与日志跟随；后端覆盖运行中退出竞争、迟到输出拒绝、结算失败不重建和时钟回拨恢复。真实服务器或模型测试须有用户授权，不能替代本地测试；变更后必须核对映射文档并通过根 `npm run check`。经用户授权，已使用阿里云工作区与 OpenCode Go / DeepSeek V4.1 Flash 完成独立 Java 项目真实验收；实际发布时 Session 沙箱由用户侧变更为关闭，不能视为开启沙箱的发布实测。远端专用进程和临时目录已清理，本地项目和部署历史保留；结果见设计依据第 16–17 节。
