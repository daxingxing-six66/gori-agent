# SSH 命令执行代码路由

适用于 `remote_server_call` Tool、Session 内 FIFO、进程并发限制、Command Operation、Guard 执行期校验、输出审计、失败分类和最终 Tool Result。

## 当前边界

- Agent 批次保留一个串行工具使整批串行的规则；remote_server_call 与 Terminal 工具均保持串行，文件工具的路径并发不会使同批部署命令提前执行。见 [文件工具并发](./file-tool-concurrency.md)。

Chat 的 `remote_server_call` 在创建人工审批前调用 `CommandOperationService.preflightGuard()`；批准后正式 `submit()` 仍会再次执行 Guard 校验，避免审批等待期间规则变化。

该 Tool 仅在普通交互模式可执行；两种模式保持相同 Tool schema，通过 Chat 授权策略和 Runtime 执行实现拒绝错误模式入口。模式切换只追加 system 记录，见 [session-prompt.md](./session-prompt.md)。

- Tool 只接受 command、可选绝对 cwd（也支持 `~`/`~/...`）和 timeoutMs；Session 由后端创建 Tool 时绑定，Workspace/主机/Credential 不进入模型参数。
- 命令先持久化，再进入按 `sessionId` 隔离的内存 FIFO；同一 Session 严格串行，不同 Session 可以并发。Command Operation 从创建记录前到终态持有 Session lifecycle lease；删除屏障先建立时，新命令不会进入持久化或队列。
- 进程级公平许可器默认最多允许 16 个 Operation 处于 dispatching/running，可由 `SSH_AGENT_MAX_CONCURRENT_OPERATIONS` 配置；每个 Session 同时最多有一个队首等待许可。
- `queued` 同时表示等待同 Session 前序命令或等待进程许可。排队达到 60 秒或派发前取消时会主动结束，过期项不会进入 Broker。
- 获得进程许可后读取并匹配最新 Guard，再获取 Channel。阻断会终止当前 Agent Run，并在所有终态路径释放许可。
- Operation 和内部事件写入 SQLite。stdout/stderr 前 10 MiB 持久化；超限只记录一次截断事件，LLM 获取最后 64 KiB。
- 非零退出、信号、超时、取消、传输结果不确定等使用结构化 SSH Failure。
- SSH Failure 持久化时保留规范英文 fallback，并可携带 message key/values；HTTP/SSE 浏览器投影按稳定 failure code 生成本地化说明。stdout/stderr、命令和动态执行结果不翻译，底层 SSH 原始异常不透传。
- 服务重启不恢复内存队列；遗留排队项取消，遗留运行项标记 uncertain。
- SSH 内部状态和输出事件不进入 Tool `onUpdate`。前端只使用 Pi 的 `tool_execution_start` 和 `tool_execution_end`；当前没有 Operation HTTP API。
- Command Service 只依赖 `RemoteCommandBroker`；`Ssh2ExecCommandBroker` 管理单次 exec Channel，物理连接和容量由共享 `Ssh2ConnectionPool` 管理。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Operation、事件和状态 | [command-operation.ts](../../../packages/ssh-agent/src/domain/command-operation.ts) |
| SSH Failure 分类 | [ssh-failure.ts](../../../packages/ssh-agent/src/domain/ssh-failure.ts) |
| Operation Repository | [command-operation-repository.ts](../../../packages/ssh-agent/src/application/repositories/command-operation-repository.ts)、[sqlite-command-operation-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-command-operation-repository.ts) |
| Session FIFO、进程许可和主动排队超时 | [session-command-scheduler.ts](../../../packages/ssh-agent/src/application/services/session-command-scheduler.ts) |
| Operation 状态机、执行超时和输出策略 | [command-operation-service.ts](../../../packages/ssh-agent/src/application/services/command-operation-service.ts) |
| Guard 执行期策略 | [command-guard-evaluator.ts](../../../packages/ssh-agent/src/application/services/command-guard-evaluator.ts) |
| Agent Tool | [remote-server-call-tool.ts](../../../packages/ssh-agent/src/application/tools/remote-server-call-tool.ts) |
| Exec adapter、组合 Broker 和 Connection Pool | [ssh2-exec-command-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-exec-command-broker.ts)、[ssh2-channel-broker.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-channel-broker.ts)、[ssh2-connection-pool.ts](../../../packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-pool.ts) |
| agent-core 通用 Tool Error | [types.ts](../../../packages/agent/src/types.ts)、[agent-loop.ts](../../../packages/agent/src/agent-loop.ts) |
| 默认运行时装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 调度器和主链路回归测试 | [session-command-scheduler.test.ts](../../../packages/ssh-agent/test/session-command-scheduler.test.ts)、[command-operation-service.test.ts](../../../packages/ssh-agent/test/command-operation-service.test.ts) |

不要从 HTTP handler 直接调用 Channel Broker，也不要在断线后自动重放命令。Session 顺序约束、进程许可和 Connection Channel 容量是三个独立边界，不能用其中一个替代另外两个。
