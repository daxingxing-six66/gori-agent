# SSH 命令执行代码路由

适用于 `remote_server_call` Tool、Session 内 FIFO、进程并发限制、Command Operation、Guard 执行期校验、输出审计、失败分类和最终 Tool Result。


未传 `cwd` 的命令使用 Workspace `remoteDefaultCwd`，默认 `/`；显式 `cwd` 仍优先。Workspace 本地 `defaultCwd` 不参与远端命令目录解析。


Session 缺省开启沙盒，Command Service 在开启时缺省 `workspace_write`，在远端 Linux 启动器中执行，准备失败不自动回退。开启状态的普通 Chat Run 先探测有效沙箱与已声明写入路径：路径在可写范围内时，`autoAudit` 只决定自动还是人工批准，实际命令始终受沙箱约束；明确无可用后端或已知越界时，才申请带 `remote_sandbox_exception` 标识的一次性人工 Full Access 授权。显式 `full_access` 同样必须逐次人工批准。部署 RESTART/VERIFY 也按实际后端与目标路径选模式，受限步骤服从 `autoAudit`，例外步骤仍需逐条人工审批；部署授权与普通 Chat Tool 授权互不通用。准备后派发前再次复检 Guard。独立的 `SandboxConfirmationCapture` 按 waiting/confirmed/missing 状态处理 stderr 前缀，收到远端确认后才写入实际强制约束事实；确认缺失保守视为可能执行。权限拒绝可能留下部分副作用，新的 Full Access 尝试须另经人工批准，不自动重试。关闭 Session 沙盒时，授权与执行都通过统一策略直接选无沙盒模式，不探测、不调用 Provider 准备、不使用受限启动器或例外 grant，普通 `autoAudit` 审批与 Guard/目标/cwd 校验仍生效。来源进入审计，过期设置计划拒绝执行。完整边界见 [remote-sandbox.md](./remote-sandbox.md) 与 [session-sandbox.md](./session-sandbox.md)。

## 当前边界

- Agent 批次保留一个串行工具使整批串行的规则；remote_server_call 与 Terminal 工具均保持串行，文件工具的路径并发不会使同批部署命令提前执行。见 [文件工具并发](./file-tool-concurrency.md)。

Chat 的 `remote_server_call` 在创建人工审批前调用 `CommandOperationService.preflightGuard()`；批准后正式 `submit()` 仍会再次执行 Guard 校验，避免审批等待期间规则变化。

部署讨论和普通文字问答不执行远端命令。模型提案时，部署服务对重启和验证命令做同样的 Guard 预检，并冻结写入路径与 Session 策略/沙箱路由。用户核对提案后，绑定的执行 Agent 才逐阶段调用部署工具；RESTART/VERIFY 通过 `submit()` 进入相同的 Session FIFO 和审计链。仅 Full Access 例外创建部署专属 grant，使用 `fullAccessApprovalScopeId`，不冒用 Chat Tool Call 的 `agentRunId`；`expectedTarget` 保存计划的 SSH 身份，出队后解析的目标若变化就拒绝执行。Command Service 仍先复核 Guard、消费精确的一次性授权，再检查目标并派发；普通计划确认或 Chat Tool 审批不会自行产生部署 Full Access 授权。见 [deployment.md](./deployment.md)。

该 Tool 仅在普通交互模式可执行；两种模式保持相同 Tool schema，由 Runtime Factory 装配 Tool 可用性入口，在审批前的参数准备和直接执行入口拒绝错误模式调用。模式切换只追加 system 记录，见 [session-prompt.md](./session-prompt.md)。

错误模式调用、沙箱预检中的相对/非法 `write_paths` 以及普通远端命令执行失败返回可修正的 Tool 错误，`terminate: false` 使错误结果进入下一次模型请求；失败输出与结构化 SSH Failure 仍保留，模型可据此调整后续调用。Guard 阻断仍以 `terminate: true` 停止，用户拒绝审批和主动取消仍按 Run 生命周期处理。模型继续处理错误不代表自动重放命令或自动授予 Full Access。

`remote-server-call-tool.ts` 持有远端审批准备逻辑：Guard 预检、显式 Full Access 参数、沙箱路由与审批描述。`ChatToolAuthorizationPolicy.prepare()` 分发该函数，并通过共用 `authorizationFailure` 把已知请求错误转换为非终止结果；Runtime 的审批边界使用同一转换函数，探针/持久化/未知错误仍终止 Run。

授权与执行通过 `RemoteCommandExecutionPlan` 交接。请求在第一个异步检查前复制并冻结；计划显式保存 `access.mode` 和对应理由，同时绑定调用身份与 SSH 目标快照。审批通过后 Coordinator 将它放入内部 `executionContext`，Agent 直接交给本次 Tool `execute()`，不会修改模型参数或向事件/消息追加此上下文。Chat 远端 Tool 缺少计划、计划属于其他调用或原参数改变时，在 `submit()` 前返回非终止错误；它不查询 Store 重新决定权限，也不因 grant 缺失而降回沙箱。`expectedTarget` 随计划进入 Command Service，派发前目标变化会拒绝执行。没有 Chat Run ID 的独立 Tool 按当前 Session 设置执行；开启时仍保持默认受限路径，Full Access 例外不能仅由参数获得。

`executePending()` 按固定步骤编排：读取 Operation → 排队复检 → 记录 dispatching → Guard → 解析目标并复核 Session 策略、授权与 cwd → 在执行时限内按模式准备 → Guard 复检 → 记录 running → Broker → 确认与结果结算。`CommandExecutionPolicy` 集中执行期检查、一次性 grant 消费和统一的 Guard/排队失败构造，不修改 Operation 或派发命令；每次调用自己的 `CommandOperationRecorder` 负责状态、时间、Guard/目标审计、输出限额、事件和终态，Service 保留执行顺序、超时/取消资源管理及远端结果分类。新组件由 Command Service 内部装配，`submit()` 的外部契约保持兼容。

两次执行期 Guard 使用同一拒绝契约：出队时避免被禁止的命令进入准备，准备后覆盖远端探测期间的规则变化。调度器检查后读取持久化记录仍会异步等待，因此保留读取后的取消/排队超时复检，且超时边界同调度器统一为 `now >= deadline`。Full Access grant 的目标签名与调用方 `expectedTarget` 分别验证授权绑定和计划绑定，不能互相替代。派发前统一记录 `commandMayHaveRun=true/enforcement=none`，确认缺失时不重复赋值；只有远端确认后记录实际约束。

- Tool 接受 command、可选绝对 cwd（也支持 `~`/`~/...`）、timeoutMs、sandbox_permissions、justification 和已知绝对 write_paths；Session 由后端创建 Tool 时绑定，Workspace/主机/Credential 不进入模型参数。
- 命令先持久化，再进入按 `sessionId` 隔离的内存 FIFO；同一 Session 严格串行，不同 Session 可以并发。Command Operation 从创建记录前到终态持有 Session lifecycle lease；删除屏障先建立时，新命令不会进入持久化或队列。
- 进程级公平许可器默认最多允许 16 个 Operation 处于 dispatching/running，可由 `SSH_AGENT_MAX_CONCURRENT_OPERATIONS` 配置；每个 Session 同时最多有一个队首等待许可。
- `queued` 同时表示等待同 Session 前序命令或等待进程许可。排队达到 60 秒或派发前取消时会主动结束，过期项不会进入 Broker。
- 获得进程许可后读取并匹配最新 Guard，再获取 Channel。阻断会终止当前 Agent Run，并在所有终态路径释放许可。
- Operation 和内部事件写入 SQLite。stdout/stderr 前 10 MiB 持久化；超限只记录一次截断事件，LLM 获取最后 64 KiB。
- 非零退出、信号、超时、取消、传输结果不确定等使用结构化 SSH Failure。
- SSH Failure 持久化时保留规范英文 fallback，并可携带 message key/values；HTTP/SSE 浏览器投影按稳定 failure code 生成本地化说明。stdout/stderr、命令和动态执行结果不翻译，底层 SSH 原始异常不透传。
- 服务重启不恢复内存队列；遗留排队项取消，遗留运行项标记 uncertain。
- SSH 内部状态和输出事件不进入 Tool `onUpdate`。前端只使用 Pi 的 `tool_execution_start` 和 `tool_execution_end`；当前没有 Operation HTTP API。
- Command Service 在 Session 开启时通过 `RemoteSandboxProvider` 准备命令；关闭时通过共用 `remote-shell-command.ts` 直接包装 Bash/cwd并依赖 `RemoteCommandBroker` 执行；`Ssh2ExecCommandBroker` 管理单次 exec Channel，物理连接和容量由共享 `Ssh2ConnectionPool` 管理。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Operation、事件和状态 | [command-operation.ts](../../../packages/ssh-agent/src/domain/command-operation.ts) |
| SSH Failure 分类 | [ssh-failure.ts](../../../packages/ssh-agent/src/domain/ssh-failure.ts) |
| Operation Repository | [command-operation-repository.ts](../../../packages/ssh-agent/src/application/repositories/command-operation-repository.ts)、[sqlite-command-operation-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-command-operation-repository.ts) |
| Session FIFO、进程许可和主动排队超时 | [session-command-scheduler.ts](../../../packages/ssh-agent/src/application/services/session-command-scheduler.ts) |
| 执行流程、超时/取消与结果分类 | [command-operation-service.ts](../../../packages/ssh-agent/src/application/services/command-operation-service.ts) |
| Session 策略与直接命令包装 | [session-sandbox-policy.ts](../../../packages/ssh-agent/src/application/services/session-sandbox-policy.ts)、[remote-shell-command.ts](../../../packages/ssh-agent/src/application/remote-shell-command.ts) |
| 执行期 Guard、排队检查、grant 消费与 SSH 目标/cwd 校验 | [command-execution-policy.ts](../../../packages/ssh-agent/src/application/services/command-execution-policy.ts) |
| 单次 Operation 状态、输出、事件与重启恢复 | [command-operation-recorder.ts](../../../packages/ssh-agent/src/application/services/command-operation-recorder.ts) |
| 启动器确认行及 stderr 前缀解析 | [sandbox-confirmation-capture.ts](../../../packages/ssh-agent/src/application/services/sandbox-confirmation-capture.ts) |
| Guard 执行期策略 | [command-guard-evaluator.ts](../../../packages/ssh-agent/src/application/services/command-guard-evaluator.ts) |
| Agent Tool 与远端审批准备 | [remote-server-call-tool.ts](../../../packages/ssh-agent/src/application/tools/remote-server-call-tool.ts) |
| 不可变命令执行计划与调用绑定 | [remote-command-execution-plan.ts](../../../packages/ssh-agent/src/application/tools/remote-command-execution-plan.ts)、[remote-command-execution-plan.test.ts](../../../packages/ssh-agent/test/remote-command-execution-plan.test.ts) |
| Exec adapter、组合 Broker 和 Connection Pool | [ssh2-exec-command-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-exec-command-broker.ts)、[ssh2-channel-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-channel-broker.ts)、[ssh2-connection-pool.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-pool.ts) |
| agent-core 通用 Tool Error | [types.ts](../../../packages/agent/src/types.ts)、[agent-loop.ts](../../../packages/agent/src/agent-loop.ts) |
| 默认运行时装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 调度器和主链路回归测试 | [session-command-scheduler.test.ts](../../../packages/ssh-agent/test/session-command-scheduler.test.ts)、[command-operation-service.test.ts](../../../packages/ssh-agent/test/command-operation-service.test.ts) |

不要从 HTTP handler 直接调用 Channel Broker，也不要在断线后自动重放命令。Session 顺序约束、进程许可和 Connection Channel 容量是三个独立边界，不能用其中一个替代另外两个。
