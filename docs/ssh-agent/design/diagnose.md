# Diagnose 代码设计与实现计划

确认日期：2026-10-19（Asia/Shanghai）。状态：产品边界已确认，代码已按本文实现；实际实现选择与已验证范围见第 12 节。

Diagnose 面向用户主动发起的单台 Linux 服务器异常排查。AI 使用已有工具分析问题，在自己认为有意义的节点记录诊断方向、状态和说明，最终提交 Markdown 结论。右侧任务 Tab 展示排查记录与结论，沟通和审批继续留在原对话区。

本次实现以可读性、职责清晰和增量接入为优先级。需要复用现有运行能力，同时避免继续把具体业务规则堆入 ChatService、运行时工厂和 ChatConsole，也不复制 Deploy 的讨论、计划、执行三层业务模型。

## 1 阅读入口与实现边界

实施前阅读根目录 [agent.md](../../../agent.md)，并结合以下当前功能文档核对真实源码：

- [Chat Runtime](../ai-repo/chat-runtime.md)、[会话提示与模式](../ai-repo/session-prompt.md)、[上下文压缩](../ai-repo/context-compaction.md)。
- [任务容器](../ai-repo/task-container.md)、[任务容器长期约束](./task-container-terminal-refactor.md)。
- [Deploy 当前行为](../ai-repo/deployment.md)、[Deploy 实现依据](./deploy-refactor.md)。后者包含多轮修订，不能将其中早期目标直接当作现有行为。
- [SQLite 持久化](../ai-repo/sqlite-persistence.md)、[传输通道](../ai-repo/transport-channels.md)、[用户决策](../ai-repo/user-decision.md)。

第一版只实现诊断任务、顺序节点记录、三项轻量简报、结论阅读与历史恢复。不实现证据图、节点依赖、固定排查流水线、自动监控、后台自动修复或通用工作流引擎；不按编程语言增加一套专用诊断工具。

## 2 已确认的产品规则

### 2.1 任务与对话

1. 同一 Session 同时最多一个活动 Diagnose；活动 Diagnose 与活动 Deploy 互斥。历史页面可以同时存在，Terminal 和文件阅读器按原规则使用。
2. Diagnose 跨 Chat Run 保留。普通回复结束、工具失败、等待用户、停止当前输出、切换 Tab、关闭展示和浏览器断线都不自动结束诊断。
3. 入口兼容 `/diagnose` 与 `/diagnose 问题描述`。缺少问题时 AI 正常询问；不增加强制的前置表单。
4. Diagnose 沿用 Session 的沙箱、Guard、自动审批与现有工具权限，不新增强制只读或逐次写操作审批策略。已有只读 Session 同样可以保存诊断记录。
5. 普通聊天仍可临时讨论其他问题，不能要求每轮都更新记录或推进阶段。

### 2.2 顺序记录

每个节点只有三个业务字段：诊断方向、状态、说明。说明接受检查结果、判断依据、证据片段、转向原因、未确定原因或阻碍，不要求引用编号、关联旧节点或构造证据闭环。

- AI 按需创建节点，可以多次修改当前节点。
- 创建下一节点后，之前的节点成为只读历史；模型和前端都没有历史节点修改入口。
- 追加下一节点的前提是当前节点已经进入终态，而且说明非空。
- “暂未确定”是合法终态，允许解释为什么转向下一方向，不要求证实根因或排除当前猜测。
- 新证据改变旧判断时，在当前或后续记录中自然表达，不回写历史，不额外建立关联结构。
- 不要求一条命令对应一个节点，不要求提前列出阶段数量和顺序。

### 2.3 结束与结论

- AI 主动结束时，通过 `diagnose_finish` 提交完整 Markdown 结论。现有信息不足以定位也是合法结果。
- 用户点击“结束诊断”，通过原 Session 的 Chat 执行或队列链路请求 AI 根据已有信息整理结论，保存成功后再结束任务。
- 结论保存后，“结束诊断”变为“结论”。点击进入同一 Diagnose Tab 内的独立阅读页，可返回原记录页。
- 不因结论到达而自动切换页面；不把诊断结束解释为故障已修复。
- 保留次级“直接退出诊断”入口，不调用模型，任务进入 `cancelled` 终态，保留记录，不生成结论。

## 3 领域模型与持久化

### 3.1 只建立一个诊断任务实体

`DiagnoseTask` 是跨对话的业务身份；`DiagnoseNode` 是其中的顺序记录。Chat Run 保持现有执行含义，不再引入 `DiagnoseRun`、`DiagnoseDiscussion` 或另一份诊断 Session。

| 对象 | 必要数据 |
|---|---|
| DiagnoseTask | id、sessionId、workspaceId、title、status、revision、创建/更新时间、结束时间、结论可用标记 |
| DiagnoseNode | id、taskId、sequence、direction、status、explanation、revision、创建/更新时间 |
| 结论 | 任务所属的 Markdown 原文，单独读取，不放入普通状态响应或 SSE 正文 |
| 结论请求关联 | requestId、关联的 Chat Run 或队列项，用于防重复、恢复和失败重试 |

状态使用字符串联合类型：

- 任务：`active`、`completed`、`cancelled`。后两者为不可恢复的终态。
- 节点：`diagnosing`（诊断中）、`confirmed`（已确认）、`unconfirmed`（暂未确定）。后两者为节点终态。

任务 `completed` 只表示已经提交结论；是否定位原因由结论正文说明，不设置平台无法独立核验的“根因正确”标记。“已确认”也是模型提交的判断状态，后端不把说明非空当作证明。

标题默认“诊断任务”，由 `diagnose_update` 按需设置。标题描述异常现象，活动期间可修正；标题更新不创建节点，也不触发推进条件。

### 3.2 SQLite 组织

新增 `diagnose_tasks`、`diagnose_nodes`、`diagnose_tool_calls` 三张表。结论正文及结论请求关联保存在任务表，不额外拆分报告、阶段或执行表。

- 活动任务使用 Session 级唯一约束；节点使用任务内递增 sequence 和唯一约束。
- Repository 更新节点时必须限定活动任务的当前节点。数据库触发器再拒绝对历史节点、已结束任务节点的 UPDATE，避免只有工具层保护。
- `diagnose_tool_calls` 以任务、Run、Tool Call 身份去重，保存请求和处理结果。写入回执与节点/任务变更处于同一事务，重放同一调用不重复追加节点或覆盖结论。
- 先检查同一调用的已提交回执，再判断任务是否仍然活动；只有请求内容一致的重放可以返回已有结果，其他结束后调用继续拒绝。
- Session 删除级联清理诊断数据；不阻止合法的级联删除，不用“禁止删除历史”的触发器阻塞 Session 生命周期。
- 每次事实变更递增任务 revision；先提交事务，再发布事件。
- 模型调用、SSH、等待审批和 Run 停止不放进 SQLite 事务。复用现有 TransactionRunner，不嵌套事务。

在现有迁移末尾追加下一版本；当前最大版本为 v34。不得修改旧 migration，不迁移或回填不存在的旧诊断数据。

### 3.3 结束时收口当前记录

结束任务不要求补全全部历史。当前节点已经是终态时保持原文；当前节点仍为 `diagnosing` 时，收为 `unconfirmed`，保留原说明，并补充客观的结束说明：模型提交结论时说明该方向未单独确认，用户直接退出时说明排查被用户终止。没有节点也允许结束。

该默认只表达记录停止，不能自动改成“已确认”，不能伪造证据，不修改此前节点。正常结束在同一事务中保存结论、收口当前记录和提交任务终态；直接退出保存取消终态，不生成报告。

## 4 代码职责与文件组织

### 4.1 后端新增模块

以下路径均相对 `packages/ssh-agent/src/`：

```text
domain/
  diagnose.ts
application/
  diagnose-runtime.ts
  repositories/
    diagnose-repository.ts
  services/
    diagnose-service.ts
    diagnose-chat-coordinator.ts
    session-task-mode-policy.ts
  tools/
    diagnose-agent-tool.ts
infrastructure/sqlite/
  sqlite-diagnose-repository.ts
api/
  diagnose-routes.ts
```

| 文件 | 所有职责 | 不应承接的职责 |
|---|---|---|
| domain/diagnose.ts | 领域类型、错误、节点与任务状态规则 | SQL、HTTP、模型调用、UI 文案 |
| diagnose-repository.ts | 任务聚合的读写、当前节点及幂等回执端口 | 对外暴露任意历史节点 UPDATE |
| diagnose-service.ts | 创建任务、标题/节点修改、结论保存、取消；控制事务和事件提交顺序 | Chat 队列调度、SSH 执行、Prompt 大段文本 |
| diagnose-chat-coordinator.ts | 用户入口、结论请求、直接退出与 Chat 生命周期之间的衔接 | 复制 Agent Loop、Provider 请求或队列实现 |
| diagnose-runtime.ts | 创建绑定指定任务/Run 的运行时适配器，提供动态工具、轻量简报和可用性检查 | 部署业务判断、独立模型调度、业务数据的第二份存储 |
| diagnose-agent-tool.ts | 三个工具的 Schema、参数到用例的转换、精简工具结果 | SQL、HTTP 请求、前端展示规则 |
| session-task-mode-policy.ts | Session 级 Deploy/Diagnose 互斥检查 | 通用工作流引擎、阶段定义、业务执行 |
| sqlite-diagnose-repository.ts | SQL、数据解析、条件写入、历史入口持久化 | 调用模型或发布尚未提交的事件 |
| diagnose-routes.ts | 请求解析、调用用例、响应与错误转换 | 推导状态、执行命令、拼接 Prompt |

DiagnoseService 和 ChatService 不互相依赖。Coordinator 单向依赖两者，在运行时装配层于 Chat 创建后构建。运行时只依赖必要的诊断端口，不能将 Coordinator 反向注入诊断领域服务。

互斥策略依赖 Repository 的活动事实，通过装配注入，不能让 DeployService 与 DiagnoseService 相互调用。两个业务的创建入口都在事务内复核互斥；现有部署的兼容准备入口和配置工作流也必须覆盖，不能只禁用菜单。

### 4.2 前端新增模块

以下路径均相对 `packages/ssh-agent-web/features/diagnose/`：

```text
api/
  diagnose-api.ts
model/
  diagnose.ts
  diagnose-command.ts
runtime/
  diagnose-event-stream.ts
  use-diagnose-tasks.ts
  use-diagnose.ts
  use-diagnose-view.ts
components/
  diagnose-task-page.tsx
  diagnose-record-list.tsx
  diagnose-record.tsx
  diagnose-status-badge.tsx
  diagnose-conclusion-page.tsx
  diagnose-markdown.tsx
  diagnose-history-card.tsx
  diagnose-task.css
```

- `api` 只处理 REST；`model` 保存 DTO、运行时解析和纯命令匹配。
- `use-diagnose-tasks` 持有后端任务事实、缓存及 REST/SSE 对齐；不能存一份自行推进的节点状态机。
- `use-diagnose` 负责创建/定位、隐藏、选择历史、请求结论和退出，向会话装配层暴露少量动作与页面描述。
- `use-diagnose-view` 负责节点展开、两种页内视图、滚动与跟随；不调用业务 API。
- 页面组件只读取状态并发出意图；记录、状态标签、结论和历史入口各自组织展示。不能在每个节点组件中分别发请求或订阅 SSE。
- `diagnose-markdown` 复用已安装的 react-markdown 和 remark-gfm，为节点说明和结论提供两种阅读密度；不依赖 Chat 或文件阅读器的内部组件。
- 样式局限在 Diagnose 的命名空间并使用主题变量，不修改全局 details、button、Markdown 标签样式。

中英文静态文案分别放入现有 locale 目录下的 `diagnose.ts`，按当前目录注册方式接入。用户和模型填写的标题、说明及结论保持原文，不通过静态消息目录翻译。

### 4.3 必须控制的既有文件改动

| 接入位置 | 本次允许增加的内容 | 需要规避的问题 |
|---|---|---|
| ChatService | 绑定本轮活动诊断身份、调用诊断运行时适配器的接入点 | 增加诊断 Prompt 方法、节点状态分支、结论业务结算实现 |
| ChatAgentRuntimeFactory | 组合适配器的工具与请求投影，保持现有回调顺序 | 再复制一套 beforeProviderRequest、压缩与 Provider 请求逻辑 |
| ChatConsole | 接入 Hook、菜单动作、TaskTab 描述和历史打开回调 | 内联创建/总结/退出的多步请求，增加大量节点状态和业务禁用表达式 |
| TaskContainer | 继续消费通用 TaskTab；正常情况下无需业务改动 | 导入 Diagnose、按任务类型执行 API 或推导关闭规则 |
| WorkspaceEventHub 与 HTTP 装配 | 注册诊断 topic、事件类型和独立路由 | 在通用传输层解释诊断内容 |
| SQLite 与运行时装配 | 注册 Repository、Service、Coordinator 和新 migration | 以全局可变对象连接服务，产生循环依赖 |

把现有 `application/deployment-history-message.ts` 中仅供 UI 历史过滤使用的能力收敛为 `application/chat-ui-history-message.ts`，统一识别已知的 deployment/diagnose 展示消息，供模型请求和压缩路径复用。不能为了 Diagnose 建立第二套容易漏用的过滤逻辑，也不能顺带过滤所有未知 custom 消息。

这里只允许必要的小范围提取；不借此重写 DeployService、全面改造 Chat 或建立可配置工作流框架。

2026-10-21 上下文缓存修订：本页下述“临时简报、不持久化、结束移除定义”的原设计和第 12 节实施记录属于历史，现由 [运行时上下文](../ai-repo/runtime-context.md) 的追加协议与固定 18 工具目录替代。业务当前节点规则、结论及权限不变；Skill 独立通道按内容激活，结束追加 inactive。

## 5 模型工具契约

三种工具只在后端确认存在活动诊断且与本轮绑定一致时装配。任务 ID、Session ID 和 Run ID 由后端绑定，模型参数不接受任意目标任务或历史节点 ID。

### 5.1 diagnose_update

参数包含可选 `title` 和可选 `node`，至少提供一项实际变更。`node.action` 为 `append` 或 `update_current`。

- `title` 单独提交时，只更新活动任务标题。
- `append` 必须提供 direction；status 默认 diagnosing，explanation 默认空。没有节点时直接创建第一条。
- 已有节点时，append 先检查当前状态为 confirmed/unconfirmed 且说明非空，再原子创建下一节点。
- `update_current` 可局部更新 direction/status/explanation；不存在当前节点时返回可修正错误，提示先 append。
- 当前节点进入 confirmed/unconfirmed 时，其最终说明必须非空。当前节点在追加下一条之前仍允许再次修订。
- 说明不要求任何证据编号、关联对象或固定格式，后端只验证字段与状态约束，不判断理由是否充分。

工具返回任务 revision 和受影响的当前节点；不重复返回全部历史。

### 5.2 diagnose_inspect

读取本轮绑定任务已有的顺序工作记录，包含方向、状态和完整说明。不能接收自然语言问题，不查询服务器、不搜索日志、不回答诊断问题。

使用 `beforeSequence` 与 `limit` 分段读取：默认最近 20 条，最多 50 条，结果按发生顺序排列并明确返回后续游标。工具输出预算为 64 KiB，超过时减少本页条目并提供游标，不静默剪掉单条说明。结论全文不放入这个结果。

这只是按需读取能力，不规定 update 前必须 inspect，也不要求每轮重新检查历史。

### 5.3 diagnose_finish

接受非空 `conclusionMarkdown`，正文格式自由。原子保存结论、结束任务及收口当前未完成记录；没有定位原因仍可提交。工具结果只返回 taskId、任务终态、revision 和 conclusionAvailable，不把全文再回传一遍。

结束后移除诊断专用工具，后续迟到调用不能修改记录。重复调用返回已经保存的结果，不覆盖原结论。主会话保留简短的结束说明，长篇正文从“结论”进入阅读。

### 5.4 工具运行与校验

- 三个工具采用 sequential 执行，避免同一模型批次中的更新、追加和结束相互越序。
- 元数据记录工具明确加入授权策略的 allow 分支，避免落入未知工具默认人工审批；这不改变远端命令和本地文件工具的权限。
- 语义约束在 Service 再次验证，不能只依赖 Schema 或提示词。
- 已知参数/状态错误返回可修正工具错误和准确字段，`terminate: false`。未知数据库和内部错误保留原异常分类，不伪装成用户参数错误。
- 第一版输入限额统一集中定义：标题 200 字符、方向 500 字符、说明 16 KiB UTF-8、结论 256 KiB UTF-8。超限明确报错，不截断持久化正文；这些限额不要求模型填写更多内容。

## 6 轻量简报与 Chat 接入

### 6.1 简报只有三个状态提示

每次模型请求前，从最新持久化当前节点投影以下三项：

1. 当前诊断方向；尚无节点时使用任务标题。
2. 当前状态；尚无节点时表示诊断尚待明确。
3. 当前说明；尚无说明时为空。

说明投影最多保留 300 个字符，方向使用已有短文本，不再调用模型生成摘要。截取只用于提示，完整正文保留在任务记录中，可按需 inspect。

简报负责提示正在参与诊断，不承担上下文恢复、完整历史或排查计划的职责。工具定义与首次绑定指引说明使用方式，后续简报不附加“推进阶段”“每轮更新”“尽快完成”之类要求。

### 6.2 运行时投影

- 在每次 Provider 请求前刷新绑定任务事实、工具集合及简报；结束后及时移除工具与活动提示。
- 不改写已有不可变会话头部快照，不把简报持久化成无界追加的历史消息。
- 模式事实来自后端；方向和说明是引用数据，应明确标记并按数据序列化。原用户消息与工具结果保持角色，不把原始日志移动到 system 消息中。
- 投影必须位于完整工具结果组之后，不能拆散工具调用与结果的配对。
- 压缩前后的请求组装、手动占用查询和运行中的 Token 估算使用同一套诊断工具/简报投影，不能分别维护不同列表。
- 复用现有 beforeProviderRequest、压缩及恢复顺序：刷新事实，计算完整请求，必要时压缩，再从持久化事实刷新。新适配器不复制 Provider 调用实现。

### 6.3 Run 与任务身份

Chat Run 创建时绑定当时的活动 Diagnose 身份，后续队列处理沿用该绑定。切换右侧历史任务只改变展示选择，不能改变运行目标。每次诊断工具执行前复核任务仍活动且绑定一致，避免旧 Run 修改新诊断。

普通 Chat Run 结束只清理执行绑定，不结算诊断。后端重启保留任务和记录，但不自动恢复模型执行、重放命令或恢复一次性权限；未完成的结论请求按已有 Run/Queue 事实显示可重试状态。

## 7 用户动作与 API

独立 REST 根路径为 `/api/sessions/{sessionId}/diagnoses`：

| 方法与后缀 | 语义 |
|---|---|
| POST 根 | 开始或定位活动任务，接受 requestId 和可选问题/当前模型选择；通过 Coordinator 衔接首次 Chat 意图 |
| GET /active | 查询活动任务元数据，没有则返回 null |
| GET /{id} | 查询指定任务元数据，不包含结论全文 |
| GET /{id}/nodes | 按 sequence 分页查询节点，默认最近 20 条、最多 50 条 |
| POST /{id}/conclusion-requests | 幂等请求整理结论，通过既有 Chat Run 或队列执行 |
| GET /{id}/conclusion | 返回已保存 Markdown；不存在时返回明确的未就绪结果 |
| POST /{id}/cancel | 不调用模型直接退出，提交 cancelled 终态 |

所有入口按 Session 与任务身份校验。模型修改节点和提交结论只走工具用例，不开放前端任意 PATCH 节点或伪造结论的接口。

### 7.1 打开与提问

菜单选择 Diagnose 时只在聊天框准备 `/diagnose ` 草稿，用户补充问题后手动发送；不立即创建任务或提交默认消息。显式发送 `/diagnose` 时，无活动任务则创建并打开页面，再提交一次简短的用户诊断意图；缺少问题由 AI 询问。携带问题时保留原问题及附件，交给原 Chat 链路。

已有活动任务时，菜单同样先准备可编辑草稿；显式发送无参数命令只定位原 Tab，携带问题则作为该任务的普通后续消息。新建业务模式要求 Session 没有正在创建或执行的 Chat Run，已有任务的定位不受此限制。

任务创建与首次模型启动分开处理故障：启动失败时保留已创建任务并显示错误，重试只提交对话，不重复创建任务。Coordinator 通过 requestId 处理网络重试。

### 7.2 请求结论

Coordinator 负责校验活动身份、记录请求关联并调用现有 Chat 能力：

- 没有活动 Run 时，使用当前选择或 Session 最近模型启动正常 Run。
- 有绑定当前诊断的活动 Run 时，使用既有 follow_up 队列提交明确的整理结论请求，不创建并行 Run；界面显示已排队，原队列能力仍可将其提升为引导。
- 请求正文表达“根据已有排查信息整理结论并结束本次诊断”，不自动触发额外排查循环。
- API 返回实际 Run 或队列项的关联。前端复用从 submit 中提取的通用 Run 附着能力，不复制一套 SSE、消息恢复或模型选择逻辑。
- 同一在途结论请求不重复入队；请求状态从关联的 Run/Queue 事实恢复，不根据聊天文字判断。失败或取消后允许显式重试。
- 模型普通回复结束、请求已消费或按钮点击成功，都不能代替 diagnose_finish 的业务提交。

结论生成失败时保持任务 active，保留记录并提示重试或直接退出。不存在前端自动循环调用模型的补偿逻辑。

排队的整理请求被消费前，若任务已经结束，直接使用已保存结果或取消该整理请求，不能再次启动结论生成或重新开启模式。

### 7.3 直接退出与竞争

直接退出不依赖模型可用性。先在短事务内收口当前节点并将任务提交为 cancelled，使后续写入立即失效；提交后发布事件，再由 Coordinator 中止并收敛绑定的在途 Run，取消尚未消费的本次结论请求。无关的队列内容不被诊断模块擅自清空，继续按原 Chat 取消规则处理。

任务终态和命令进程状态分别处理：退出不能撤销已经发生的远端副作用。Run 中止失败时显示实际错误并继续按现有清理能力处理，不能因此把任务恢复为 active，也不能宣称远端进程已经停止。

模型完成与直接退出竞争时，使用原子条件写入，以第一个提交的终态为准。持久化失败不得先显示结束成功；重复退出、重复完成和迟到输出不能覆盖终态或重新激活模式。

Session 删除屏障覆盖诊断请求。短操作和 Chat Run 持有相应租约，跨轮活动模式不长期占用执行租约或阻止删除。

## 8 实时事件与历史入口

在 Workspace SSE 中新增 `diagnoses` topic，复用已有独立事件 origin 和客户端事件地址生成能力：

- `diagnose.task.updated`：任务元数据、revision、结论可用标记及请求关联。
- `diagnose.node.updated`：新增或更新节点，包含任务身份、sequence 和 revision。
- `diagnose.message.created`、`diagnose.message.updated`：正式历史入口的变化。

事件不推送整篇 Markdown。前端按 Session/Workspace/任务身份和 revision 校验、去重；重连通过 REST 对齐活动任务、所选任务及节点，不能依赖进程内 SSE 序号跨重启重放。

任务和节点分别按各自 revision 归约。同一次变更的任务事件先到时，不能据此丢弃随后到达的节点事件；缺少节点或分页存在缺口时通过 REST 补齐。

每个任务保存一条稳定 custom 历史消息，类型为 diagnose，ID 为 `diagnose:<taskId>`。创建时与任务同事务写入；标题/结束更新沿用该身份，结束时定位到结束处，不为每个节点追加聊天卡片。

历史入口继续由统一 Chat 历史接口返回，不能再增加一条前端独立诊断历史分页后按时间混入消息的链路。历史入口只带身份、标题和简短状态，不包含报告全文。UI 消息必须从模型请求和压缩输入中统一过滤。

打开旧任务只读回显，不激活诊断模式；历史选择与活动绑定使用不同字段管理。事件更新活动任务时，不抢走用户当前查看的历史任务。

## 9 前端页面与展示行为

### 9.1 Tab 与记录页

- 复用通用容器的停靠、放大、收起和保留挂载能力。Tab 标题使用 Diagnose，页内显示本次问题标题及整体状态。
- 单列、按发生顺序排列；方向为节点标题，状态使用浅底色标签，说明位于下方。
- 诊断中使用蓝色，已确认使用绿色，暂未确定使用暖黄色，任务已结束使用中性灰。标签保留文字，不能只靠颜色区分。
- 当前节点默认展开；历史节点默认显示方向、状态和一行说明预览，可独立展开。预览由已有说明截取，不新增模型摘要字段。
- 当前节点更新原地替换；追加下一节点时只展开新节点，不强制折叠用户已经展开的历史。
- 用户跟随底部时随新内容移动；回看历史时保持阅读锚点并显示“有新记录／回到当前”。分页加载旧记录也要保持锚点。
- 页面不展示固定总步骤、完成百分比、证据关系图或重复的当前摘要卡片。
- Tab × 仅隐藏展示，活动任务保留；重新定位恢复原任务。隐藏、放大和收起不触发业务创建或结束。

### 9.2 结论阅读页

结论保存成功后原操作变成“结论”。用户点击后在同一个 Tab 切换到独立文本页，提供“返回诊断记录”。两个视图各自保存阅读位置，切换不销毁节点展开状态。

正文使用 Markdown 排版，支持标题、段落、列表、引用、表格与代码块；不包成一组结论卡片，也不使用只读 textarea 代替阅读页面。沿用已有 Markdown 依赖与链接处理规则，禁止原始 HTML 执行。放大后正文最大阅读宽度 920px，窄屏自然换行，宽表格和代码块在自身区域处理溢出。

只在确有已保存正文时提供入口。直接退出且无报告时显示已结束，不提供空的结论页。报告读取失败展示重试，不重新生成报告、不重新激活模式。

窄屏使用既有容器高度与放大能力，精简页头和固定操作区；不通过改造全局任务布局挤出新的多栏阅读区。

## 10 代码质量与评审要求

### 10.1 防止职责继续杂糅

1. 诊断状态转换集中在领域规则和 DiagnoseService，禁止在工具、路由、Hook 中分别实现推进规则。
2. 用户动作与 Chat 的多步衔接集中在 Coordinator，不能散落在 ChatConsole 的多个回调中。
3. 模式绑定、工具与简报集中在 DiagnoseRuntime；工厂负责组合，不保存另一份诊断事实。
4. 保持一个任务实体和清晰命名，禁止让“Run”同时指诊断业务任务与模型执行；变量明确区分 activeTaskId、selectedTaskId、chatRunId、currentNode。
5. 抽取复用能力必须对应实际共性：传输、事务、历史投影、Markdown 或运行时装配。不得把 Deploy 的计划审阅、阶段失效和重做语义带入 Diagnose。
6. 不为减少几行重复创建通用工作流配置框架；也不以暂时方便为由复制整个 Deploy Hook 或运行时回调。

### 10.2 类型、错误与界面边界

- TypeScript 遵循 erasable syntax，不使用 enum、namespace、参数属性、不必要的 any、内联动态 import 或 as unknown as 绕过边界。
- REST、SSE 和数据库 JSON 从 unknown 显式解析，错误保留 code/message/field 及必要细节；只在相应边界转换。
- 业务字段的限制与状态名称集中定义，前后端转换有独立测试，不在组件中散落字符串判断。
- 结论内容不从聊天正文抓取，任务状态不从模型措辞推断，界面不提前伪造已保存或已结束。
- 网络请求取消和 Session 切换使用作用域身份；迟到响应不能清空新页面草稿、改变当前选择或覆盖较新 revision。
- 节点组件、Markdown 和状态标签保持展示职责；网络、订阅及滚动分别有确定所有者。
- 新增业务通常不需要增加外部依赖。确有必要时遵循精确版本及 ignore-scripts 安装规则。

### 10.3 实现评审的否决项

出现以下情况应先修正，再进入后续验收：

- 在 ChatService 或运行时工厂内新增大段诊断提示词、节点转换或结论生成实现。
- 在 ChatConsole 中新增完整的创建、排队、总结、取消业务编排。
- 通用 TaskContainer 导入 Diagnose 或根据类型处理其生命周期。
- 只有提示词保证历史不可改，Service/Repository 没有强制条件。
- 为记录节点而反复人工审批，或要求每次工具调用都维护记录。
- 复制现有 Provider/Agent Loop、SSE 恢复、Chat 分页或 Markdown 解析器。
- 通过刷新 manifest 摘要掩盖没有核对的源码和功能文档差异。

## 11 实施顺序与验收

按以下顺序形成可独立检查的增量，不提交或发布版本，除非用户另行要求：

1. 完成领域规则、Repository、migration、互斥策略和临时 SQLite 回归。
2. 完成三个工具、DiagnoseRuntime 和轻量简报，用 faux 模型验证跨 Run、压缩及工具刷新。
3. 完成 Coordinator、REST、SSE、统一历史入口与结论请求恢复，覆盖并发和失败。
4. 完成独立前端模块、Tab 接入、记录页和结论页，验证展示状态与阅读位置。
5. 复核职责边界、当前功能文档和源码映射，执行定向测试及根检查；视觉与真实服务验证分别记录。

### 11.1 后端与模型回归

- 创建、重复创建、跨 Session 访问、Deploy 双向互斥及并发创建。
- 标题单独更新不新增节点；当前节点可重复修改；历史节点在 Service 和 SQL 层均不可更新。
- 追加要求终态与非空说明；暂未确定可正常转向；缺少当前节点和非法状态返回可修正错误。
- 同一 Tool Call 重放不重复追加；不同调用按序保存；结束、直接退出和迟到调用竞争不破坏终态。
- 结论正文与终态原子提交；数据库失败不出现假完成；无根因也可提交报告；直接退出不依赖模型且为 cancelled。
- 普通 Run 完成、停止和 Provider 失败后，诊断活动模式仍保留；结论请求失败可重试，重复在途请求不重复排队。
- 多轮、压缩、模型切换与后端重开后，从持久化任务恢复模式；不自动重放命令。
- 简报只有三项、不会无界累积，不拆分工具结果组；UI 历史消息不进入模型或压缩输入。
- 诊断元数据工具免审批，普通命令、Terminal、SFTP、只读模式和 Guard 行为保持原有规则。

建议后端测试文件：`test/diagnose-service.test.ts`、`test/diagnose-sqlite.test.ts`、`test/diagnose-runtime.test.ts`、`test/diagnose-api.test.ts`；在现有 Chat、压缩、历史分页和权限测试中补充必要的接入回归。

### 11.2 前端与交互回归

- 创建/定位、隐藏/恢复、当前与历史任务选择、刷新和 Session 切换。
- 多个节点独立展开、当前更新、追加、旧记录分页和用户回看时的阅读位置。
- 状态标签明暗主题、长标题、长说明、窄屏与容器放大。
- 整理请求的排队、重复点击、失败、停止、重试和直接退出。
- 报告保存后才出现结论入口；记录页与阅读页往返保留状态；长 Markdown 和获取失败可读、可重试。
- SSE 重复、乱序、断线重连、迟到 REST 和历史选择不被活动事件抢走。
- 中文/英文文案、键盘展开、可见焦点、状态文字与颜色辅助。

建议前端测试文件：`tests/diagnose-task.test.tsx`、`tests/use-diagnose-races.test.ts`、`tests/diagnose-conclusion.test.tsx`。不把静态渲染测试声称为浏览器视觉验收。

### 11.3 检查与文档维护

代码完成后按仓库约定运行改动涉及的定向测试和 `npm run check`。不运行完整 pi 基础模块测试，不调用真实 SSH、付费模型或生产数据，除非另获授权。完整 build 和本地运行验收按授权范围执行。

新增 `docs/ssh-agent/ai-repo/diagnose.md` 作为已实现行为的聚焦路由，补充 index 和 manifest 映射；同步核对受影响的 Chat Runtime、Session Prompt、Context Compaction、任务容器、SQLite、HTTP、前端与语言目录文档。只有阅读并校正受影响源码及功能文档后，才能更新 manifest 摘要，并再次通过 `npm run check:ai-repo`。

本文保留目标、职责与实施约束；实施完成后单独追加结果与验证范围，不能仅修改“状态”就将全部目标宣称为已实现。


## 12 实施结果与验证范围（2026-10-19）

已完成领域与 SQL 约束、三个串行工具、跨 Chat Run 绑定、轻量简报、原 Chat Run/队列结论请求、直接退出、REST/SSE、稳定历史入口及独立 Diagnose 前端模块。Tab 展示方向/状态/说明，状态有底色；结论保存后才提供独立 Markdown 阅读页。未增加证据关系、固定流水线或新的模型调度循环。

代码职责按第 4 节拆分，通用 TaskContainer 无业务改动。ChatService、Runtime Factory 和 ChatConsole 仅接入端口、回调与页面装配；UI 历史过滤提取为 chat-ui-history-message.ts。代码质量检查涵盖 unknown 边界校验、集中输入限额、提交后事件、条件更新、SQL 历史不可改、回执与结论原子性、实体独立 revision 和 Session 迟到响应隔离。

落地时作了两项技术选择：

1. 在三个业务表以外，用 diagnose_chat_runs 与 diagnose_requests 两张轻量关联表保存真实 Chat Run/Queue 身份及请求去重；不新增独立执行状态、报告实体或调度器。这样重启和网络重试仍能沿用已有 Chat 事实。
2. 三项简报投影到可替换的临时请求头部片段，基础 Prompt 快照保持原文，不向消息数组插入临时简报。工具调用与结果因此保持原连续组；活动请求、离线估算和手动压缩使用同一适配器，自动压缩/超限恢复前后继续刷新。这替代了第 6 节设想的组后消息插入位置，仍保持三项、限长与不累积原则。

验证使用临时 SQLite、文件数据库重开、合成凭据、faux 模型、真实 React 静态输出与确定性 Hook 驱动：

- 后端 12 个定向文件共 159 项通过，包含诊断服务/API、部署模式、Chat 运行装配/生命周期、权限、结论队列、压缩、历史分页及国际化；v11 升级回归同步验证最新 v35。
- 前端 27 个定向文件共 275 项通过，包含诊断展示、Markdown 安全、乱序/迟到响应、历史选择、隐藏恢复、直接退出竞争，以及 Chat、任务容器、菜单、文件阅读器、语言目录、监控和 Terminal 回归。
- 根 `npm run check` 通过，包含 39 份功能文档映射、沙箱资源、模型目录及前后端类型检查；`git diff --check` 通过。

接入后处理了两项共享入口回归：原本各功能独立打开 Workspace SSE，新增 Diagnose 会让完整 Chat 页面超过 HTTP/1.1 六连接额度；现按 Workspace + Locale 复用 topic 并集，让完整场景保持四条长连接，业务解析和重连补读仍归各 feature。普通发送恢复直接附着 Run，不并发新增历史水合；临时气泡按 requestId 绑定 runId 后与 REST/SSE 合并，同步 ref 阻止同 render 重复请求。诊断历史入口按 taskId 及 revision 合并，结束移动位置不新增第二张卡片。

功能回归没有调用真实 SSH 或付费模型，没有运行构建、启动服务或完成浏览器视觉验收。用户反馈故障后仅只读查询指定会话的现有 SQLite 事实和本机连接占用，未修改业务数据；这些事实与本地回归不能代替新代码在实际页面的 Terminal/Chat 联调，也不能代替真实模型诊断效果、窄屏/主题视觉与实际滚动体验验收。后续修改先从 [Diagnose 功能路由](../ai-repo/diagnose.md) 定位源码，不在此复制最新接口实现。

## 13 聊天记录回显与 Deploy 复用（2026-10-19）

按用户要求参考 Deploy 接入诊断记录回显，并合并共用实现：

- `features/chat/model/conversation-history.ts` 统一识别聊天中的 Deploy/Diagnose 正式记录，不再把整个聊天条目类型和识别函数放在 Deploy 模块。
- `features/chat/model/task-completion-history.ts` 负责已完成工具替换、混合 Assistant 内容拆分、唯一记录入口、SSE/历史结果 JSON 边界及原失败报告保留。
- Deploy/Diagnose 各自的 completion-history 适配器只判断自己的工具结果、业务 ID 与结束状态。诊断要求工具确实 completed、非错误、conclusionAvailable=true，并匹配同 taskId 的 completed 正式卡片；两类任务不共用业务生命周期。
- `features/diagnose/model/diagnose-history-entry.ts` 持有诊断入口类型和元数据校验，DiagnoseHistoryCard 只展示标题、状态及打开原 Tab 的动作。已完成诊断在结束工具位置回显一次，活动/取消任务仍按后端 sequence 显示入口；完整节点和 Markdown 结论继续从原任务页查看。
- 本轮不改数据库、API、模型 Context 或持久化工具结果，不另建前端历史分页，也不复制一份诊断执行流程。

新增 diagnose-completion-history.test.tsx，覆盖三种状态、双语、实时/恢复结果、重复结束、缺失/无效/错误/未完成结果、卡片迟到、正文/普通工具/错误保留，以及同业务 ID 的 Deploy/Diagnose 混排。相关前端 13 个测试文件、168 项测试通过；根 npm run check 和 git diff --check 通过。失败展示、文件阅读器与会话 Prompt 的职责和原行为已复核。未构建、重启服务或进行浏览器视觉验收。
