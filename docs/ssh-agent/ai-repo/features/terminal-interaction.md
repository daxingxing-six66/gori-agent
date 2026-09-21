# Terminal Interaction 代码路由

适用于与业务 Session 绑定的长周期 SSH PTY、Canonical Terminal State、浏览器只读投影、Agent Terminal Tool 和审计时间线。

## 当前边界

- Terminal Interaction MVP 已完成后端、Agent 和前端链路。一个业务 Session 最多存在一个 live TerminalSession，用户通过 Chat 输入框开头的 `/` 或合法位置的 `@` 唤起工具菜单并手动开启或关闭；页面顶部不再提供独立开关。活动 Chat Run 期间禁止切换，取消 Run 只停止 Agent，不关闭 TerminalSession。
- Chat Run 冻结 `serverInteractionMode`，一个 TerminalSession 同时只绑定一个活动 Run。两种模式都提供相同 Tool 定义，后端门禁只允许当前模式入口。头部在首次 Run 保存不可变快照；开启、关闭、断开与重启恢复通过原子状态提交追加真实 system on/off 消息，不改写头部。见 [会话头部与模式消息](../session-prompt.md)。
- `terminal_interaction` 支持 `submit`、`CTRL_C` 和 `observe`。Tool 参数使用供应商兼容的顶层 object schema，再由运行时校验 action 对应字段。每次调用仍是标准 Agent Tool Call，Interaction、规范化显示文本、实际派发 bytes、Guard 结果、Approval、Observation 和交付/处理时间线均持久化。`autoAudit` 沿用原审批逻辑；Guard 在审批前和实际写入前各检查一次。
- Terminal Interaction 的 Guard 决策和失败信息使用显式领域类型，SQLite 恢复时在基础设施边界校验 JSON；Observation 的 replay、prompt/quiet/snapshot/timeout 边界、取消和 Agent 视图截断由独立 capture 模块负责，Interaction Service 只编排持久化状态与 PTY 写入。
- Agent 观察起点按 live TerminalSession actor 保存，跨 Chat Run 复用；首次从空起点读取已有输出，后续从上次成功标记 delivered 的 Canonical capture 接续。`observe`、`submit`、`CTRL_C` 都包含调用间隙尚未交付的内容；仅成功持久化 Observation 不推进起点，取消、Guard 拒绝、写入或交付失败也不推进。交付时采用该 Observation 的结束快照，之后到达的输出留给下一次调用；同一 tool call 的重试仍返回已持久化的结果。游标和待交付快照随 actor 回收，不在后端重启后恢复（旧 Terminal 会收敛为 lost）。
- Observation 回放发生 gap（包括超大单帧清空 ring）时返回保留的终端文本并设置 `truncated`、显式提示历史可能不完整，不因旧游标一直失败。文本增量仍基于 Canonical 文本前缀；滚屏、重绘或 resize 使前缀不再匹配时，回退为保留文本并同样提示可能不完整。`streaming` 仍返回当前屏幕快照，rawByteCount 在回放缺失时只统计可取得的 bytes，不代表完整历史字节数。
- Terminal REST 负责状态、幂等 open/close、attachment bootstrap/ready/focus/resize/detach、timeline 和 observation；SSE 使用版本化 TS envelope、Base64 output、snapshot + sequence replay、gap resync、heartbeat 和订阅者背压上限。
- Terminal REST/SSE 在浏览器出口按请求 Locale 翻译后端状态与失败说明；Base64 output、ANSI bytes、Observation 和用户输入保持原样。TerminalSession 继续保存英文 failure fallback，并额外保存可选 message key/values，使刷新后可按新的 Locale 重新投影。
- Terminal open 受服务端整体 deadline 约束；目标解析或 PTY shell 请求超时会持久化为 `failed/terminal_open_timeout` 并释放资源，不能永久停留在 `opening`。浏览器 attach/SSE 失败会刷新权威状态并按 UI 静态间隔重新 bootstrap，后端重启后不会继续展示旧 actor。
- 浏览器只读，不可向 PTY 输入。后端 Headless xterm 是唯一 Canonical Terminal State；前端 xterm 先恢复同 geometry 的 ANSI snapshot，再按 sequence 应用事件。当前聚焦页面成为 resize owner，浏览器容器变化经后端校验并写入 PTY 后再广播，前端不独立修改逻辑网格。
- 前端 xterm 使用完整的明亮/暗部 ANSI palette 并跟随全局主题。主题切换只更新现有 `Terminal.options.theme`，不会重新 attach、重建 SSE、清空 scrollback 或改变 geometry/resize ownership。
- Session 页面在宽于 1100px 时把只读 Terminal 作为占内容区 45% 的全高右栏，1100px 及以下恢复为 Chat header 下方的上下布局。两种布局复用同一个 attachment；侧边栏或响应式布局改变 Terminal 容器尺寸时继续通过 ResizeObserver 和 owner resize 链路同步 PTY geometry。
- Terminal Mode 工具是即时 UI Action：条目主标题固定为 `Terminal Mode`，右侧以绿、黄、灰三种呼吸灯分别表示已激活、过渡中和未启动/不可用，具体状态文字只作为无障碍与悬停提示；选择后删除输入框中的 `/...` 或 `@...` 触发文本，直接调用现有 open/close，不发送用户 Chat 消息，也不创建 Agent Tool Call；后端状态提交会追加 system 模式记录。连接、断开或活动 Chat Run 时菜单项保留但禁用并说明原因；新 Session 创建前显示“创建会话后可用”。切换继续使用纯前端生命周期投影：开启时展示连接状态，关闭时依次展示断开中、已断开确认和退出阶段；已断开确认短暂停留后，右栏与 Chat 宽度同步过渡。该投影不改变后端状态机、REST/SSE envelope 或领域数据结构，失败时仍回到服务端权威状态并展示原错误。
- 前端通过同一 Terminal SSE 和现有 Observation REST，在 xterm 视口投影非交互式 Observation Lens。`terminal.input` 与 `terminal.observation.captured` 建立随 scrollback/reflow 移动的起止 marker；只有 REST 返回的 `agentViewText` 包含有效内容时才渲染 Lens，空白、仅截断标记或查询失败均不展示 Magic Mask。delivered 第一帧直接显示严格范围，processing 只在范围内播放有机极光和无规则星尘，finished 至少展示满 800ms 后淡出；滚出视口时显示方向提示，刷新恢复无法可靠定位时明确降级为屏幕快照而不伪造精确边界。SSE 重放、resync、Terminal 终态和 attachment 重建会清理过期 marker、timer 和效果；后端协议及领域结构不变。
- 后端直接依赖 `@xterm/headless` 与 `@xterm/addon-serialize`，前端直接依赖同一稳定版本线的 `@xterm/xterm` 与 `@xterm/addon-fit`。
- 快照试验证明相同 geometry 下可以恢复 wrap、CJK 宽字符、颜色、cursor、scrollback 和 alternate screen，并能在恢复后继续同步 resize。
- `addon-serialize` 使用 proposed buffer API，后端 Canonical Terminal adapter 必须集中启用并隔离该依赖边界。
- `SessionLifecycleCoordinator` 已接入 Chat Run、Command Operation、Attachment upload、Session update/delete 和 TerminalSession lease；删除屏障建立后禁止新使用者进入。
- PTY 复用共享 Connection Pool Channel slot，并额外限制每个 Connection generation 的长期 PTY 数量；slot 和两级 reservation 直到 actor 持久化终态并 dispose 后才释放。
- actor 是 Headless Terminal、event sequence、replay、attachment、resize owner、geometry、run binding 和 idle 判断的唯一写者。
- 资源策略为受限级联：仅无 attachment、无活动 Tool/Run 消费者且达到 idle TTL 时自动关闭。后端重启把遗留 live Terminal 收敛为 `lost`，写入中 Interaction 收敛为 `write_uncertain`，不自动重放输入。
- 产品、状态机和冻结契约见 [Terminal Interaction Layer 技术设计](../../design/terminal-interaction-layer.md) 与 [前后端联合实现设计](../../design/terminal-interaction-implementation-design.md)；有差异时以源码和本文为准。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 后端 xterm 直接依赖 | `packages/ssh-agent/package.json` |
| 前端 xterm 直接依赖 | `packages/ssh-agent-web/package.json` |
| ANSI snapshot 兼容性与语义等价测试 | `packages/ssh-agent/test/terminal-snapshot-spike.test.ts` |
| 领域类型和服务端权威默认值 | `packages/ssh-agent/src/domain/terminal.ts`、`packages/ssh-agent/src/application/terminal/terminal-defaults.ts` |
| SQLite schema、Repository 和重启收敛 | `packages/ssh-agent/src/infrastructure/sqlite/migrations.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-terminal-repository.ts` |
| Session 生命周期屏障和 Terminal 生命周期 Service | `packages/ssh-agent/src/application/services/session-lifecycle-coordinator.ts`、`packages/ssh-agent/src/application/services/terminal-session-service.ts` |
| Agent Tool、Guard/Approval、输入和 Observation | `packages/ssh-agent/src/application/services/terminal-interaction-service.ts`、`packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts`、`packages/ssh-agent/src/application/services/chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/services/chat-approval-service.ts`、`packages/ssh-agent/src/application/terminal/terminal-observation-capture.ts`、`packages/ssh-agent/src/application/tools/terminal-interaction-tool.ts` |
| 稳定 Tool 定义、执行门禁与 Run 绑定协调 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`、`packages/ssh-agent/src/application/services/chat-service.ts` |
| Tool schema 与原生 Node ESM 运行时回归 | `packages/ssh-agent/test/terminal-interaction-tool.test.ts`、`packages/ssh-agent/test/terminal-node-runtime.test.ts` |
| Canonical State、replay、runtime registry 和单写者 actor | `packages/ssh-agent/src/application/terminal/terminal-canonical-state.ts`、`packages/ssh-agent/src/application/terminal/terminal-replay-ring.ts`、`packages/ssh-agent/src/application/terminal/terminal-runtime-registry.ts`、`packages/ssh-agent/src/application/terminal/terminal-session-actor.ts` |
| PTY 应用端口和 ssh2 adapter | `packages/ssh-agent/src/application/ssh-channel-broker.ts`、`packages/ssh-agent/src/infrastructure/ssh/ssh2-terminal-channel-broker.ts` |
| REST/SSE、请求校验和错误映射 | `packages/ssh-agent/src/api/terminal-routes.ts`、`packages/ssh-agent/src/api/terminal-request-validation.ts`、`packages/ssh-agent/src/api/http-handler.ts` |
| Terminal 公开消息本地化 | `packages/ssh-agent/src/i18n/message.ts`、`packages/ssh-agent/src/i18n/projection.ts`、`packages/ssh-agent/src/i18n/public-error.ts` |
| Composer 工具入口、Terminal 状态描述、即时切换与触发器测试 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/features/chat/components/chat-composer-panel.tsx`、`packages/ssh-agent-web/features/chat/components/chat-token-editor.tsx`、`packages/ssh-agent-web/features/chat/model/chat-composer-menu.ts`、`packages/ssh-agent-web/features/session/components/new-session-chat.tsx`、`packages/ssh-agent-web/tests/chat-composer-menu.test.ts` |
| 只读 xterm、动态主题、连接状态、Observation Lens、响应式分栏、owner resize 和时间线 | `packages/ssh-agent-web/features/terminal/`、`packages/ssh-agent-web/app/globals.css` |
