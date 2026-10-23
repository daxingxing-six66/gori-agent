# Terminal 人机协作实验

2026-10-22 在 `dev-terminal-interaction-with-human` 分支实现。与现有 [Terminal 运行时](./terminal-interaction.md) 共用一个 PTY、Canonical State、attachment 和 REST/SSE；不增加第二个 Shell、WebSocket 或新的 Agent 工具定义。

## 操作与互斥

- Agent 空闲且 attachment replay/ready 完成后，用户点击终端即可逐键操作。UTF-8、中文输入、粘贴、Tab、方向键、Ctrl+C 及交互程序的字节由 xterm 产生，PTY 原样接收；不追加 Enter、不做本地回显、不尝试解析 Shell 命令。
- 人工输入沿用 PTY 的实际沙盒权限，免 Guard/审批；Agent submit 继续执行原有 Guard 和审批。只读 Session 的人工输入也处于原 `/tmp` 可写沙盒，不因可输入而放宽文件权限。
- `TerminalInputArbiter` 管理独立于 resize 的输入控制权：idle、human（attachment）、agent（Run）。焦点进入时自动申请，新的有效申请取代旧页面；失焦、隐藏、断流与 detach 释放人工权限。Agent 初始化期间 Service 拒绝人工请求；绑定和实际写入在 Actor 同一队列内复核，前端禁用不是权限边界。
- 发送普通聊天消息经会话装配注入的 submission gate 冻结输入、排空待发队列并等待最后确认，再创建 Run。失败保留草稿并停止创建；Run 绑定撤销所有人工页面的输入权。完成、失败或取消清理时 unbind，聚焦页面可重新申请。正在等待审批的 Run 同样禁止人工输入。
- 人工前台程序和未完成输入原样保留；交接不发送 Ctrl+C、Enter、退出或重开 Shell。Agent 首次写入可复用本次成功模型请求已收到、屏幕完整且现场未变的交接快照；缺少有效交付、现场变化、屏幕不完整或写入不确定时仍须先成功交付 observe。预检拒绝 submit 时以非终止工具错误反馈模型，直接 CTRL_C 和实际写入也复核。

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

已 live 的聚焦页面申请人工控制权时，xterm 可以把立即键入的内容暂存在同一个有界内存队列；提示使用“交接中”，成功持权前不发送到 PTY。失焦、申请失败、Agent 撤权或队列超限时，未派发内容明确进入故障，不静默丢弃或自动重放。发送聊天会先等待这次申请、已捕获输入的确认和控制投影；已关闭或断流的旧 participant 不能放行提交，晚到写入失败仍保留故障，需明确重新同步后恢复。

SSE 入口即时撤销人工权限，恢复输入通过原有 `TerminalEventQueue` 顺序完成，避免控制变化先于前序 xterm 输出生效；HTTP 控制确认与画面同步分别判断。从第一次等待控制投影开始有独立 10 秒期限，后续事件不延长；超时停止发送并阻止聊天提交，成功同步、关闭及故障均取消计时器。通用任务容器不处理这项同步生命周期。

## 可见记录与交接

- `TerminalHumanActivityRecorder` 在人工输入前保存写入中元数据，完成后保存 written/uncertain；记录身份、输入计数/字节数量、时间、事件范围、可见 transcript、screenText 和完整性。记录不是完整命令审计，不保存原始按键或隐藏密码，也不伪造 Agent Interaction/Input/Tool Call。
- 每个 Canonical 输出批次更新内存中的可见投影，最多每 250ms 保存检查点；输入和交接强制保存。清屏、重绘、alternate screen 或前缀不连续时保存保留文本并明确 truncated。`screenTruncated` 单独说明交接时当前屏幕是否因预算裁剪；仅历史 truncated 不阻断完整屏幕的复用。总文本预算 64 KiB，优先保留当前屏幕，再保留最近可见记录，UTF-8 边界不截坏字符。
- Run 先锁住人工输入，再等待最后回显安静 150ms（持续输出最多等待 1 秒），最后在 Actor 队列捕获和保存交接现场；不等待前台程序结束。保存失败撤销 Run 绑定，不开始模型执行。
- 新 Run 绑定的任一步持久化失败都撤销本次 Run Set 和控制权，已有有效绑定的重复刷新失败不会撤销原绑定；解绑只清理对应 Run 的交接资格。关闭时人工检查点与 Terminal 终态分别尝试，人工记录失败不能跳过终态和资源回收；单个失败保留原始原因，多个失败使用 AggregateError，人工输入的公开 uncertain 错误通过内部 cause 保留根因。
- `ChatRuntimeFacts` 将最新记录放入独立 `terminal-human` 通道。首次模型请求前经原事务日志同步，失败不请求模型；引用文字转义后进入 quoted-data，不获得指令或权限含义。`currentTerminal` 只表示 PTY 身份是否相同，不承诺屏幕实时性；交接画面冻结，后续工具观察覆盖它的屏幕含义，旧终端记录以 false 标明历史。工具仍以本轮真实绑定和沙盒为准。
- 通道按持久化内容去重，刷新、请求重试和压缩沿用事件身份；原各通道最高版本保留机制包含 terminal-human。仅保存或生成交接不推进 Agent Observation 游标；满足下述真实交付条件后，按冻结快照的结束范围接续，交接之后的输出留给下一次观察。
- SQLite v37 新增 `terminal_human_activities`，按 Session/Terminal 外键级联，旧 Terminal/Interaction 数据不变；v38 追加 nullable `screen_truncated`。旧记录 null 读取为未知，不被当作屏幕完整，保守要求 observe。重启把未结束人工记录标为 lost/truncated，写入中改 uncertain；PTY 继续遵守 lost 恢复规则，不重放任何输入。

## 交接快照复用与 Observation

- `TerminalHumanContextDelivery` 校验实际 Provider Context 中后台生成的 `terminal-human` 元数据与完整 quoted-data 正文、Session/PTY 身份及 handoff 范围，并关联该请求成功返回的 AssistantMessage 对象。在此响应产生的 Terminal Tool 预检前，通过 `acknowledgeHumanHandoff` 提交内存收据。模型自称已看到、仅上下文落库、失败/取消/截断响应、只剩元数据而正文缺失都不能授权复用；压缩和重试仍须在真正发送的请求中保留该快照。
- Actor 内的 `TerminalHumanHandoffObservation` 比对自身冻结的活动身份、事件范围、写入结果与屏幕完整性。内容版本只随已解析 SSH 输出批次和真实 geometry 变化推进，不使用通用 Session revision 或 eventSequence；控制权、resize owner 和审计事件本身不会让稳定现场失效。版本和交付收据不加入模型通道、SQLite 或 SSE，避免用易变元数据扰动缓存。
- 预检和 Actor 实际写入队列均复核条件。审批或准备期间出现新输出/resize 时，本次输入明确拒绝并要求 observe，已进入 Interaction 的拒绝保存为 failed/blocked，不误报实际写入不确定。真正派发前消费交接复用资格；若派发失败，旧收据不能再次授权，输入不会自动重放。成功写入或成功交付显式 observe 后，旧收据也不会复活已消费的资格。
- 成功交付交接时，Observation 游标最多推进到冻结 capture，不能直接推进到确认收据时的现场；重复收据和旧 Observation 不能使游标回退。后续 finite/interactive Observation 从此范围接续；streaming 仍按原语义返回当前屏幕。显式 observe 仍沿用一次交付解除人工首写门禁的规则，之后持续输出不反复重设该门禁，避免 top 等程序使写入永久等待；这不保证采样之后终端绝对不变。

## 入口与验证

后端核心为 `domain/terminal-human.ts`、`application/terminal/terminal-input-control.ts`、`terminal-human-activity.ts`、`terminal-human-handoff.ts` 与 `terminal-human-context-delivery.ts`，由 Terminal Actor/Service 和请求运行时装配；SQLite 与 runtime facts 通过原端口接入。前端核心为 `features/terminal/runtime/terminal-human-input.ts` 和 `terminal-submission-gate.ts`；Panel 只接线和展示状态，Chat 通过可选 startRun 边界接入，通用任务容器不承接业务。

Canonical capture 的值类型与统一投影由 `terminal-canonical-state.ts` 持有，Recorder/Handoff 不再从 Actor 导入证据类型。`terminal-human-handoff-settle.ts` 独立管理交接时等待回显的两个计时器和订阅，仅依赖事件源；人工记录器不再承担这段等待生命周期。

回归包括 `test/terminal-human-interaction.test.ts`、`terminal-handoff-observation.test.ts`、`terminal-human-runtime.test.ts`、`sqlite-terminal-repository.test.ts`、`runtime-context.test.ts` 和前端 `tests/terminal-human-input.test.ts`：覆盖输入仲裁、晚到输入、顺序/去重、密码不落库、前台画面、文本预算、持久化失败、首次模型请求、稳定交接免 observe、交接后输出/resize 与写入队列竞态、历史和屏幕截断区别、人工/Agent 写入不确定、旧收据拒绝、显式 observe 及游标接续、v37→v38 迁移和压缩保留。沿用 Terminal、Chat 和主题的定向回归。

验证使用临时 SQLite、假 SSH Channel、Canonical xterm 和 faux 模型；不代表真实 SSH、真实 vim/top、浏览器 IME 或供应商模型的端到端实测。

2026-10-23 质量走查新增绑定末阶段失败回滚、旧 Run 清理、关闭检查点失败、cause、申领期间立即键入、失焦/超限/撤权、断流先于输入确认和慢显示控制事件的回归，另以 `terminal-human-handoff-settle.test.ts` 验证 quiet/max 等待及订阅/计时器清理。分级结论、实际重构和剩余协议风险见 [走查报告](../../../../CODE_QUALITY_REVIEW.md)。显式 observe 的 delivered 仍沿用工具结果返回语义；同一 assistant batch 后续工具不保证模型已在下一次请求读取该观察，未改成 Provider 确认协议。

## 缓存前缀检查

按缓存优化提交 `abefa23` 核对：本功能不改首次提示词、18 工具定义、模型设置和 Session 缓存键；焦点、输入控制权 epoch、resize、Terminal revision 和活动时间不进入 runtime facts。人工记录在 Run 交接后冻结，只有新的真实人工活动才产生新的 terminal-human 事件，重复读取不重建时间戳或事件身份。

条件复用新增的交付收据、已消费状态和内容版本只存在内存，不持续追加“已读”状态或实时屏幕。规则升级会在下一次同步追加新的通道说明与屏幕完整性字段，不改写已经保存的旧正文；后续稳定请求继续保持原前缀。免去重复 observe 可减少一次工具/模型往返及重复屏幕输入，实际 Token 和命中比例仍按真实用量判断。

`terminal-human-runtime.test.ts` 使用真实 Responses 消息转换器与 ChatGPT 订阅 payload 投影检查连续四次模型请求以及跨 Run 的第二次人工交接：旧 input 前缀逐项相同、tools/固定头部保持、旧日志正文不变、重复同步不新增消息。原 `runtime-context.test.ts`、`chat-agent-runtime-factory.test.ts`、`chat-context-service.test.ts`、`chat-prompt-snapshot.test.ts` 和重试回归继续覆盖原优化。

该检查证明追加前缀机制保持，不能保证供应商实际命中率数值不变：新的人工可见记录本身是新增输入，可能改变总 Token、上下文压缩时机与命中比例。记录维持有界和去重，不通过省略真实交接信息来制造高缓存率；真实 `cache.usage` 仍由现有供应商返回计数记录，本次未调用真实模型验证。
