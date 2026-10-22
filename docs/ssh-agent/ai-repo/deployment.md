# `/deploy` 代码路由

只读 Session 禁止新部署讨论、准备/提案、阶段执行及修订工具；服务在每次副作用前再次检查当前只读设置，旧计划也不能执行。历史查询与明确结束仍可用，见 [session-sandbox.md](./session-sandbox.md)。

适用于 Deployment Profile、Session 部署模式、模型规划与修订、阶段执行、日志和右侧 Deploy Tab。重构依据及逐项验收见 [Deploy 重构实现依据](../design/deploy-refactor.md) 第 16–17 节。本次范围已经实现并完成 macOS 本地构建、Linux 目标和授权模型的真实交互验收；跨平台及不同沙箱后端的实际执行范围分别说明。

## 身份、事实与入口

- `/deploy` 是前端入口。没有活动模式时，在中间 Agent 聊天输入框正上方展开模块选择上拉面板，不创建右侧 Tab；有活动模式时直接定位右侧当前任务。浏览配置不创建部署或运行模型。缺少服务时，即使已有其他 Profile，仍可从“添加服务配置”进入配置讨论；保存 Profile 不自动发布。
- Profile 从 Session 本地 `workDir`（未配置时为后端 `localCwd`）的 `.gori/deploy-*.md` 发现。只显示 `target.host` 与 Workspace 主机相符的文件；错误独立返回。`.gori` 必须是实体目录，Profile 必须是普通文件。`connection.profile` 是文档标签，不选择凭据。
- Profile v2 保存长期构建/重启/验证知识和允许上传目录；本次 Plan v2 固定准确的 1–8 个本地构建步骤、1–16 个普通文件产物及远端目标、重启和可选验证命令。构建目录和产物 source 是相对项目根的模型输入，冻结为规范绝对路径。远端命令可声明最多 16 个 `writePaths`。Profile/Plan v1 保持兼容读取。
- 选择服务后创建稳定部署 ID：新 Discussion、Session 模式和正式历史消息同事务提交；后续 Run 沿用 Discussion ID。`deployment_sessions` 只保存身份、活动绑定和终态，`deployment_runs` 仍是计划与当前阶段事实来源。每个 Session 只有一个活动部署，同一 Workspace 仍只允许一个 running 部署。
- 模块选择请求必须提供 `file + moduleId`，按 ID 匹配，不默认选择 Profile 第一项。`deployment-selection-context.ts` 为规划指引生成 `selection={source:"user",profileFile,profileHash,module:{id,name}}` 和 Profile 版本/模块名称列表，完整参考数据仅提供所选模块。来源从明确选择接口及已持久化 Discussion 推导，无需迁移或回填；每轮状态读取同一绑定，Profile 改动仍要求重新讨论。选择服务不代表确认 Git 发布基线，规划指引要求检查分支、commit、工作树和可得的线上版本证据，有基线歧义或回退风险时先与用户确认；本轮未新增 Git 版本冻结门禁。
- 正式消息位于 `chat_messages`，`message_type=deployment`、`customType=deployment`，按 Session sequence 排序，持有稳定 ID/标题。开始时 `deployment.message.created` 发布实际持久化消息；成功、失败或手动退出在结算事务中将同一消息移到结束 sequence，保存 outcome/startedAt/finishedAt/reason，提交后发布 `deployment.message.updated`。不追加第二张卡片。REST 历史和 SSE 通过相同消息身份及较新 sequence 合并。它是 UI 元数据，在模型与压缩投影中过滤，不能变成 user 指令。

## 从讨论到明确结束

1. 用户选定服务，开启 Session 部署模式，并启动首轮 `deployment_planning` Chat Run。后续普通用户消息由后端当前绑定决定讨论、待审、执行或诊断用途，不由 Tab 是否打开决定。
2. 模型检查项目与变更，用普通文字或 `ask_user_decision` 补充信息，通过 `deployment_propose_plan` 提交准确参数。后端复核路径、Profile hash、目标身份、Guard 和逐命令沙箱来源；提案本身没有构建、上传、重启副作用。
3. 右侧 Deploy 页中的 `DeploymentReview` 展示计划与修订差异，普通工具和 Full Access 权限例外仍在中间 Agent 会话审批。用户确认后创建 `deployment_execution` Run，服务原子认领；旧 `POST .../confirm` 仍拒绝绕开 Agent。
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

允许重新执行同阶段或较早阶段，前序必须成功或合法跳过；不能从构建跳到重启。较早阶段重做使其及下游的当前结果、步骤/产物进度与相关一次性权限失效，保留历史输出与审计。后端保留 prepare 与四个执行阶段的事实，界面展示准备、打包、上传、重启、验证五个固定节点，不新增 2-1 节点。旧未接入模式的历史 Run 保留兼容分支的结算行为。

`deployment_propose_recovery` 可在新模式修改当前或较早阶段，不能在实际阶段运行中更改计划，也不能越过前序条件。参数仍经完整计划校验和目标复核；用户审阅后更新有效版本并重置受影响下游。每阶段尝试和修订历史分别最多 64 条。拒绝或失败不会隐式退出模式。

## 日志、事件与恢复

- v31 `deployment_logs` 按部署分配有序 sequence，关联阶段和执行 ID；每条输出、执行边界和结束结果追加保存。新阶段执行不会清空失败日志。单个事件拆到 16 KiB 字符以内，持久化日志当前不丢弃历史。
- Run 快照只保留各阶段最近 128 KiB 字符尾部、logCursor 和截断标记；模型工具结果每段只返回 8192 字符尾部。用户完整历史从日志表分页读取，不能把模型尾部当作完整日志。
- `DeploymentExecutionRecorder` 保存开始/结果及有序输出；结果提交失败保留待提交事实，同一次结算并发合并。重试先结算再检查请求身份，不重新运行副作用。执行结束后的迟到日志不能追加到另一次执行。
- Workspace `deployments` topic 包含 `deployment.started`、`deployment.message.created`、`deployment.message.updated`、`deployment.stage.updated`、`deployment.log.appended`、`deployment.finished`，并保留 `deployment.updated` 和 `deployment.discussion.updated` 快照。前端状态来自部署事实，模型文字仍走 Chat。
- `DeploymentLogStore` 为挂载的 Session 保留日志，REST 游标补齐和 SSE 按 sequence 合并去重，重连补读。右侧每阶段只有一个连续日志视口，所有执行的原始 chunk 文本按 sequence 追加，不再生成按执行折叠的分组。点击日志标题整体折叠/展开，折叠隐藏完整内容并收回视口占高；追加不自动展开。保留时间提示、跟随输出与错误定位，定位错误先展开整块日志再只滚动日志视口；查看旧输出不强制滚回底部。
- 后端启动不复活进程、不重放命令、不恢复内存 grant。未开始 preparing 计划取消，running Run 失败并记录中断原因，running 执行记录标为 interrupted。已有 recovering 提案保留，但未完成远端命令的旧例外需重新决定；对应已终结 Run 的 Session 绑定一起结算，结束时间不早于模式创建时间，兼容系统时钟回拨。无执行计划的讨论可继续。

## 模型 harness 与权限

固定目录始终包含部署专用定义，`ChatAgentRuntimeFactory` 仅在匹配绑定时连接实际实现；结束后保留定义，由不可用入口在审批前和执行时拒绝。Schema、阶段/执行预检在普通审批之前运行；副作用前再次检查当前计划、Session、目标和权限。已知 4xx 请求错误作为非终止工具错误交回模型修正，内部错误不统一改成参数错误。

参数/规则错误返回精确 `code/message/field`，必要时含路径、允许目录及文件系统错误类别 `details`。初次提案与修订共用逐字段校验，指出数组索引、未知/缺失字段、路径格式/范围及数量限制；Profile 文件缺失/权限、构建 cwd、产物普通文件检查、Guard 对应阶段、执行顺序、完成条件和日志查询均保留具体原因。Tool 授权与执行捕获、HTTP 规范化不抹掉字段和详情。已知路径 errno 生成可修正错误，未知 I/O/SQLite 故障继续按内部故障处理；阶段结果保存精确错误文字及原日志。回归 `deployment-validation.test.ts`、Service 与 routes 测试。

请求前通过 `deploymentRuntimeSnapshot()` 读取完整阶段事实，以 deployment 通道追加已变化的状态；讨论/执行/修复指引在 workflow 通道按 scope/内容追加，不再放动态头部或临时末尾投影。状态位于完整结果组之后，保存原文且下次请求仍保留；退出追加 inactive。review 明确限制执行，覆盖旧执行指引的当前含义；失败并不自动退出。Profile 等引用数据经 JSON 引用和转义，不提升为指令。普通工具继续按原模式、Guard、沙盒与审批规则使用，其结果不会推进阶段。见 [runtime-context.md](./runtime-context.md)。

RESTART/VERIFY 各自冻结 `access`。Session 开启且沙箱完整可用、声明写入在根内时使用 workspace_write；不可用或写入超界的准确命令需要单独人工 Full Access 例外，autoAudit 不批准例外。批准启动时有效期五分钟；实际远端调用绑定执行身份与目标，一次消费。阶段重做或修订后受影响权限重新申请，不能复用已消费 grant。Session 主动关闭沙箱时来源是 session_sandbox_disabled，保留 Guard 与普通审批，不创建例外 grant。受限执行失败不自动提权重放。

Profile hash、SSH 主机指纹、凭据版本、远端用户、Workspace revision、Session 沙箱来源及 `sandboxWritableRoots` 都需复核。上传仅依据 Profile 的允许目录（v1 使用其 target 父目录）做词法及 SFTP canonical 父目录校验，不与 Workspace/Session 沙盒根叠加。新绑定不再写 writableRoot，历史字段仅作审计读取；缺失 sandboxWritableRoots 的历史计划不会从该字段恢复权限。远端符号链接在检查和上传间仍有外部竞态。本地构建不受远端沙箱保护；普通工具不能靠命令字符串证明只读。

## 前端职责与当前完成边界

- 部署事件使用独立的事件 origin，与历史、状态和其他 REST 请求的连接额度隔离。`deployment-event-stream.ts` 保留 Session 过滤、结构验证与重连补读，通过 shared/events/workspace-events.ts 与同 Workspace/Locale 的标题、监控和 Diagnose 复用一条 EventSource；取消 Deploy 消费者不关闭其他功能订阅。见 [transport-channels.md](./transport-channels.md)。

- `ChatConsole` 负责装配 Terminal/Deploy Tab，通用 TaskContainer 没有部署业务导入。`DeploymentTaskPage` 展示服务、目标、待确认计划，开始后再显示横向阶段、当前步骤、文件真实字节（自适应 B/KiB/MiB/GiB）、阶段错误和日志；放大复用原容器，不覆盖左侧导航。Tab × 只隐藏，退出部署走独立接口；只有所展示任务确实是当前活动部署才提供退出按钮，模块选择已移至 Composer 上拉面板，任务页不再接收 Profile 或选择/配置回调。部署结算 reason 不再作为页首长段文字展示，模型结论仍归中间会话，持久化原因和阶段错误不变。
- 待确认计划使用竖向时间轴，四个阶段保留 Hammer/Upload/RotateCw/ShieldCheck 图标，节点间距 32px，默认收起；展开通过短连接线延伸到独立内容卡片，避免整块折叠表格堆叠。构建显示步骤数量并可展开完整 cwd/命令；产物显示文件名与目标摘要，进一步展开查看完整源/目标。样式局限在 `deployment-plan.css` 并使用主题语义色。开始按钮位于分隔线上方、右对齐、32px 高，使用中性高对比表面和轻微阴影；禁用与启动中反馈保留。
- `use-deployment-execution.ts` 只处理确认意图：保持既有 deployment_execution Chat Run 链路，提交原已确认计划 ID，阻止同帧重复点击，隔离 Session 切换后的迟到响应，空结果/错误保持计划可重试。只有服务端 Run 开始后才挂载 DeploymentPipeline 的准备节点、四个执行节点与日志，点击和启动中不伪造进度；未启动即退出的历史计划只读展示。执行开始后不再展示底部计划折叠入口，计划改为准备节点的只读内容，点击准备即可查看，不重复提供开始按钮；历史查看不借用活动部署的确认/修订回调；开始前的计划审阅与执行中的必要修订确认保留。DeploymentBuildSteps 独立管理构建命令浏览：右对齐显示“步骤 ‹ 1/4 ›”，使用本次冻结计划的完整步骤，当前执行步骤优先使用实际快照。未手动选择时跟随实时步骤，浏览时保持所选命令，新执行或修订切换后复位；上一/下一按钮在边界禁用，不推进后端执行，兼容 v1 单步骤。命令使用主题次级表面和左侧线条的引用块。DeploymentPipeline 独立持有阶段选择与计时，保留同阶段日志页面及原上传进度行为；四个语义图标直接位于横向连接线上，和计划共用 deployment-stage-icon.tsx，状态只用颜色与小标记表达，不替换阶段身份。准备使用 ClipboardList 图标，显示 run.plan 的计划时间轴，执行日志视口在此节点隐藏但保持挂载；后端刚认领且仍为 prepare 时显示准备详情，不伪造构建成功；通用任务容器没有业务分支。
- `use-deployment-tasks.ts` 只保存服务端活动模式和任务事实，`use-deployment-catalog.ts` 保存 Profile 和已读取的 Run 缓存，不请求部署历史分页，`use-deployment.ts` 分别管理 Composer 选择面板与任务选择/显示；唯一 SSE adapter 是 `deployment-event-stream.ts`。关闭和用户历史选择优先于迟到恢复，Session 切换丢弃旧响应；活动审批目标不随历史选择改变。
- 模块选择创建 Discussion 成功后，立即收起选择面板并打开该讨论页，不等待后续模式确认或模型请求；创建失败时面板保留错误供重试，模式确认失败则在已创建的任务页展示错误。活动模式确认也会清除残留选择面板，部署结束后不重新弹出。SSE 若触发更新的模式查询，原查询的调用者等待最新查询结果；只有服务端确认所选部署仍是当前活动身份才继续规划。结束事件使旧查询失效，不能复用结束前的模式结果启动规划。
- `DeploymentModulePicker` 及局部 `deployment-module-picker.css` 只负责输入框上方的非模态模块列表：沿用聊天输入框底色，有序列表为每项自动编号；每项独立圆角卡片约 36px 高、细边框、轻微底部阴影，前置 11px 轻描边单选控件（整张卡片仍可点击），只展示序号和模块名称。不显示模块 ID、配置来源、行图标、计数或整行选中高光，不使用绿色铺底/强调边框。打开时聚焦面板而不聚焦第一项，单选控件键盘聚焦仅加深原圆圈边框，不叠加外圈；选择期间仅对应圆点标记，失败返回后清除以便重试。列表超高内部滚动，标题和配置入口固定。`model/deployment-module-options.ts` 以 Profile 文件和模块 ID 组合身份，保留跨文件重名模块。Composer 仅提供通用 `aboveInputPanel` 插槽和 focus 能力，不导入 Deploy。Esc/关闭按钮还原输入焦点，点击外部不抢焦点；方向键/Home/End 导航，选择同步锁阻止重复请求。加载/失败/重试只读取模式和目录；明确选择后才沿用原讨论接口，成功后关闭面板并显示任务。关闭及切换 Session 拒绝迟到响应重新展开，打开选择器不覆盖已展示的历史任务。
- 选择后自动发送的简短 user 消息使用后端返回的 `discussion.module.name`，双语模板为“我想发布 {module}……”/“I want to release {module}...”，只补服务名；不从旧目录顺序或缓存推测名字。用户聊天与自动发布意图不改变 role，权威绑定始终由后端 system 上下文提供。
- 所有规划、执行、诊断和最终文字在中间 ChatTimeline。`GET .../chat/messages` 通过独立 `SqliteChatHistoryQuery` 统一返回正式消息、旧 Run 和无计划活动讨论入口，正式消息优先去重；旧结束记录及 v33 legacy_finished 正式消息在后端按结束位置挂接原始消息 sequence 分组。旧记录合成稳定 custom ID 与精简状态/时间，不回填数据库或加载完整日志。`conversationHistory` 只识别服务端条目并选择组件，不从另一份部署列表插入或按时间重排。首屏加载完成前不渲染 SSE 提前到达的孤立卡片；历史按钮只保留 Chat 的统一向前分页，点击仍打开原 Deploy Tab。普通消息顺序不变，`ChatMessageRow` 显式区分 custom 与 assistant，避免字符串 content 调用数组方法。
- `DeploymentHistoryCard` 与局部 `deployment-history-card.css` 统一展示服务端统一历史消息（含旧 Run/Discussion 的只读投影）。采用约 38px 高、与对话内容区等宽的单行技术风格，服务靠左、耗时与状态靠右，通过加深底色、较强边框和状态侧线增强辨识度：部署图标、服务名、MM:SS（超过一小时为 H:MM:SS）耗时和图形状态。成功使用圆形勾、失败使用圆形叉、取消使用圆形短横线，状态图标不加外层方框；不显示部署记录标题、IP、日期、详情文案或失败说明，完整信息从点击打开的原 Deploy Tab 查看。长服务名省略并保留 title，状态有双语无障碍名称。`ChatTimeline` 只装配，不持有部署卡片 UI；Deploy 不导入 `chat-tool-details`/`chat-transfer-details`，上传/下载不读取部署状态。
- `deployment-completion-history.ts` 仅做前端展示替换：`deployment_finish` 确实 completed、非工具错误，结果 JSON 含准确部署 ID、success/failed outcome 及 deploymentMode=false，并存在同 ID/同 outcome 的结束卡片时，将唯一卡片放在该 Tool Call 位置，隐藏原结束入口。混合 Assistant 消息按原内容顺序拆分，保留正文、其他工具与失败报告；原始历史、工具结果和模型上下文不改写。缺少卡片、运行中、错误/无效结果和取消均沿用原渲染，不以请求参数或相邻位置猜测成功。
- 阶段失败的状态和日志已经通过部署工具结果及可信状态返回当前模型，不再显示“让模型分析修复”选择卡片，也不从前端按钮额外启动 deployment_recovery Run。`model/deployment-review.ts` 的 deploymentReviewState/deploymentNeedsReview 只在初始计划、待确认修订、已确认修订待继续或实际需要命令权限决定时为真；单纯失败（含历史修订后再次失败）不显示空审阅卡片，右侧不误报待处理。
- `deployment-history-entry.ts` 独立持有部署入口类型、custom 元数据读取和统一摘要，卡片与结束工具匹配复用该摘要。统一条目识别与 ConversationHistoryEntry 已移至 `features/chat/model/conversation-history.ts`，同时接入 Diagnose；`deployment-history.ts` 只处理右侧 Run 缓存去重，旧记录合并和定位仍归后端。`deployment-completion-history.ts` 保留 Deploy 的完成结果/ID/outcome 校验，调用共享 `features/chat/model/task-completion-history.ts` 完成混合内容拆分、结束位置替换、重复入口移除和原失败报告保留。Diagnose 通过自己的适配器复用该机制，不混合两者的状态机，也不在通用工具组件增加任务分支。
- `model/deployment-task.ts` 只保存任务/日志契约及响应校验；审阅规则归 `model/deployment-review.ts`。`use-deployment-review.ts` 在最近有效审批到期时用单次 timeout 刷新共享审阅快照，同时更新右侧计划审阅和中间权限审批；停止或卸载清理 timeout，不轮询 Chat。DeploymentReview 在右侧展示传入快照，计划摘要由 DeploymentPlanOverview 负责，逐命令权限按钮由中间的 DeploymentFullAccessReview 负责；修订继续复用 RecoveryReview/StepSummary。部署 SSE 复用 isRecord，逐字段收窄后构造 ChatMessage，不用双重类型断言跳过边界。
- 部署计划确认与修订在右侧 `DeploymentReview` 交互，普通工具、Full Access 权限审批和 UserDecisionPanel 仍在中间。放大页可直接审核计划；需要命令权限或用户问题时提示返回中间。简洁补充框复用同一 Session 的 submit/queue 链路，不展示另一套聊天。发送同步锁阻止同一帧重复提交；成功只清空已提交且未改写的文本，旧 Session 迟到响应不清空新 Session 草稿。结束或停靠后的隐藏表单不接受提交。
- 日志整体折叠状态在增量追加时保留；错误定位先展开整块日志，再于 DOM 提交后仅滚动日志视口并聚焦，避免移动外层任务页面。主动浏览旧日志时停止跟随，隐藏视口不使用零高度滚动测量；兼容历史尾部可定位错误但不伪造执行记录。
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
| Chat 绑定、工具与模型投影 | `chat-service.ts`、`chat-agent-runtime-factory.ts`、`deployment-agent-tool.ts`、`deployment-runtime-context.ts`、`chat-ui-history-message.ts` |
| API、迁移与装配 | `deployment-routes.ts`、`migrations.ts` v23–26/v30–33、`create-sqlite-management-backend.ts`、`workspace-event-hub.ts` |
| Composer 模块上拉选择 | `features/deploy/components/deployment-module-picker.tsx`、`deployment-module-picker.css`、`model/deployment-module-options.ts` |
| 页面、审批与日志 | `features/deploy/components/deployment-task-page.tsx`、`deployment-pipeline.tsx`、`deployment-stage-icon.tsx`、`deployment-build-steps.tsx`、`deployment-logs.tsx`、`deployment-review.tsx`、`deployment-plan-overview.tsx`、`deployment-plan.css`、`deployment-task.css` |
| 统一聊天历史读取 | `infrastructure/sqlite/sqlite-chat-history-query.ts`、`sqlite-chat-repository.ts` 的 listHistoryPage；ChatService 只委托查询，原 transcript 方法不变 |
| 前端 API 与状态 | `features/deploy/api/deployment-api.ts`、`model/deployment-task.ts`、`runtime/use-deployment.ts`、`use-deployment-tasks.ts`、`use-deployment-catalog.ts`、`deployment-event-stream.ts`、`deployment-log-store.ts` |
| Profile 配置规范 | `packages/ssh-agent/resources/skills/gori-deployment-spec/SKILL.md`、`references/profile-schema.md` |

新增结束位置回归为 `deployment-completion-history.test.tsx`，覆盖三类结束、迟到开始事件/历史页、刷新、旧记录与传输消息共存；`deployment-mode.test.ts` 使用冻结 v32 扩展 fixture 覆盖升级、稳定消息身份、结束顺序和幂等性。其他回归重点在 `deployment-mode.test.ts`、`chat-agent-runtime-factory.test.ts`、`deployment-task.test.tsx`、`deployment-task-interactions.test.tsx`、`deployment-review-clock.test.ts`、`chat-custom-messages.test.tsx`；原 Profile、Discussion、Service、HTTP、SQLite、Chat、沙箱 roots 和 Terminal/TaskContainer 测试仍需按变更定向运行。交互处理器回归覆盖草稿、双提交、跨 Session 迟到响应、折叠错误定位与日志跟随；后端覆盖运行中退出竞争、迟到输出拒绝、结算失败不重建和时钟回拨恢复。真实服务器或模型测试须有用户授权，不能替代本地测试；变更后必须核对映射文档并通过根 `npm run check`。经用户授权，已使用阿里云工作区与 OpenCode Go / DeepSeek V4.1 Flash 完成独立 Java 项目真实验收；实际发布时 Session 沙箱由用户侧变更为关闭，不能视为开启沙箱的发布实测。远端专用进程和临时目录已清理，本地项目和部署历史保留；结果见设计依据第 16–17 节。

模块上拉入口回归见 `use-deployment-races.test.ts`、`deployment-panel.test.tsx` 和 `deployment-task-interactions.test.tsx`：只读打开、活动任务定位、关闭/切换 Session 的迟到响应、创建成功即收起、SSE 与模式查询的两种完成顺序、结束/替换后的规划拒绝、创建失败重试、重名模块、键盘/焦点、外部关闭及重复点击。此前浏览器已在现有本地 Session 验证真实展开位置和关闭行为；2026-10-22 弹窗关闭竞态修复使用模拟 API/SSE 完成上述三个文件的 64 项回归，未进行浏览器视觉或真实模型/远端部署验收。

统一历史回归见 `chat-message-pagination-api.test.ts`：latest/before/after、相同锚点的多个卡片不拆页、跨 Session 过滤、正式消息优先、v33 旧入口定位、孤立讨论、仅有旧部署而无聊天的锚点 0、原库消息不改写。`historyOrder=1` 表示卡片在锚点之后，limit 限制 sequence 分组数，附属旧卡片可使条目数超过 limit；详情见 [Chat 历史契约](../frontend/chat-stream-integration.md)。前端覆盖分页面逆序合并、加载中隐藏孤立卡片、无独立部署历史请求及原结束工具替换。Run 状态发生变化时通过同一 Chat 历史接口更新摘要，不把 Run 快照另插入时间线。


2026-10-19 Diagnose 接入：部署模式与活动 Diagnose 互斥，SessionTaskModePolicy 在模式创建及旧 Prepare/直接提案的最终插入事务内复检。deployment_setup 的 Chat Run 同样拒绝活动诊断。历史仍可查看；UI 历史过滤已提取为 chat-ui-history-message.ts，部署生命周期、阶段与权限保持原规则。 详见 [Diagnose 功能路由](./diagnose.md)。
