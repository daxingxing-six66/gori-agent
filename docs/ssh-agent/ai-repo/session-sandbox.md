# Session 沙盒模式代码路由

适用于 Session 级 `sandboxEnabled/sandboxReadOnly/sandboxWritableRoots`、Composer 沙盒命令、执行权限策略、Terminal 自动重开及授权/部署计划失效。底层 Landlock/Bubblewrap 的能力、共同规则与安装流程见 [remote-sandbox.md](./remote-sandbox.md)。

## 配置与交互

- 配置属于 Session；同一 Workspace 的其他 Session 不受影响。新 Session 默认开启，SQLite v27 为已有 Session 增加 `sandbox_enabled=1`，保留其他字段和 revision。创建与更新 API 只接受布尔值，更新仍要求 `expectedRevision`。
- Composer 菜单仅保留“沙盒模式”/“sandbox”开关入口。小字介绍远端进程的文件写入限制；右侧呼吸灯分别用主题成功色、中性色和警告色表示开启、关闭、切换中，状态同时提供无障碍标签与悬停说明。原有主题的开启色为绿色，ION 实验主题使用蓝色；颜色不改变沙盒配置。选择入口直接切换，不创建 Chat 消息、Agent Run 或 Tool Call，不要求先配置模型。只读模式统一在编辑会话中设置，不提供 Composer 入口。
- Chat 页首在运行状态左侧常驻只读沙盒标识，以盾牌/划线盾牌和本地化短文案表示开启/只读/关闭；复用 Hook 的已确认 Session 设置，不提前展示尚未提交的切换结果。标识没有按钮、点击动作或配置入口。可写目录编辑统一放在侧边栏每个 Session 的铅笔编辑弹窗中；列表可跨目录选择、移除，也可显式复制最新 Workspace 默认值。
- `/sandbox` 切换当前设置；兼容直接输入 `/sandbox on`、`/sandbox off`、`/sandbox status`。带附件或未知参数（包括已移除的 `read-only`）返回本地错误并保留草稿，不把命令发给模型。`on` 恢复所选目录可写，`off` 关闭沙盒并退出只读；原 `/sandbox` 仍反转开关。
- 前端 Hook 先 GET 权威 Session，再以最新 revision PATCH；切换操作根据 GET 的最新值反转，避免过期 UI 快照导致反向操作。请求互斥，导航到其他 Session 后取消读取请求、忽略晚到结果；Terminal 刷新也复核取消信号。PATCH 失败后重新读取实际设置和 Terminal，覆盖“设置已提交但 PTY 重开失败”的情形。

## 策略所有权与执行

Terminal 以稳定的 Session 功能身份接入任务容器；自动关闭/重开期间保留同一个 Tab，只更新底层实例与连接状态。已有 Tab 的定位可在沙盒切换期间进行，生命周期关闭继续禁用；详见 [任务容器](./task-container.md)。

`sessionSandboxMode()` 是已加载 Session 的纯映射；`SessionSandboxPolicy` 负责读取当前可信配置。只读始终映射为受限执行；只有非只读且明确的 `sandboxEnabled=false` 映射为 `full_access`，缺省保持 `workspace_write`。应用服务使用同一个策略；模型参数、提示词和审计记录不能修改 Session 配置。

- 普通开启（非只读）：普通远端命令先检查能力和已声明的写入路径，执行时经过原沙箱准备、启动器确认与审计链。明确需要例外时仍逐次人工批准 Full Access；准备失败不自动降级。
- 关闭：普通命令、部署远端阶段与新 PTY 跳过能力探测、写入范围路由、沙箱投递/准备及受限启动器；命令直接使用共用 POSIX 引用 helper 包装 cwd 和 Bash，PTY 使用独立 `unconfined_exec` 启动。沙箱组件缺失不会妨碍这些路径。
- 关闭只取消远端进程的文件系统约束。Guard、普通 `autoAudit` 审批、固定 SSH 目标与 cwd 校验、FIFO、超时、取消及 SSH 账号自身权限仍生效。本地工具、SFTP、监控与部署上传目录校验保留各自原有策略。
- Command 审计记录 `mode=full_access/backend=none/enforcement=none/authorizationSource=session_setting`。PTY 记录同一实际权限事实及 `source=session_setting/configuredAt`，启动确认只证明 Shell 准备完成，不宣称沙箱强制约束。
- 普通远端授权计划保留 Session 设置来源和 SSH 目标；该来源不生成一次性例外 grant。提交及出队时复核当前设置，过期权限计划拒绝派发。显式安装工具仍有独立人工安装审批。
- Deployment 的远端 `access.reason=session_sandbox_disabled` 表示 Session 授权，无独立例外审批列表或 grant；阶段普通审批仍由 `autoAudit` 决定。认领及各副作用前验证计划来源与当前设置，开关或完整目录列表变化返回 `deployment_sandbox_route_changed`，要求重新规划。SFTP 上传范围不因此扩大。
- 请求前由 `SessionSandboxPolicy.snapshot()` 提供当前开关、只读及排序后的有效可写目录，统一服务按实际变化追加 sandbox 通道事件，明确替代旧策略；不改固定头部或旧消息。Terminal 定义固定，实际 PTY 事实在独立 terminal 通道提供。后端执行策略仍是权限来源。见 [运行时上下文](./runtime-context.md)。

## 生命周期与自动重开

Session Service 在读取/保存开关或目录配置前获取 `sandbox_update` lease。活动 Chat Run、手动压缩、Command Operation、Deployment Run、Terminal 打开和其他 Session 更新会阻止切换；切换期间禁止新的使用者和删除进入，返回明确的 409。保留中的 TerminalSession lease 可由内部重开流程替换。

1. 没有 active Terminal 时仅保存配置，不主动开启 Terminal Mode。
2. 切换开关或只读选项，或普通开启状态修改目录列表时，有 active Terminal 就先关闭旧 PTY，保存新配置，再按新模式及完整范围创建新 PTY，保留 rows/cols。新 Terminal ID 触发浏览器重新 attach，沿用已有异步状态恢复；Shell 环境、当前目录和进程状态不迁移。
3. 配置保存失败时，按数据库中的原设置尽力重开；恢复失败写内部日志，继续返回原保存错误。开启/关闭中不切换。关闭或只读状态只修改未来目录列表时，现有 PTY 不重启；相同列表也不重开。
4. 保存成功但重开资源创建失败时，设置保持已保存的值并返回错误；后台连接/准备失败记录 Terminal `failed` 并由原失败卡片展示。开启模式缺少沙箱时不会静默关闭保护。

## 只读排障模式

只读模式的 UI 设置入口位于侧边栏铅笔打开的编辑会话弹窗，在“沙盒可写目录”标题后方同一行提供“只读”复选框。说明收进旁边的信息图标，悬浮或键盘聚焦时展示；勾选后给下方目录选择和移除区加禁用蒙层，同时原生禁用按钮，隐藏目录继承说明，保留已选目录，取消勾选后恢复编辑。恢复 Workspace 默认目录位于标题行右侧，以刷新图标呈现并保留悬浮标题和无障碍名称，只读时禁用。与其他编辑字段一起按快照 revision 保存，未修改只读状态时省略字段，保存后刷新树和 Terminal。新会话 Composer 不提供只读设置。回归见 `tests/session-edit-dialog.test.tsx`、`tests/sandbox-writable-roots.test.tsx` 和 `tests/use-session-sandbox.test.ts`。

- `sandboxReadOnly=true` 是可信 Session 配置，自动启用沙盒；显式同时提交 `sandboxEnabled=false` 返回字段校验错误。新旧 Session 缺省为 false，SQLite v34 仅追加布尔列及一致性约束，不修改 revision、目录或历史。
- 配置的 `sandboxWritableRoots` 保留原值，`sessionSandboxRoots()` 在目标解析时将实际根固定为 `["/tmp"]`，并携带只读标记。无需先配置 Workspace 可写目录。读取和执行仍按 SSH 账号权限，日志可位于任意可读目录，cwd 不扩大写入范围；`/dev/null` 保留为设备写入例外。
- 授权阶段直接拒绝显式 Full Access、已知越界和无后端路线，不创建例外审批；提交与出队再次拒绝 Full Access，并校验实际只读目标和 `/tmp` 范围。目标比较及 grant 签名绑定只读标记，旧普通沙盒计划不能混用。
- Runtime 的参数准备及直接执行门禁禁用 `sftp_upload`、`bubblewrap_install` 和部署提案/执行/修订工具；保留远端读取、Terminal、SFTP 下载、部署只读查询及明确结束。上传工具也检查解析后的只读目标，部署服务在新讨论、准备/提案、执行及每次副作用前独立拒绝只读会话。
- 准备阶段也不在 `/tmp` 外新增文件：Landlock 只检查、复用匹配摘要的已有启动器，不创建或修复 `$HOME/.cache`；缺少启动器可尝试已安装的 Bubblewrap。Bubblewrap 只在 `/tmp` 创建写入探针，根外使用已有可写目录的只读可写性检查，不创建/删除根外测试文件。能力缓存区分只读与普通发现，避免只读请求等待另一个 Session 的安装流程。
- 无可用后端时失败关闭，用户需先单独准备后端。此模式限制远端命令和 PTY 的直接文件写入；网络、IPC、进程信号和共同策略未覆盖的元数据操作仍使用 SSH 账号权限。本地工具和 Workspace 独立文件管理不属于 Session 限制，不能将其描述为整个账号的只读权限。
- 回归：`test/read-only-sandbox.test.ts`、`test/session-sandbox.test.ts`、`test/deployment-sandbox-roots.test.ts` 和前端沙盒命令/Hook 测试；使用合成 SSH Broker、faux 模型及临时 SQLite，未代替目标 Linux 内核验收。

## 入口与验证

| 职责 | 入口 |
|---|---|
| 统一模式映射、读取与可信指引 | `packages/ssh-agent/src/application/services/session-sandbox-policy.ts` |
| Session 字段、更新编排和并发门禁 | `packages/ssh-agent/src/domain/session.ts`、`application/services/session-service.ts`、`session-lifecycle-coordinator.ts` |
| API 布尔/目录校验、v27/v28 与 Repository | `packages/ssh-agent/src/api/request-validation.ts`、`infrastructure/sqlite/migrations.ts`、`sqlite-session-repository.ts`、`rows.ts` |
| 命令提交、准备分支和执行期复核 | `packages/ssh-agent/src/application/services/command-operation-service.ts`、`command-execution-policy.ts`、`application/remote-shell-command.ts` |
| Chat 权限计划与普通审批 | `packages/ssh-agent/src/application/tools/remote-server-call-tool.ts`、`remote-command-execution-plan.ts`、`application/services/chat-tool-authorization-policy.ts` |
| Terminal 重开、直接启动与审计 | `packages/ssh-agent/src/application/services/terminal-session-service.ts`、`application/terminal/terminal-channel-opener.ts`、`infrastructure/ssh/ssh2-terminal-channel-broker.ts`、`infrastructure/sqlite/stored-terminal-sandbox.ts` |
| 部署计划来源与阶段审批 | `packages/ssh-agent/src/application/services/deployment-service.ts`、`application/tools/deployment-agent-tool.ts`、`infrastructure/sqlite/sqlite-deployment-repository.ts` |
| Hook、解析与菜单集成 | `packages/ssh-agent-web/features/session/runtime/use-session-sandbox.ts`、`model/session-sandbox-command.ts`、`features/chat/components/chat-console.tsx`、`chat-token-editor.tsx` |
| 只读选择器、说明浮层与目录禁用蒙层 | `packages/ssh-agent-web/features/session/components/session-dialog.tsx`、`session-edit-dialog.tsx`、`features/workspace/components/sandbox-writable-roots-field.tsx`、`sandbox-writable-roots.css` |
| 页首沙盒标识、切换进度与错误提示 | `packages/ssh-agent-web/features/chat/components/chat-page-header.tsx` 只组合状态展示；`features/session/components/session-sandbox-badge.tsx`、`session-sandbox-status.tsx` 保留标识和切换提示 |
| 双语标题和说明 | `packages/ssh-agent-web/features/i18n/messages/zh-CN/session.ts`、`en-US/session.ts` |
| 集中回归 | `packages/ssh-agent/test/session-sandbox.test.ts`、`chat-tool-authorization-policy.test.ts`、`chat-agent-runtime-factory.test.ts`、`deployment-service.test.ts`、`packages/ssh-agent-web/tests/use-session-sandbox.test.ts`、`session-sandbox-command.test.tsx` |

测试使用临时 SQLite、模拟 Broker/Provider 和确定性的前端异步驱动，覆盖默认迁移、Session 隔离、关闭绕过、开启恢复、Guard/目标保留、普通审批、过期计划、Terminal 双向重开及失败补偿。真实 Linux 内核与 SSH/PTY 行为需另做已授权的目标主机验收。

Workspace 的 `sandboxWritableRoots` 是默认选项，新 Session 创建时复制，允许 POST 显式覆盖；创建后独立保存，Workspace 后续更新不覆盖它。SQLite v28 将旧单目录范围迁为列表，保持原 revision 和历史。显式目录列表为 1–16 条绝对非根路径；未传远端 cwd 时从 SSH 用户家目录执行，Terminal 保留 SSH 初始目录；启动目录不授予写权限。

目录编辑先 GET 权威 Session，并保存编辑开始时的 revision；提交不能重新获取新 revision 覆盖别人的变更。失败后保留草稿，用户可重新加载。`session-edit-dialog.tsx` 读取权威 Session，`session-dialog.tsx` 在同一表单维护名称、本地目录、审批、只读和沙盒目录草稿，一次 PATCH 使用编辑快照 revision；没有修改目录时省略该字段，旧未配置范围不妨碍其他字段编辑。保存及可能已提交的重开失败均刷新树和当前 Terminal，后端 lifecycle barrier 继续保护并发。`use-session-sandbox.ts` 只负责 slash 开关，`ChatPageHeader` 和 Badge 只投影状态。共用目录字段及多选器位于 Workspace feature，字段的可选设置、标题操作、说明和蒙层由包含弹窗配置；双语 `sandbox.roots.*` 文案归入 Workspace 目录。回归见后端 `sandbox-writable-roots.test.ts`、`session-sandbox.test.ts`、`deployment-sandbox-roots.test.ts` 及前端 `sandbox-writable-roots.test.tsx`、`session-edit-dialog.test.tsx`、`use-session-sandbox.test.ts`。


2026-10-19 Diagnose 接入：诊断元数据工具明确免审批，在只读 Session 仍可记录方向和结论；普通工具及远端权限策略不变。短期 diagnose_request lease 参与设置互斥和删除屏障，跨轮活动任务不长期占用执行 lease。 详见 [Diagnose 功能路由](./diagnose.md)。
