# 沙箱与工具授权重构：计划和续写上下文

初始记录日期：2026-10-09；最近核对日期：2026-10-10（Asia/Shanghai）。本文件供另一台电脑继续开发，记录已完成阶段与剩余建议；当前行为以源码和 [AI 代码路由](../ai-repo/index.md) 为准。旧的 [ChatService 拆分计划](./chat-service-refactoring-plan.md) 是历史结构规划，不能替代当前代码核对。

## 1. 用户目标与设计约定

最近几轮任务围绕沙箱、审批和工具执行之间的边界展开：

1. 工具调用失败，若错误可由模型调整参数或后续操作来处理，应将失败结果交回模型；不能因为本次调用被拒绝就直接终止整个 Run。
2. `ChatToolAuthorizationPolicy.prepare()` 不应集中持有每个工具的模式冲突检查、参数解析和具体审批逻辑。工具相关规则由工具模块持有，策略类保留分发和公共协调职责。
3. 授权阶段已经决定执行权限，执行阶段应直接收到本次调用的计划；不能通过共享 Store 中是否存在审批理由，再重新推导权限。
4. `approvedJustification()` 名称和职责不清晰。优化应消除“理由字符串存在就选择 Full Access”的隐含约定，而不是只重命名。
5. 拆分命令和 Terminal 的重型编排方法，使执行期策略、状态修改、资源准备与真正执行分别有明确所有者。
6. 区分沙箱能力查询与主动刷新，提取共同探测逻辑和诊断，并将历史兼容收敛到持久化读取边界。

必须保持的约定：

- 自动审批 `autoAudit` 决定是否等待人工确认，不改变沙箱约束。
- Full Access 必须按准确调用取得人工授权，审批来源必须为 `user`；执行计划不能替代一次性 grant。
- Full Access 不绕过 Workspace Guard，也不提升 SSH 账号自身权限。
- 沙箱失败或权限拒绝不自动升级权限，不自动重放命令；可能有部分副作用时先检查执行事实。
- Terminal 的沙箱在开启长周期 PTY 时安装，不能把普通命令的一次性 Full Access 机制直接套到运行中的 PTY。
- 通用 Agent Core 不依赖 SSH、沙箱或应用审批类型。

## 2. 已完成的六个阶段

阶段 A–C 随 `410342a` 完成；阶段 D–F 分别随以下三笔提交完成，均已推送到 `origin/dev`。不要把阶段 D–F 当作剩余重构任务重复实现。

| 阶段 | 提交 | 职责 |
|---|---|---|
| D | `d5bd533` | 命令执行策略与状态记录拆分 |
| E | `b72c15c` | Terminal 输入策略、状态记录与通道启动拆分 |
| F | `3be0c9a` | 沙箱能力查询/刷新、共同诊断与历史事实读取 |

### 阶段 A：统一可修正错误反馈

状态：已完成。

- 错误模式、当前工作流不允许的工具调用、相对或非法 `write_paths`、Full Access 理由缺失/参数组合错误，以及 Terminal 输入无效/超限等返回可修正 Tool 错误。
- 新增 `toolRequestError()` 和 `authorizationFailure()`，统一已知请求错误的处理。
- 普通远端命令执行失败继续保留输出尾部、SSH Failure、执行状态和沙箱审计事实，返回模型处理。
- Guard 硬阻断、用户拒绝、审批超时、主动取消与基础设施故障保留各自的停止语义。

注意：`terminate` 是批次停止提示。Agent Core 只有在整批最终工具结果都要求终止时，才按该提示提前结束；不要将单条 Tool 失败与 Run 失败混为一谈。可修正错误一般不显式写出 `terminate: false`，省略该标志同样不要求终止。

### 阶段 B：工具持有具体规则，缩小策略类

状态：已完成。

- Runtime Factory 根据冻结的 Run 模式和部署工作流装配工具可用性。
- `unavailableTool()` 在 `prepareArguments()` 阶段拒绝不适用调用；直接 `execute()` 也拒绝，因此不会先创建审批或产生执行副作用。
- `restrictTerminalWorkflow()` 在 Terminal 工具边界检查部署期间的控制键冲突。
- 远端命令、Terminal、Bubblewrap 安装、部署远端阶段各自在工具模块中提供审批准备函数。
- `ChatToolAuthorizationPolicy.prepare()` 分发工具自有逻辑并统一已知请求错误，保留共享 `autoAudit` 读取、部署 Run 绑定和授权记录。
- Terminal 审批结果通过准备方案中的 `onDecision` 回写 Interaction；策略类不再自己组装 Terminal 的 approve/reject 细节。

没有将策略类改成无规则的通用注册框架，也没有引入第二套审批等待机制。

### 阶段 C：明确普通远端命令的授权与执行交接

状态：已完成，范围为 `remote_server_call`。

新增不可变 `RemoteCommandExecutionPlan`：

| 字段 | 含义 |
|---|---|
| `agentRunId` / `sessionId` / `toolCallId` | 本次调用身份；无 Chat Run 的独立调用有兼容受限执行路径 |
| `request` | 原参数快照，包含命令、cwd、timeout、模型声明的权限/理由/写入路径 |
| `access` | 授权阶段选定的执行模式；Full Access 同时保存本次例外理由 |
| `expectedTarget` | 授权阶段解析的 SSH 目标快照，用于派发前复核 |

原请求和调用身份在第一个异步检查前复制。请求、写入路径数组、权限对象、目标快照和计划对象均冻结。

提交前重新验证时发现工作区源码与此前验证状态不一致：异步 Guard 后重新读取可变 Run 身份，使现有快照测试失败。已通过授权入口的 `callInput` 快照补齐身份绑定，保持现有准备函数接口和审批规则不变；相关测试继续覆盖等待期间 Run 身份变化。

现在的调用链：

```text
Agent 参数准备和 schema 校验
  -> ChatToolCallCoordinator.beforeToolCall
    -> ChatToolAuthorizationPolicy.prepare
      -> prepareRemoteCommandAuthorization
        -> 请求快照、Guard、沙箱路由、RemoteCommandExecutionPlan
    -> ChatApprovalService.request
    -> 校验 Full Access 的批准来源
    -> recordDecision（必要时记录一次性 grant）
    -> 返回 { executionContext: plan }
  -> Agent 内部 PreparedToolCall 保存本次 executionContext
  -> Tool.execute(id, params, signal, onUpdate, executionContext)
    -> 检查计划类型、调用身份、原参数一致性
    -> CommandOperationService.submit（直接使用 plan.access 和 expectedTarget）
      -> FIFO / Guard / grant 消费 / 目标复核 / 沙箱准备 / Guard / Broker
```

关键结果：

- `BeforeToolCallResult.executionContext` 和 `AgentTool.execute()` 第五个参数是通用内部扩展，类型为 `unknown`；应用工具自己识别具体计划。
- 上下文按调用隔离，顺序和并行执行都不串用；它不自动进入模型参数、transcript、SQLite Chat 消息或 Agent 事件。
- 可用性包装器会继续转发该上下文；没有上下文时保留原来的四参数调用方式。
- 普通 Chat 远端调用必须带匹配计划，缺少计划或身份/参数不一致时在 `submit()` 前拒绝，并返回非终止 Tool 错误。
- 已删除 `RemoteSandboxApprovalStore.approvedJustification()`；远端 Tool 和其运行时装配不再依赖 Store 来选择模式。
- Store 保留 grant 签名和目标签名，负责一次性验证、消费及 Run 清理。授权已消费或清理后，旧 Full Access 计划仍执行失败，不隐式降回沙箱。
- `expectedTarget` 随计划传入命令服务，受限命令同样复核授权阶段确定的目标。Workspace 身份、凭据、用户、默认目录等被比较字段变化时拒绝派发。

### 阶段 D：拆分命令执行编排

状态：已完成。

- `CommandOperationService.executePending()` 保留步骤顺序、超时/取消管理、Broker 调用与结果分类。
- `CommandExecutionPolicy` 负责排队复检、执行期 Guard、一次性 grant 消费以及目标/cwd 校验，不修改 Operation 状态或派发命令。
- 每次调用的 `CommandOperationRecorder` 负责状态转换、时间、输出限额、事件、沙箱确认事实和重启恢复，不决定权限。
- 保留调度后读取记录期间的取消/超时复检、准备前后的两次 Guard 及 grant/expectedTarget 两种绑定检查；这些检查覆盖不同等待边界，不能当作重复条件删除。

当前流程和定位见 [命令执行](../ai-repo/command-execution.md) 与 [Guard](../ai-repo/guard.md)。

### 阶段 E：拆分 Terminal 编排与通道启动

状态：已完成。

- `TerminalInteractionPolicy` 负责 Actor 绑定、审批已结束检查、输入规范化、Guard 和取消检查；`TerminalInteractionRecorder` 负责 Interaction/Input/Observation 的持久化状态和审计事件。
- `TerminalInteractionService` 保留幂等结果、互斥槽、交付游标、PTY 写入和 Observation 编排。执行使用已保存的输入，不按重试参数替换已审批 bytes；写入不确定时不自动重放。
- `TerminalSessionService` 保留幂等打开、前置检查和资源所有权交接；Actor 负责激活或失败落库。`TerminalChannelOpener` 负责目标解析、沙箱准备、PTY 打开及覆盖全流程的 deadline、取消与迟到通道清理。
- Terminal 仍只开启受限 PTY；这次职责拆分没有引入 Full Access 入口，也没有把 submit 改为普通远端命令的执行计划。

当前流程和定位见 [Terminal](../ai-repo/features/terminal-interaction.md)。

### 阶段 F：整理沙箱查询、刷新、诊断与历史兼容

状态：已完成。

- `RemoteSandboxCapabilityProvider` 用 `getCapabilities()` 表达普通查询，用 `refreshCapabilities()` 表达主动重新发现，替代含义混杂的 `probe()` 端口。查询直接生成校验后的能力事实，不构造虚拟 `true` 命令或执行确认 nonce。
- `SandboxCapabilityCache` 只缓存成功的后端元数据，按完整 Connection Key 与 generation 隔离，并合并发现/刷新等待；目录、设备和 Bubblewrap 实际约束仍逐次检查。能力事实不是命令已经受约束执行的证明。
- `RemoteSandboxRules` 共用文件规则检查；`SandboxCommandRunner` 共用准备命令与限长诊断，保留检查阶段、退出码/信号、stderr、原始 cause 和已有 SSH 失败语义。公开 HTTP/SSE 继续通过稳定 code 本地化。
- `stored-command-sandbox.ts` 和 `stored-terminal-sandbox.ts` 在 SQLite 读取边界校验新旧事实。历史 `approvedAt`、`source/detectedAt` 与 null 格式不参与新调用的权限选择；没有新增 schema migration。
- Chat/部署预检与安装必要性检查使用查询；Overview 手动检测及安装完成后的验证使用强制刷新。

当前流程和定位见 [远端沙箱](../ai-repo/remote-sandbox.md)、[SQLite 持久化](../ai-repo/sqlite-persistence.md) 与 [多后端设计](./remote-sandbox-backends.md)。

## 3. 当前边界：哪些还没有迁移

截至最近核对，以下仍不是已实现能力：

- `bubblewrap_install` 还没有使用 `RemoteCommandExecutionPlan` 交接。审批阶段生成准确安装命令并记录 grant；安装服务执行时仍按安装参数生成命令并重新检查安装条件。grant 绑定命令和审批时目标，命令服务继续验证，不是无授权执行。
- Terminal submit 仍以 `preflightSubmit()`、`onDecision` 和已保存的 Interaction/Input 完成审批与执行交接；策略和记录职责已拆分，但未迁移到统一的执行计划类型。
- 部署 RESTART/VERIFY 继续使用部署计划、部署专属审批和 `fullAccessApprovalScopeId`，不与普通 Chat Tool grant 混用。
- SFTP 覆盖审批仍在 Tool 内发生，Coordinator 保存调用与 assistant message 的关联。SFTP 不经过命令沙箱。
- 本轮没有新增 Terminal Full Access 请求工具，也没有修改 Terminal 开启策略。
- 没有数据库 migration、HTTP/SSE 契约变更或前端功能改动。
- 没有在真实 Linux 服务器上验收本轮改动；模拟测试不能证明所有实际后端或 PTY 行为。

## 4. 源码阅读入口

下表路径均相对仓库根，方便跨电脑定位。

| 阅读顺序 | 文件 | 关注点 |
|---|---|---|
| 1 | `packages/ssh-agent/src/application/tools/tool-authorization.ts` | 公共错误契约、准备方案、可用性包装器 |
| 2 | `packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts` | 审批准备分发与决策记录 |
| 3 | `packages/ssh-agent/src/application/tools/remote-command-execution-plan.ts` | 不可变计划、请求签名和 grant 请求构造 |
| 4 | `packages/ssh-agent/src/application/tools/remote-server-call-tool.ts` | 授权准备、计划校验和执行提交 |
| 5 | `packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts` | 等待审批、批准来源检查和计划交接 |
| 6 | `packages/agent/src/types.ts`、`packages/agent/src/agent-loop.ts` | 通用 executionContext 传递及批次行为 |
| 7 | `packages/ssh-agent/src/application/services/remote-sandbox-approval-store.ts` | 准确一次性 grant 的验证/消费/清理 |
| 8 | `packages/ssh-agent/src/application/services/command-operation-service.ts` | 排队后的执行编排、超时/取消与结果分类 |
| 9 | `packages/ssh-agent/src/application/services/command-execution-policy.ts`、`packages/ssh-agent/src/application/services/command-operation-recorder.ts` | 执行期策略与逐次状态/输出/审计记录 |
| 10 | `packages/ssh-agent/src/application/services/terminal-session-service.ts`、`packages/ssh-agent/src/application/services/terminal-interaction-service.ts` | Terminal 资源创建、幂等、PTY 写入和 Observation 编排 |
| 11 | `packages/ssh-agent/src/application/terminal/terminal-interaction-policy.ts`、`packages/ssh-agent/src/application/terminal/terminal-interaction-recorder.ts`、`packages/ssh-agent/src/application/terminal/terminal-channel-opener.ts` | 输入检查、持久化记录与通道准备/清理 |
| 12 | `packages/ssh-agent/src/application/services/remote-sandbox-provider.ts`、`packages/ssh-agent/src/infrastructure/sandbox/remote-sandbox-coordinator.ts` | 查询/刷新端口及后端选择 |
| 13 | `packages/ssh-agent/src/infrastructure/sandbox/sandbox-capability-cache.ts`、`packages/ssh-agent/src/infrastructure/sandbox/sandbox-command-runner.ts`、`packages/ssh-agent/src/infrastructure/sandbox/remote-sandbox-rules.ts` | 元数据发现、限长诊断和逐次文件规则检查 |
| 14 | `packages/ssh-agent/src/infrastructure/sqlite/stored-command-sandbox.ts`、`packages/ssh-agent/src/infrastructure/sqlite/stored-terminal-sandbox.ts` | 新旧审计事实解码与状态约束 |
| 15 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`、`packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts` | 可用性和共享组件装配 |

后续评估安装、Terminal、部署时，再完整阅读各自工具和服务；不要仅根据字段名或本文件推断流程。

当前功能文档：[Chat Runtime](../ai-repo/chat-runtime.md)、[命令执行](../ai-repo/command-execution.md)、[远端沙箱](../ai-repo/remote-sandbox.md)、[Terminal](../ai-repo/features/terminal-interaction.md)、[部署](../ai-repo/deployment.md)。相关 manifest 映射和 source digest 已同步。

## 5. 后续计划建议

下面是尚未完成的评估建议，不要求一次完成全部工具改造。命令/Terminal 的职责拆分、查询与刷新解耦、共同诊断和历史读取边界已在阶段 D–F 完成。

### 下一步 1：先审查交接方案的边界

- 对照源码确认每个检查的唯一职责：工具可用性、Guard、审批、计划绑定、grant 消费、SSH 目标复核和沙箱强制约束。
- 检查“缺少内部计划”属于装配错误时，是否仍适合向模型返回可修正错误；当前行为为非终止错误，若调整应作为明确的行为决定并增加测试。
- 检查非 Chat 的独立工具兼容路径是否仍有调用方；不要未经核对删除公开后端入口。
- 不为追求统一而让 Agent Core 理解 SSH 类型，不新增共享计划 Map 来替代直接传递。

验收：能说明每层检查的目的，且同一调用的实际模式只来自已经选定的方案；授权失效、目标变化和请求变化均不能误执行。

### 下一步 2：评估 Bubblewrap 安装是否采用相同交接方式

- 阅读 `bubblewrap-installation-tool.ts`、`bubblewrap-installation-service.ts` 和 `bubblewrap-installation-approval.test.ts`。
- 评估将审批时生成的准确命令、超时、理由和目标直接交给安装执行入口，减少重复组装。
- 安装前重新检测环境与消费人工 grant 仍有独立目的，应保留必要的执行期检查。
- 先决定使用独立安装计划还是复用命令计划；不要为了复用强行扩大普通远端 Tool 的模型参数定义。

验收：人工审批看到的命令就是执行器提交的命令；参数和目标变化拒绝；安装成功后继续自动探测；失败输出可交回模型提出新的人工审批方案。

### 下一步 3：分别评估 Terminal 和部署

- Terminal：基于已拆分的 Policy/Recorder 和持久化 Input，评估是否还有需要显式 submit 计划解决的交接问题；不要重复拆分现有编排。长周期 PTY 的权限不能靠单条输入临时取消。
- 部署：已有冻结计划、阶段状态和专属授权范围，优先复用已有职责；先检查是否真的存在断开的数据交接，再做改动。
- SFTP：覆盖审批发生于执行途中，有自己的文件身份和并发边界，不必强行套用命令计划。

验收：每个流程的授权与资源生命周期保持可解释；不增加重复状态，不串用授权范围，不改变未授权的产品能力。

## 6. 已完成验证与复现命令

阶段 A–C 提交准备时的验证记录为 13 个测试文件、237 个测试：Agent Core 2 文件 / 30 测试，SSH Agent 11 文件 / 207 测试。阶段 D–F 分批提交时，各批快照分别通过 `npm run check`；定向测试分别为 20、38 和 177 个，共 14 个文件、235 个测试。以下是对应阶段的验证记录与复现入口，不能代替后续修改后的重新验证。使用模拟 Provider/Broker 和本地测试环境，没有真实服务器凭据或付费模型调用。

仓库根执行：

```sh
npm run check
git diff --check
```

Agent Core 定向测试，从 `packages/agent` 执行：

```sh
node ../../node_modules/vitest/dist/cli.js --run \
  test/tool-execution-context.test.ts \
  test/agent-loop.test.ts
```

SSH Agent 定向测试，从 `packages/ssh-agent` 执行：

```sh
node ../../node_modules/vitest/dist/cli.js --run \
  test/remote-command-execution-plan.test.ts \
  test/remote-landlock-sandbox.test.ts \
  test/chat-tool-call-coordinator.test.ts \
  test/chat-tool-authorization-policy.test.ts \
  test/chat-agent-runtime-factory.test.ts \
  test/command-operation-service.test.ts \
  test/bubblewrap-installation-approval.test.ts \
  test/terminal-interaction-tool.test.ts \
  test/deployment-agent-tool.test.ts \
  test/file-tool-concurrency.test.ts \
  test/remote-sandbox-routing.test.ts
```

覆盖重点：模型收到错误后修正调用、冲突检查在审批前生效、人工 Full Access 来源检查、计划传递、请求/调用身份变化、SSH 目标变化、grant 一次性消费、拒绝与取消、顺序/并行上下文隔离和不进入消息/事件。

阶段 D–F 的专项回归入口包括 `terminal-interaction-service.test.ts`、`terminal-session-service.test.ts`、`terminal-node-runtime.test.ts`、`sandbox-capability-cache.test.ts`、`sandbox-command-runner.test.ts`、`bubblewrap-remote-sandbox.test.ts`、`remote-sandbox-coordinator.test.ts`、`sqlite-terminal-repository.test.ts` 和 `management-api.test.ts`，均位于 `packages/ssh-agent/test/`。它们覆盖执行顺序、取消/资源清理、不重放输入、并发刷新、诊断与历史事实读取；按修改范围选择相关测试。

`.gitignore` 已精确放行新增的 Agent Core 测试，避免本机 `.git/info/exclude` 的测试忽略规则将其隐藏。

## 7. 在另一台电脑接续

当前任务交付分支为 `dev`；阶段 A–C 位于 `410342a`，阶段 D–F 的三个提交见第 2 节。接续时先确认本地分支已包含这些提交。新克隆可执行：

```sh
git clone --branch dev https://github.com/daxingxing-six66/gori-agent.git
cd gori-agent
npm ci --ignore-scripts
npm run check
```

已有克隆先检查是否有未提交工作，再读取远端分支；本地尚无 dev 时执行：

```sh
git fetch origin
git switch --track origin/dev
```

如果本地已经有 dev，切换后使用 `git pull --ff-only origin dev`；若无法快进，先检查本地提交，不覆盖或强制重置。

继续开发前先阅读根目录 `AGENTS.md` 和 `agent.md`，再阅读本文件与相应 AI 路由、完整目标源码。映射源码变化后先核对文档，再运行 `node docs/ssh-agent/ai-repo/check.mjs --update` 和 `npm run check`。不要直接运行整个 pi 测试集，其中包含真实供应商集成测试。

可复制给下一次开发会话的接续提示：

> 请阅读 agent.md、docs/ssh-agent/ai-repo/index.md 和 docs/ssh-agent/design/sandbox-authorization-handoff-2026-10-09.md，核对当前 dev 分支源码。阶段 A–F 已完成：可修正错误契约、工具自有审批准备、普通 remote_server_call 的执行计划交接、命令/Terminal 编排拆分、沙箱查询/刷新解耦、共同诊断与历史事实读取。不要重复实现这些重构。先审查现有交接边界，再评估 Bubblewrap 安装是否需要直接传递审批时的执行方案；Terminal 与部署按各自生命周期单独评估。保留 Guard、人工 Full Access、一次性授权消费、目标复核、逐次文件规则检查和可修正错误反馈。
