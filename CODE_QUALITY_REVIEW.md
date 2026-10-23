# Terminal 人机协作代码质量走查

日期：2026-10-23。依据：[SSH Agent 代码质量检查与结构治理](docs/SSH_Agent_Code_Quality_Governance_Prompt.md)。

范围：`dev` 上 `85cf579`、`c5903b5` 实现的终端人工输入、控制权、交接、条件观察及相关前后端接线。相邻 Connection、Channel、Command、Runtime 只核对依赖边界，不进行全仓重构。工作区并发出现的宣传站及包配置变更不属于本报告的修改成果。

## 1. Executive Summary

现有方向合理：同一 Session 复用一个 PTY，由 Actor 串行处理人工输入、Agent 写入和控制权变更；浏览器通过 REST/SSE 投影，独立模块保存可见记录并追加模型上下文。Agent Tool 没有直接操作 ssh2，人工按键也没有被伪造成 Tool Call。

本轮发现并修复五类可复现的行为问题，集中在失败收尾和异步窗口：Run 初始化失败遗留控制权、人工检查点失败跳过终端终态、断流后的输入确认门闩失效、画面未更新就恢复输入，以及焦点申请期间丢字。另修复旧 Run 清理误撤新交接资格的防御性边界，保留人工写入异常 cause，并整理 Canonical capture 与交接等待的职责。

下文 P0/P1/P2/P3 使用治理规范的定义：P0 包含 bug、竞态和生命周期错误，不等同于线上事故紧急等级。原有测试基线通过，并不能证明上述失败窗口已覆盖，因此修复前先增加故障注入和延迟 Promise 回归。

完成本轮回归后可以继续开发。最大的已知语义边界是：显式 observe 的“交付”仍指工具结果返回，并不保证模型已经在下一次请求中读取；真实浏览器 IME、交互程序和 SSH 平台兼容性也仍需要独立验收。

## 2. Current Architecture

| 模块 | 真实职责与依赖 | 生命周期 |
|---|---|---|
| SSH Connection Pool / Channel Broker | SSH 连接、通道容量、长期 PTY handle；通过应用端口交付，不参与聊天文案 | Connection generation / Channel |
| TerminalSessionService | 打开、绑定 Run、等待人工回显、关闭及 Session lease 装配 | Session / Run |
| TerminalSessionActor | PTY 与 Canonical State 唯一写者；串行输入、输出、resize、attachment、Run 绑定和收尾 | live Terminal |
| TerminalInputArbiter | idle/human/agent 控制权、代次、输入顺序与内存去重 | Actor |
| TerminalHumanActivityRecorder | 可见记录、写入结果与有界持久化，不保存按键 | 人工活动 |
| TerminalHumanHandoffObservation | 冻结 capture、交付收据、内容版本与首写复用资格 | Actor / Run |
| TerminalHumanContextDelivery | 核对实际 Provider Context 的交接正文和成功响应身份 | 单轮模型请求 |
| TerminalInteractionService / Policy / Recorder | 工具授权、审批、写入编排、Observation 与交付游标 | Tool call / Actor |
| Runtime Facts / Context Repository | quoted-data、追加、去重、事务和压缩恢复 | Session 上下文 |
| TerminalHumanInput | 有界原始输入队列、控制申请、确认、故障与聊天前排空 | 浏览器 attachment |
| TerminalEventQueue / TerminalPanel | 有序显示与业务接线、清理；即时撤权，有序恢复 | 浏览器 attachment |
| Terminal submission gate | 注入聊天开始边界，在确认完成后创建 Run | 一次提交 |
| Task container | 展示、放大、收起；不拥有 Terminal 或输入生命周期 | 页面展示 |

内部原始按键仅用于内存和 PTY 传输。SQLite/模型保存 Canonical 可见文本及计数、范围和完整性标记。隐藏密码不会因输入队列存在而被记录；正常终端回显中的敏感文字仍属于可见文本。

## 3. Problems Found

### P0：行为、竞态和生命周期

| 编号 | 问题与位置 | 影响 | 处理方式 |
|---|---|---|---|
| P0-1 | `terminal-session-actor.ts` 的 `bindRun` 最后一次活动保存不在回滚范围 | 初始化返回失败，但输入权和 Run Set 仍被失败 Run 占用；人工和后续 Run 均被阻挡 | 将整个新绑定流程纳入回滚，统一释放本 Run 资源；重复已有绑定失败保留此前有效绑定，清理再次失败则按 runtime failure 收尾 |
| P0-2 | Actor `#finishTerminal` 在终态保存前执行人工检查点 | 检查点错误后 Actor/Channel 已释放，数据库仍 active/closing，重开被拒绝 | 人工审计与终端终态独立尝试，始终释放资源；保留单个原始错误或 AggregateError |
| P0-3 | `terminal-human-input.ts` 的 `close` 后仍可成功 `prepare`，晚到写入失败被丢弃 | SSE 先断流、输入确认后失败时，旧 participant 可能继续创建 Run，违反未确认输入阻止聊天提交的约定 | 已关闭 participant 必须拒绝 prepare；晚到失败保留 fault，关闭和故障均结束等待；恢复通过新 attachment 明确重新同步 |
| P0-4 | Panel 收到 `control_changed` 时立即完整应用，并在显示队列重复应用 | Agent 最后一批输出仍在 xterm.write 中，人工输入已被重新启用，用户基于旧画面操作 | 即时路径只撤权和冻结；恢复/授予权限等待前序画面与有序控制投影，HTTP 确认不能越过显示屏障。等待有独立 10 秒期限，同步/关闭/故障统一清理，防止新屏障产生悬挂 Promise |
| P0-5 | idle→人工 claim 的网络等待期间 xterm 禁止输入，状态却已表示可输入 | 点击后立即输入 `ls` 被丢弃，确认后回车可能只发出空行 | 仅 live、聚焦、允许申领期间，在原有上限内暂存输入；成功授予后才发送；失败、失焦、撤权和超限明确报错，不静默丢字或自动重放 |

### P1：结构与依赖

- **Canonical 数据类型反向依赖 Actor，记录器混入交接等待生命周期。** 原 `TerminalCanonicalCapture` 定义在 Actor，却被 Actor 自己依赖的人工 Recorder/Handoff 导入；`terminal-human-activity.ts` 同时持有可见记录逻辑和依赖 Actor 的 quiet/max 计时器。现在 capture 类型与投影归 `terminal-canonical-state.ts`，等待回显归 `terminal-human-handoff-settle.ts`，后者仅依赖事件订阅能力。消除类型循环，并让计时器释放可独立测试。
- **Actor/Panel 是后续膨胀的观察点。** 它们仍较大，但分别承担串行权威写者和前端装配职责；没有为缩短文件机械拆成 Manager/Factory。已有权限、记录、交付和显示队列边界保留。剩余演进约束见第 7、8 节。

### P2：诊断与清理一致性

- **人工输入异常丢失 cause。** `writeHumanInput` 将所有失败转换为公开 uncertain 错误，无法追溯真实原因。现在 `TerminalError` 接受标准 `cause`，公开 code/status/安全提示不变，不新增按键日志。
- **旧 Run 的解绑会清除新 Run 的 handoff。** `unbindRun` 原先无条件 `release` 收据；直接调用旧 Run 清理即可使新 Run 无法复用其有效交接。现在只有匹配 owner 的清理释放收据。当前 ChatService 正常 finalize 已有先解绑后释放 active 标记的顺序，未宣称 UI 中存在必现重叠。
- **重复 capture 投影。** Actor 的正常捕获、内部检查点和 dispose 分别组装同一结构；统一调用 Canonical State 的 `capture(sequence)`，避免未来增加字段时漏改某一路径。
- **Panel 在 render 中写入 busy ref。** 定向 ESLint 检出 `react-hooks/refs`；同步移入现有 inputBusy effect，避免 render 副作用。没有扩展到其他页面的无关 lint 清理。

### P3：风格

没有实施全局格式化、目录搬迁或无收益改名。仅保持修改行的缩进与现有风格一致。

## 4. Refactoring Performed

| Before | After | Reason |
|---|---|---|
| 绑定流程仅部分失败回滚 | Actor 内完整绑定/匹配释放，共用 `#releaseRunOwnership` | 明确失败初始化的资源所有权，防止权限残留 |
| 人工审计错误跳过终态提交 | 审计和终态独立尝试，最后统一回收 | 长期 PTY 生命周期不依赖辅助记录成功 |
| closed/fault、HTTP 确认与显示投影边界含混 | 关闭不可提交，未确认输入保留故障；显示屏障独立于 HTTP 确认 | 同步正确性覆盖断流和乱序响应 |
| 聚焦即等待远端、等待中键入被忽略 | 有界申领暂存，获得权威控制后发送 | 实现点击即可输入，同时保持后端权限校验 |
| Recorder 依赖 Actor 类型并拥有 settle 计时器 | Canonical 值类型下沉；独立 settle 用例只订阅事件 | 降低耦合，清晰管理独立计时器和订阅 |
| 多处组装 capture、错误丢失根因 | 单一 capture 投影和标准 cause | 降低字段演进与诊断成本 |

没有修改 REST 请求字段、SSE envelope、Tool schema、固定 18 工具目录、Guard/审批、沙盒、模型上下文正文或追加协议。用户可见行为修正为：claim 等待时暂存键入；未同步时禁止启动 Run；画面先更新，再恢复人工操作。

## 5. New Module Boundaries

- **Connection**：继续拥有连接、认证、generation、通道容量；不吸收人工活动和 Agent 逻辑。
- **Channel**：继续提供 PTY write/resize/close，真实 SSH 类型留在 adapter；人工输入不经过短命令 exec。
- **Command**：保持 request→result；不增加 interactive/pty boolean 来兼容 Terminal 生命周期。
- **Terminal**：Actor 拥有队列和资源；Canonical State 拥有屏幕投影；Arbiter 决定权限；Recorder 保存可见记录；Handoff 保存复用证据；settle 用例只等待事件。
- **Agent Tool**：经 Interaction capability 执行，沿用权限与审批；不直接调用 ssh2，也不伪造人工 Tool Call。
- **Runtime**：同步持久化的 quoted-data，并在真实模型请求后确认交接；收据和内容版本留在内存。
- **Browser**：TerminalHumanInput 拥有输入与控制等待；EventQueue 拥有显示顺序；Panel 接线和释放；Task container 仅展示。

## 6. Dependency Rules

```text
Agent Tool → Application capability → Terminal Actor → Channel port → SSH adapter → ssh2
                                  ↘ Canonical State / Arbiter / Recorder / Handoff
Runtime → 持久化 facts/context + 交付 receipt capability
Chat → 注入的 submission gate → Terminal 输入 participant
Task container → 已装配的展示节点
```

纯证据和策略模块不得反向依赖 Actor 作为数据类型来源。状态变更必须留在 Actor 队列；不能为“拆分”让两个模块独立写 PTY、控制 epoch 或事件序号。显示层可以即时撤权，恢复输入必须等待对应显示顺序；REST 回包不是前序输出已显示的证明。

## 7. Remaining Technical Debt

1. **显式 observe 的交付语义。** 当前 Tool 在返回结果前调用 markDelivered，随后可执行同一 assistant batch 中已生成的 key/submit；模型可能还没通过下一次请求读取观察结果。这是原有 Terminal Tool 协议，不是新 handoff receipt 的绕过。已用假模型复现 observe+CTRL_C 在下一次请求前写入。若要强制模型先读取，需要另行设计 Provider 确认或同 batch 限制，评估模型轮次及兼容性。本轮不改变这项公开语义。
2. **真实端到端覆盖。** 本轮使用临时 SQLite、假 Channel、假模型和延迟 Promise。没有以真实凭据/付费模型验证，没有宣称浏览器中文 IME、真实 vim/top、Linux PTY 或其他本机平台已实测。
3. **数据库整体不可写。** 本轮修复“仅人工记录失败”时终态被跳过；若终态存储自身也不可写，仍只能确保 PTY/资源释放并返回原因，持久状态需后续恢复。不能承诺底层存储故障中保存所有人工记录。
4. **Actor 与 Panel 的装配复杂度。** 新业务不得继续直接追加生命周期；若扩展 Observation Lens 或新的 attachment 功能，应先寻找明确的独立所有者，保持单队列权威和有序显示。
5. **类型配置。** 项目已启用 strict（包含 noImplicitAny），尚未启用全仓 noUncheckedIndexedAccess。没有为本功能大面积调整旧代码。xterm SerializeAddon 的 double assertion 仍只位于外部 adapter，未扩散到业务层。
6. **异常提示轮询的防御性处理。** 既有 observation capture 的 prompt 检查没有显式 rejection handler；正常 close/capture 同队列并保留 finalCapture，未找到本功能正常路径触发拒绝。本轮不把只能通过底层异常注入的旧缺口当作新功能缺陷扩展修复。

## 8. Future Development Rules

1. 不默认追求最小 diff；以长期复杂度、资源所有权和下一次修改成本判断方案。
2. 禁止 append-only development；新功能先判断职责归属和是否产生第二个生命周期。
3. 避免 God File/God Class，也不为行数制造无意义 wrapper、interface、factory 或 manager。
4. 不用 boolean/optional 参数混合 Exec 与 PTY 生命周期；现有 claim/release 的二值协议不扩张成多模式执行器。
5. 不滥用 any、非空断言或 double assertion；外部库适配集中隔离。
6. Agent/Tool 不跨层操作 SSH library；所有 PTY 写入复核后端当前 Run/attachment 权限。
7. 输入确认不确定时停止发送、不重放；失焦、关闭、断流、重同步和晚到回包必须有明确终态。
8. 新控制事件需要同时考虑即时撤权与有序显示恢复，不能仅依靠 UI disabled。
9. 动态事实仍追加、去重并参与压缩恢复；固定头部、工具和缓存键不得混入焦点、epoch、时间等易变数据。
10. 修改后运行相关 typecheck/test，按授权运行 lint/build；补故障与竞态测试，不只覆盖成功路径。
11. 功能完成后进行结构走查，检查耦合、清理、类型与测试缺口；核对功能文档后刷新 ai-repo 摘要。

## 9. Validation

修复前基线：后端 20 文件 / 208 测试、前端 12 文件 / 126 测试全部通过。

最终定向回归：

| 检查 | 结果 |
|---|---|
| 后端 Terminal、SQLite、runtime context、Chat 生命周期/压缩/重试/提示词回归 | 21 文件 / 219 测试通过 |
| 前端 Terminal 输入、事件/视口队列、主题、模式、任务容器、聊天取消与 system 消息回归 | 12 文件 / 149 测试通过 |
| 修改的 input controller、Panel 和 input 测试 ESLint | 无错误、无警告 |
| 后端 tsgo、前端 tsc | 通过 |
| 本轮 Terminal 文档与源码映射 | 已核对并定向刷新摘要；检查没有报告 Terminal 过期项 |
| 根 npm run check | 提交前复核通过；走查初次验证曾受并发宣传站摘要未同步影响，现已解除 |
| 产品 npm run build | 完整通过（telemetry、ai、agent、SSH 后端、产品浏览器） |
| git diff --check | 通过 |

新增正式回归 34 个：后端故障/生命周期 8 个、交接 settle 3 个、前端输入、显示竞态与等待清理 23 个。测试使用临时数据库、假 Channel/模型及 fake timers；没有连接真实 SSH、调用付费模型或启动生产服务。

最终后端与前端共 **368 个定向测试通过**。完整构建保留 Vite 的 chunk 大小及 Vinext 路由静态分类提示；本轮未调整打包策略。

初次全局检查的外部限制：当时共享工作区的宣传站设计版本及其文档、manifest 尚在并发更新，因此本轮仅刷新已审阅的源码映射，没有覆盖并发源码或替其确认摘要。宣传站随后以独立提交 `2556701` 完成；本次提交前重新运行根 `npm run check` 已完整通过，包括宣传站类型检查。宣传站功能不属于本次终端质量走查的审查范围。

缓存专项核对 `abefa23` 及现有 wire payload 测试：人工记录保持尾部追加和去重，固定头部、18 工具、Session key、已有 journal bytes 不变。该结论证明请求构造的前缀稳定，不能保证供应商实际缓存命中率数值。本轮没有调用真实模型。
