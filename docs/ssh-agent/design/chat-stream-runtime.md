# SSH Agent Chat Stream Runtime

## 边界

Chat 是 Session 级 Agent Runtime。一个 Session 同时只能有一个活动 Run；它复用已配置的 `pi-ai Models` 和 Provider Credential，但不会把凭据放进消息或 Tool 参数。`read`、`write`、`bash` 在后端本机执行，`remote_server_call` 在 Session 所属 Workspace 的 Linux 主机执行。

Session 的 `workDir` 保存规范化绝对路径；为空时使用 `SSH_AGENT_LOCAL_CWD`。`autoAudit` 自动批准本地 `write`、`bash` 和远端 `remote_server_call`；`read` 始终无需审批。Guard 优先级高于 `autoAudit`：远端命令在自动或人工审批前执行预检查，并在真正派发前再次检查。

## Runtime

`ChatService` 为活动 Session 创建 `Agent`、`NodeExecutionEnv`、审批等待器和 Run SSE。LLM 事件原样保留 Pi 生命周期；`message_update` 对外只发送 provider delta，SSH Connection/Channel/排队状态不会映射成 Tool update。

Chat Run 将 Provider、Model 和 thinking level 保存到 `chat_runs`。Session 详情把最近一次 Run 的选择作为只读 `chatModelSelection` 投影返回；Session 实体和表不复制该状态。首次 Run 必须显式选择模型，后续 Run 可省略模型并继承最近选择。显式模型与上次相同时沿用未提交的 thinking level，模型变化且未提交强度时回到 `off`。每次 Run 都通过 `getSupportedThinkingLevels()`、当前模型目录和当前认证重新校验最终选择。

Run、消息、队列、审批和压缩投影写入 SQLite。服务启动时将未完成 Run 标记为 `chat_run_interrupted`，拒绝未完成审批并取消未消费队列，不自动重放 LLM 或 Tool。

刷新恢复以 HTTP 持久化投影为基线：先查询消息和当前活动 Run，存在活动 Run 时查询 pending Queue 并重连 Run SSE，再查询 pending Approval。SSE Ring Buffer 只补同进程内的短时 delta。

## 审批

Schema 校验完成后进入 `beforeToolCall`。人工审批最多等待五分钟；批准后继续执行，拒绝、超时或 Run 取消会形成带准确原因的错误 Tool Result。自动批准同样写审计记录，但不会阻塞。

`remote_server_call` 的顺序固定为：Guard 预检查 → `autoAudit` 自动批准或人工审批 → Guard 派发前复检 → SSH 执行。命中 Guard 时不创建 Approval，也不执行 Tool；因此 `autoAudit=true` 不能绕过 Workspace Guard。

用户拒绝或审批超时不会调用 Tool，也不会依赖提示词阻止模型重试。Runtime 在完整发送并持久化 Tool Result 和 `turn_end` 后停止当前 Turn 的自动延续：同批次其他 Tool 仍按原审批和执行结果完成，尚未消费的 steer 变为 `cancelled`，follow-up 保持 pending 并可作为新的 User Turn 继续。没有 follow-up 时 Run 正常完成，不记为失败。Run 取消仍使用 AbortSignal，不采用这条正常收敛路径。

## 上下文压缩

阈值为 `contextWindow - reserveTokens`，其中 `reserveTokens=min(16384, contextWindow*0.2)`，`keepRecentTokens=min(20000, contextWindow*0.4)`。完成 Run 后生成摘要并保存 retained tail；原始 `chat_messages` 不删除。压缩失败只发 `compaction.failed`，不回滚已完成 Run。

## 当前限制

MVP 不提供多 lane、分支/Fork、Skills、Extension、附件、PTY 或跨进程 delta 重放。SSE 断开不取消 Run。
