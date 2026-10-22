# Terminal 人机协作实验

2026-10-22 在 `dev-terminal-interaction-with-human` 分支实现。与现有 [Terminal 运行时](./terminal-interaction.md) 共用一个 PTY、Canonical State、attachment 和 REST/SSE；不增加第二个 Shell、WebSocket 或新的 Agent 工具定义。

## 操作与互斥

- Agent 空闲且 attachment replay/ready 完成后，用户点击终端即可逐键操作。UTF-8、中文输入、粘贴、Tab、方向键、Ctrl+C 及交互程序的字节由 xterm 产生，PTY 原样接收；不追加 Enter、不做本地回显、不尝试解析 Shell 命令。
- 人工输入沿用 PTY 的实际沙盒权限，免 Guard/审批；Agent submit 继续执行原有 Guard 和审批。只读 Session 的人工输入也处于原 `/tmp` 可写沙盒，不因可输入而放宽文件权限。
- `TerminalInputArbiter` 管理独立于 resize 的输入控制权：idle、human（attachment）、agent（Run）。焦点进入时自动申请，新的有效申请取代旧页面；失焦、隐藏、断流与 detach 释放人工权限。Agent 初始化期间 Service 拒绝人工请求；绑定和实际写入在 Actor 同一队列内复核，前端禁用不是权限边界。
- 发送普通聊天消息经会话装配注入的 submission gate 冻结输入、排空待发队列并等待最后确认，再创建 Run。失败保留草稿并停止创建；Run 绑定撤销所有人工页面的输入权。完成、失败或取消清理时 unbind，聚焦页面可重新申请。正在等待审批的 Run 同样禁止人工输入。
- 人工前台程序和未完成输入原样保留；交接不发送 Ctrl+C、Enter、退出或重开 Shell。Agent 首次写入前必须完成一次成功交付的 observe；预检拒绝 submit 时以非终止工具错误反馈模型，直接 CTRL_C 和实际写入也复核。

输入状态由独立的 `terminal-input-status.tsx` 在终端视口下方展示：键盘、交接箭头、Agent、其他页面和锁图标分别对应五种输入状态，配合原有双语文字、柔和底色和细边框。样式复用 Terminal 语义色与标签圆角，不增加闪烁或持续动画；保留 `role=status`，图标不重复播报文字。

## REST 与事件

以下接口位于 `/api/sessions/:sessionId/terminal/attachments/:attachmentId`：

| 请求 | 内容与结果 |
|---|---|
| `POST /control` | `{ action: "claim" \| "release" }`；返回 `{ mode, attachmentId, agentRunId, epoch }` |
| `POST /input` | `{ terminalSessionId, controlEpoch, inputSequence, bytesBase64 }`；返回 `{ acceptedSequence }` |

`inputSequence` 在每个控制权代次从 1 开始。单批非空且不超过 32 KiB；严格检查 Base64、字段、live attachment、Terminal 身份、owner、代次与顺序。仅最后一个已确认批次的完全相同重试幂等；冲突和其他乱序请求不写 PTY。去重摘要只存 Actor 内存，不写磁盘或模型。

状态和 attachment bootstrap 提供 `inputControl`；`terminal.control_changed` 通过原 SSE 序列同步同一结构。输入控制权与 resize ownership 不互相授予权限；控制变化参与原 snapshot/replay 顺序。浏览器状态解析兼容缺少控制字段的旧状态快照，但 attachment 必须提供有效控制权，不能在旧后端上误开放输入。

浏览器输入队列最多 256 KiB，16ms 合并并串行发送，单批上限 32 KiB；control/input HTTP 和人工 SSH 写入有 10 秒边界。SSH 写入超时销毁 Channel，结果标为 uncertain。丢失确认、断线、失权或队列超限不会自动重放按键；输入故障显示手动重新同步入口。snapshot/replay、隐藏或未持权页面不能发送输入。

## 可见记录与交接

- `TerminalHumanActivityRecorder` 在人工输入前保存写入中元数据，完成后保存 written/uncertain；记录身份、输入计数/字节数量、时间、事件范围、可见 transcript、screenText 和完整性。记录不是完整命令审计，不保存原始按键或隐藏密码，也不伪造 Agent Interaction/Input/Tool Call。
- 每个 Canonical 输出批次更新内存中的可见投影，最多每 250ms 保存检查点；输入和交接强制保存。清屏、重绘、alternate screen 或前缀不连续时保存保留文本并明确 truncated。总文本预算 64 KiB，优先保留当前屏幕，再保留最近可见记录，UTF-8 边界不截坏字符。
- Run 先锁住人工输入，再等待最后回显安静 150ms（持续输出最多等待 1 秒），最后在 Actor 队列捕获和保存交接现场；不等待前台程序结束。保存失败撤销 Run 绑定，不开始模型执行。
- `ChatRuntimeFacts` 将最新记录放入独立 `terminal-human` 通道。首次模型请求前经原事务日志同步，失败不请求模型；引用文字转义后进入 quoted-data，不获得指令或权限含义。`currentTerminal` 只表示 PTY 身份是否相同，不承诺屏幕实时性；交接画面冻结，后续工具观察覆盖它的屏幕含义，旧终端记录以 false 标明历史。工具仍以本轮真实绑定和沙盒为准。
- 通道按持久化内容去重，刷新、请求重试和压缩沿用事件身份；原各通道最高版本保留机制包含 terminal-human。生成交接不推进 Agent Observation 游标，只有真正交付的 observe 才解除人工操作后的写入门禁。
- SQLite v37 新增 `terminal_human_activities`，按 Session/Terminal 外键级联，旧 Terminal/Interaction 数据不变。重启把未结束人工记录标为 lost/truncated，写入中改 uncertain；PTY 继续遵守 lost 恢复规则，不重放任何输入。

## 入口与验证

后端核心为 `domain/terminal-human.ts`、`application/terminal/terminal-input-control.ts`、`terminal-human-activity.ts`，由 Terminal Actor/Service 串行装配；SQLite 与 runtime facts 通过原端口接入。前端核心为 `features/terminal/runtime/terminal-human-input.ts` 和 `terminal-submission-gate.ts`；Panel 只接线和展示状态，Chat 通过可选 startRun 边界接入，通用任务容器不承接业务。

回归包括 `test/terminal-human-interaction.test.ts`、`terminal-human-runtime.test.ts`、`sqlite-terminal-repository.test.ts`、`runtime-context.test.ts` 和前端 `tests/terminal-human-input.test.ts`：覆盖输入仲裁、晚到输入、顺序/去重、密码不落库、前台画面、文本预算、持久化失败、首次模型请求与先观察后写入、迁移及压缩保留。沿用 Terminal、Chat 和主题的定向回归。

验证使用临时 SQLite、假 SSH Channel、Canonical xterm 和 faux 模型；不代表真实 SSH、真实 vim/top、浏览器 IME 或供应商模型的端到端实测。

## 缓存前缀检查

按缓存优化提交 `abefa23` 核对：本功能不改首次提示词、18 工具定义、模型设置和 Session 缓存键；焦点、输入控制权 epoch、resize、Terminal revision 和活动时间不进入 runtime facts。人工记录在 Run 交接后冻结，只有新的真实人工活动才产生新的 terminal-human 事件，重复读取不重建时间戳或事件身份。

`terminal-human-runtime.test.ts` 使用真实 Responses 消息转换器与 ChatGPT 订阅 payload 投影检查连续四次模型请求以及跨 Run 的第二次人工交接：旧 input 前缀逐项相同、tools/固定头部保持、旧日志正文不变、重复同步不新增消息。原 `runtime-context.test.ts`、`chat-agent-runtime-factory.test.ts`、`chat-context-service.test.ts`、`chat-prompt-snapshot.test.ts` 和重试回归继续覆盖原优化。

该检查证明追加前缀机制保持，不能保证供应商实际命中率数值不变：新的人工可见记录本身是新增输入，可能改变总 Token、上下文压缩时机与命中比例。记录维持有界和去重，不通过省略真实交接信息来制造高缓存率；真实 `cache.usage` 仍由现有供应商返回计数记录，本次未调用真实模型验证。
