# Diagnose 诊断任务

适用于 `/diagnose`、跨 Chat Run 的诊断任务、当前节点记录、轻量简报、独立结论阅读页与统一聊天历史入口。设计依据见 [代码设计与实现计划](../design/diagnose.md)，本文描述当前实现。

## 行为与状态

- `/diagnose` 或 Composer 的 Diagnose 入口开始或定位任务；`/diagnose 问题` 将问题和图片附件交给原 Chat 链路。没有问题时由模型询问。已有活动任务的无参数入口只定位，不新增消息或模型请求。
- 一个 Session 最多一个活动诊断，与 Deploy 模式互斥；部署旧 Prepare/直接提案的最终插入也检查共享策略。`deployment_setup` 在 Run 创建时拒绝活动诊断。历史选择与活动模式分开，查看旧任务不改变模型绑定。
- `DiagnoseTask` 状态为 active/completed/cancelled。completed 只表示保存了结论，允许未定位根因。普通 Run 完成、失败、停止、页面隐藏、断线或服务重启都不结束活动诊断。
- `DiagnoseNode` 只有 direction/status/explanation 三个业务字段。status 为 diagnosing/confirmed/unconfirmed。仅当前节点可修订；追加下一条前，当前节点须为 confirmed/unconfirmed 且说明非空。unconfirmed 可说明信息不足或转向理由，不要求证明、排除或关联证据。
- 标题可单独更新，默认“诊断任务”；不创建或推进节点。结束时只将仍 diagnosing 的当前节点收为 unconfirmed，保留原文并追加客观结束说明；无节点也可结束。
- 用户“结束诊断”在原 Session 启动普通 Run，或加入当前绑定 Run 的 follow_up 队列；原队列仍可提升为 steer。模型调用 `diagnose_finish` 原子保存 Markdown 和任务终态后，按钮变为“结论”。普通文字回复或请求消费不能代替保存。
- “直接退出诊断”不请求模型，先提交 cancelled，再取消绑定 Run；实际停止失败不恢复任务。沿用 Chat 强制取消的队列清理规则。已经保存的结论优先保留；终态竞争以第一个提交为准。

## 后端职责

| 文件 | 所有权 |
|---|---|
| `domain/diagnose.ts` | 类型、集中限额、输入校验和纯节点转换 |
| `application/repositories/diagnose-repository.ts` | 聚合存取、当前节点、工具回执和 Chat 请求关联端口 |
| `application/services/diagnose-service.ts` | 原子创建/修改/结束、提交后的事实事件；不调度模型 |
| `application/services/diagnose-chat-coordinator.ts` | 用户入口、结论队列、直接退出与原 Chat 用例衔接；不复制 Agent Loop |
| `application/services/session-task-mode-policy.ts` | Session 业务模式互斥；在创建事务内复检 |
| `application/diagnose-runtime.ts` | 冻结 Run 绑定、动态工具和三项简报 |
| `application/tools/diagnose-agent-tool.ts` | 工具 Schema、用例转换、已知 4xx 的非终止错误 |
| `infrastructure/sqlite/sqlite-diagnose-repository.ts` | SQL、读取解析、条件写入和稳定历史消息读取 |
| `infrastructure/sqlite/sqlite-session-task-mode-facts.ts` | 兼容新旧部署表的活动模式查询，SQL 不进入运行时装配工厂 |
| `api/diagnose-routes.ts` | 严格解析、共享 Chat 模型/附件校验和用例分发 |

以上后端路径相对 `packages/ssh-agent/src/`。ChatService 只增加 idle Session 短期预约、任务绑定和 Context 组合；Runtime Factory 在原请求/压缩/恢复回调内组合适配器。结论正文和状态规则不放进这些通用装配类。

三个工具仅在本轮绑定的活动任务中提供，都是 sequential；元数据工具加入明确 allow 分支，不改变普通工具、Session 只读、Guard 或人工审批。

- `diagnose_update({title?,node?})`：node.action 为 append/update_current，不接受任务或历史节点 ID；返回当前节点和修订号。
- `diagnose_inspect({beforeSequence?,limit?})`：默认最近 20 条、最多 50 条，按 sequence 升序，返回向前游标。只读保存记录，不接受自然语言问题或运行命令。64 KiB 预算优先减少整条记录数；单条解释因 JSON 控制字符转义超过预算时使用完整原文文本块，不截断内容。
- `diagnose_finish({conclusionMarkdown})`：非空自由 Markdown；结果只返回任务 ID/终态/修订号/结论可用标记，不重复全文。

标题最多 200 Unicode 字符，方向 500 字符，说明 16 KiB UTF-8，报告 256 KiB UTF-8。收口说明是服务端事实附注，不裁剪原说明。已知参数和状态错误保留 code/message/field、terminate=false；未知 SQLite/内部错误沿用统一故障分类。

简报用 direction/status/explanation 三个 JSON 数据字段，说明预览最多 300 字符。当前实现通过临时 `<diagnose-runtime>` 请求头部片段投影，不向消息数组插入简报，因此工具调用和结果保持原连续组；基础快照不改写，重复投影替换自身片段，不累加。活动请求、离线占用与手动压缩共用适配器；自动压缩前后及超限恢复继续走既有回调。简报不包含完整历史、报告或催促推进要求。

内置指导 Skill 位于 `packages/ssh-agent/resources/skills/gori-diagnosis/SKILL.md`，当前采用用户提供的 v2 节点输出契约：开场建立问题方向节点，每条关键证据一个节点，同一证据的新进展更新当前节点；说明按“证据／范围／边界”三行组织并控制在 300 字内，方向不超过 40 字，开场说明不超过 150 字；完整结论由 `diagnose_finish` 汇总，并区分已证实、高概率与无法证实。上述要求通过提示词指导模型，不新增后端格式、字数或调用次数门禁，服务端原有节点终态与追加约束仍然生效。

DiagnoseRuntime 初始化时读取该固定资源一次，仅在当前绑定任务仍 active 时，把完整 Skill 放入临时片段中的独立 `<diagnose-skill>` 块，与三项简报分开；跨 Chat Run、占用估算和压缩使用同一投影。重复投影替换整个自身片段，结束后移除 Skill 和简报。包内 resources 随既有打包配置保留，源码与 dist 使用相同相对资源路径；修改 Skill 后需重新加载后端实例。

## SQLite 与幂等

v35 追加三个业务表 `diagnose_tasks`、`diagnose_nodes`、`diagnose_tool_calls`，另用 `diagnose_chat_runs` 和 `diagnose_requests` 保存与既有 Run/Queue 的技术关联。关联表不构成第二套执行状态机；任务保存最近结论请求关联，是否仍在途从原 Run/Queue 查询。重启沿用 Chat 中断恢复，不重放模型、命令或权限。

活动任务唯一索引、当前节点条件更新、顺序追加和历史/终态 UPDATE 触发器共同保证约束。事务不跨模型、SSH 或队列等待；事件使用提交事务内取得的消息快照，提交失败不发布成功事件。

工具回执的键是 taskId/runId/toolCallId，请求与结果同事务保存。先读已提交回执，再检查活动状态；相同请求在任务结束后仍可返回原结果，不同参数或新的迟到写入拒绝。结论正文、当前节点收口和任务终态原子提交。

每个任务只有一条 `customType=diagnose` 历史消息，稳定 ID 为 `diagnose:<taskId>`。创建由数据库触发器原子写入，标题/修订沿用该消息，终态移动到 Session 最大 sequence 之后。统一 Chat 历史接口直接返回该正式消息，不新增前端诊断历史分页或时间混排。`application/chat-ui-history-message.ts` 精确过滤 deployment/diagnose 两种 UI 消息，其他 custom 消息继续保留给原消息转换链路。

聊天通过统一的 `features/chat/model/conversation-history.ts` 识别 Diagnose 与 Deploy 记录。诊断进行中和直接退出时，入口保留后端 sequence 位置；`diagnose_finish` 执行完成且非工具错误、结构化结果含同 taskId/status=completed/conclusionAvailable=true、正式卡片也已 completed 时，用同一张记录卡替换该结束工具展示，并移除原位置入口。卡片点击打开对应 Diagnose Tab，报告全文仍在独立结论阅读页。缺少卡片、仍在运行、结果无效或取消时保留原工具展示。

诊断入口元数据校验与类型归 `features/diagnose/model/diagnose-history-entry.ts`，完成结果匹配归 `diagnose-completion-history.ts`，`DiagnoseHistoryCard` 只呈现已解析数据。与 Deploy 共用 `features/chat/model/task-completion-history.ts` 的内容分段、记录去重、工具结果 JSON 边界和错误保留逻辑；各功能自己校验业务终态，不共享任务生命周期。替换只作用于 UI，不改写消息、工具结果、模型 Context 或数据库。

## REST 与事件

根路径 `/api/sessions/{sessionId}/diagnoses`：

| 方法与后缀 | 用途 |
|---|---|
| POST 根 | requestId、可选 problem/attachmentIds/模型选择/交互模式；返回 task 及实际 Run/Queue 关联 |
| GET /active；GET /{id} | 活动任务/null，或指定历史元数据；没有报告正文 |
| GET /{id}/nodes | beforeSequence/limit 分页，不接受重复或未知查询字段 |
| POST /{id}/conclusion-requests | 幂等请求整理，已有在途请求不重复排队；失败后新 requestId 可重试 |
| GET /{id}/conclusion | 已保存 `{markdown}`；未保存返回 diagnose_conclusion_not_ready/409 |
| POST /{id}/cancel | 直接退出，无模型请求 |

请求变更持有短期 diagnose_request lifecycle lease，删除屏障和沙盒设置互斥继续生效；活动任务本身不长期占用 lease。后端先创建任务，首次 Run 启动失败仍保留任务；原 requestId 重试可以继续发起首次意图。

Workspace SSE 新增 `diagnoses` topic：diagnose.task.updated、diagnose.node.updated、diagnose.message.created/updated。只发元数据/节点/小历史入口，不发报告正文。前端通过独立事件 origin 的共享 Workspace 连接订阅，避免增加一条常驻连接挤占 Chat/Terminal；按 Workspace/Session 身份和各实体自身 revision 合并，任务事件不能覆盖节点事件。stream.ready 通过 REST 补齐活动/所选任务和断线记录缺口，不依赖全局 SSE ID 跨重启重放。历史入口按 taskId 去重，终态移动 sequence 后仍只有一张卡，同位置按 metadata revision 拒绝旧快照。

## 前端职责与阅读状态

独立模块位于 `packages/ssh-agent-web/features/diagnose/`：api 请求及 unknown 校验；model 类型、命令解析、修订合并；runtime/use-diagnose-tasks 负责事实与 REST/SSE，use-diagnose 负责用户动作及 activeTaskId/selectedTaskId/open，use-diagnose-view 保存各任务展开和双视图滚动位置；components 只展示记录、状态、Markdown、结论和历史入口。

ChatConsole 只装配菜单、Hook 和稳定 `diagnose` Tab。Tab × 隐藏页面；通用 TaskContainer 没有业务分支。useChatRuntime.attachRun 为后端创建的 Run 复用原状态恢复及 Run SSE。普通发送直接附着 Run，依靠原 SSE 完成气泡，不额外并发拉取历史；REST 补读与临时气泡按 requestId 绑定的 runId 合并，保留旧轮次的同文消息。发送用同步 ref 阻止同一 render 的重复请求。

单列记录按时间排列，当前展开、旧记录默认收起，可以独立展开；追加不强制折叠已展开记录。状态用有底色的蓝/绿/暖黄标签，结束状态中性灰，保留文字并使用主题表面及语义色。只在跟随底部时自动滚动，回看时显示“有新记录”；分页保持锚点，隐藏页面不使用零尺寸测量覆盖阅读位置。

记录页底部“复制记录”将该任务全部节点按 sequence 升序复制成缩进的 JSON 数组，每项只含 direction/status/explanation，保留说明原文，空任务输出 []。`api/read-diagnose-records.ts` 独立补齐所有分页并检查完整性，不改变页面缓存、展开或滚动状态；任一页失败不输出半份数据。`components/diagnose-copy-records.tsx` 负责剪贴板和复制中/成功/失败反馈，同步锁避免重复点击，离开该任务时取消在途读取。任务活动、已结束或已退出均可复制；结论页不显示此记录按钮。

保存报告后不自动跳页，点击“结论”进入同 Tab 独立 Markdown 阅读视图，最大宽度 920px，可返回记录；直接退出无报告时没有空结论入口。ReactMarkdown + remark-gfm 复用现有依赖，跳过原始 HTML，仅允许 http/https/mailto 外链，图片显示替代文字；表格/代码局部滚动。报告读取错误只重试读取，不生成新报告。静态 UI 文案归独立双语 diagnose.ts 目录。

## 验证与共享入口复核

定向回归：后端 diagnose-service.test.ts、diagnose-api.test.ts 覆盖节点门禁、SQL 历史不可改、UTF-8 限额、回执、回滚、跨轮、正常审批保留、报告独立读取、结论排队去重和直接退出；前端 diagnose-task.test.tsx、use-diagnose-races.test.ts 覆盖状态/Markdown、报告入口、实体修订乱序、Session 迟到响应、历史选择、隐藏恢复和结论请求竞争。

上述后端回归同时验证内置 Skill 原文注入、重复投影不累积、普通 Session 无注入，以及跨轮实际 Provider 请求在 active 时携带、结束后移除；持久化基础头部不含 Skill。faux 请求验证接入范围，不证明真实模型的记录质量已经改善。

diagnose-completion-history.test.tsx 覆盖三类任务状态回显、双语记录卡、结束工具位置、SSE/持久化结果、迟到卡片、无效/错误/未结束结果、幂等重复结束、混合正文/普通工具和失败报告保留；同时验证 Deploy/Diagnose 业务 ID 相同时仍各显示一条正确记录。原 deployment-completion-history 回归继续覆盖部署和旧记录行为。

diagnose-records-copy.test.ts 覆盖完整分页、三个业务字段及原文保留、空数组、分页失败/缺口拒绝和取消迟到读取；复制按钮通过诊断页面静态渲染验证入口。剪贴板权限和浏览器交互仍需实际页面验收。

已核对本次共享装配改动：Provider 重试/错误边界、图片水合/附件关系、文件检索与阅读、Guard、SSH Broker、SFTP/监控、标题、统计、用户决策、活动标识和 Terminal 的原职责与协议保持；新增行为由本文及 Chat/SQLite/HTTP/任务容器对应文档描述。未变领域无需复制诊断业务规则。

这些测试使用临时 SQLite、合成凭据、faux 模型与确定性 Hook 驱动。没有进行真实模型、SSH、构建运行或浏览器视觉验收；静态 React 输出与类型检查不能代替这些验收。
