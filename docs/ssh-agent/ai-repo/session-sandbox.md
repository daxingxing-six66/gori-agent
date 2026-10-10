# Session 沙盒模式代码路由

适用于 Session 级 `sandboxEnabled`、Composer 单一沙盒命令、执行权限策略、Terminal 自动重开及授权/部署计划失效。底层 Landlock/Bubblewrap 的能力、共同规则与安装流程见 [remote-sandbox.md](./remote-sandbox.md)。

## 配置与交互

- 配置属于 Session；同一 Workspace 的其他 Session 不受影响。新 Session 默认开启，SQLite v27 为已有 Session 增加 `sandbox_enabled=1`，保留其他字段和 revision。创建与更新 API 只接受布尔值，更新仍要求 `expectedRevision`。
- Composer 菜单只有一个入口，中英文标题分别为“沙盒模式”和“sandbox”。小字介绍远端进程的文件写入限制；右侧绿、灰、黄呼吸灯分别表示开启、关闭、切换中，状态同时提供无障碍标签与悬停说明。选择入口直接切换，不创建 Chat 消息、Agent Run 或 Tool Call，不要求先配置模型。
- Chat 页首在运行状态左侧常驻只读沙盒标识，以盾牌/划线盾牌和本地化短文案表示开启/关闭；复用 Hook 的已确认 Session 设置，不提前展示尚未提交的切换结果。
- `/sandbox` 切换当前设置；兼容直接输入 `/sandbox on`、`/sandbox off`、`/sandbox status`。带附件或未知参数返回本地错误并保留草稿，不把命令发给模型。菜单不把三个参数拆成多个工具。
- 前端 Hook 先 GET 权威 Session，再以最新 revision PATCH；切换操作根据 GET 的最新值反转，避免过期 UI 快照导致反向操作。请求互斥，导航到其他 Session 后取消读取请求、忽略晚到结果；Terminal 刷新也复核取消信号。PATCH 失败后重新读取实际设置和 Terminal，覆盖“设置已提交但 PTY 重开失败”的情形。

## 策略所有权与执行

`sessionSandboxMode()` 是已加载 Session 的纯映射；`SessionSandboxPolicy` 负责读取当前可信配置。只有明确的 `sandboxEnabled=false` 映射为 `full_access`，缺省保持 `workspace_write`。应用服务使用同一个策略；模型参数、提示词和审计记录不能修改 Session 配置。

- 开启：普通远端命令先检查能力和已声明的写入路径，执行时经过原沙箱准备、启动器确认与审计链。明确需要例外时仍逐次人工批准 Full Access；准备失败不自动降级。
- 关闭：普通命令、部署远端阶段与新 PTY 跳过能力探测、写入范围路由、沙箱投递/准备及受限启动器；命令直接使用共用 POSIX 引用 helper 包装 cwd 和 Bash，PTY 使用独立 `unconfined_exec` 启动。沙箱组件缺失不会妨碍这些路径。
- 关闭只取消远端进程的文件系统约束。Guard、普通 `autoAudit` 审批、固定 SSH 目标与 cwd 校验、FIFO、超时、取消及 SSH 账号自身权限仍生效。本地工具、SFTP、监控与部署上传目录校验保留各自原有策略。
- Command 审计记录 `mode=full_access/backend=none/enforcement=none/authorizationSource=session_setting`。PTY 记录同一实际权限事实及 `source=session_setting/configuredAt`，启动确认只证明 Shell 准备完成，不宣称沙箱强制约束。
- 普通远端授权计划保留 Session 设置来源和 SSH 目标；该来源不生成一次性例外 grant。提交及出队时复核当前设置，过期权限计划拒绝派发。显式安装工具仍有独立人工安装审批。
- Deployment 的远端 `access.reason=session_sandbox_disabled` 表示 Session 授权，无独立例外审批列表或 grant；阶段普通审批仍由 `autoAudit` 决定。认领及各副作用前验证计划来源与当前设置，变化返回 `deployment_sandbox_route_changed`，要求重新规划。SFTP 上传范围不因此扩大。
- Runtime Factory 每轮追加可信 `<session-sandbox>` 指引，覆盖不可变基础头部中的旧沙箱说明；不改写历史快照。远端工具的静态描述说明两种 Session 策略，Terminal 描述投影实际 PTY 事实。后端执行策略仍是权限来源。

## 生命周期与自动重开

Session Service 在读取/保存配置前获取 `sandbox_update` lease。活动 Chat Run、手动压缩、Command Operation、Deployment Run、Terminal 打开和其他 Session 更新会阻止切换；切换期间禁止新的使用者和删除进入，返回明确的 409。保留中的 TerminalSession lease 可由内部重开流程替换。

1. 没有 active Terminal 时仅保存配置，不主动开启 Terminal Mode。
2. 有 active Terminal 时先关闭旧 PTY，保存新配置，再按新模式创建新 PTY，保留 rows/cols。新 Terminal ID 触发浏览器重新 attach，沿用已有异步状态恢复；Shell 环境、当前目录和进程状态不迁移。
3. 配置保存失败时，按数据库中的原设置尽力重开；恢复失败写内部日志，继续返回原保存错误。开启/关闭中不切换。
4. 保存成功但重开资源创建失败时，设置保持已保存的值并返回错误；后台连接/准备失败记录 Terminal `failed` 并由原失败卡片展示。开启模式缺少沙箱时不会静默关闭保护。

## 入口与验证

| 职责 | 入口 |
|---|---|
| 统一模式映射、读取与可信指引 | `packages/ssh-agent/src/application/services/session-sandbox-policy.ts` |
| Session 字段、更新编排和并发门禁 | `packages/ssh-agent/src/domain/session.ts`、`application/services/session-service.ts`、`session-lifecycle-coordinator.ts` |
| API 布尔校验、v27 与 Repository | `packages/ssh-agent/src/api/request-validation.ts`、`infrastructure/sqlite/migrations.ts`、`sqlite-session-repository.ts`、`rows.ts` |
| 命令提交、准备分支和执行期复核 | `packages/ssh-agent/src/application/services/command-operation-service.ts`、`command-execution-policy.ts`、`application/remote-shell-command.ts` |
| Chat 权限计划与普通审批 | `packages/ssh-agent/src/application/tools/remote-server-call-tool.ts`、`remote-command-execution-plan.ts`、`application/services/chat-tool-authorization-policy.ts` |
| Terminal 重开、直接启动与审计 | `packages/ssh-agent/src/application/services/terminal-session-service.ts`、`application/terminal/terminal-channel-opener.ts`、`infrastructure/ssh/ssh2-terminal-channel-broker.ts`、`infrastructure/sqlite/stored-terminal-sandbox.ts` |
| 部署计划来源与阶段审批 | `packages/ssh-agent/src/application/services/deployment-service.ts`、`application/tools/deployment-agent-tool.ts`、`infrastructure/sqlite/sqlite-deployment-repository.ts` |
| Hook、解析与菜单集成 | `packages/ssh-agent-web/features/session/runtime/use-session-sandbox.ts`、`model/session-sandbox-command.ts`、`features/chat/components/chat-console.tsx`、`chat-token-editor.tsx` |
| 页首沙盒标识、切换进度与错误提示 | `packages/ssh-agent-web/features/session/components/session-sandbox-badge.tsx`、`session-sandbox-status.tsx` |
| 双语标题和说明 | `packages/ssh-agent-web/features/i18n/messages/zh-CN/session.ts`、`en-US/session.ts` |
| 集中回归 | `packages/ssh-agent/test/session-sandbox.test.ts`、`chat-tool-authorization-policy.test.ts`、`chat-agent-runtime-factory.test.ts`、`deployment-service.test.ts`、`packages/ssh-agent-web/tests/use-session-sandbox.test.ts`、`session-sandbox-command.test.tsx` |

测试使用临时 SQLite、模拟 Broker/Provider 和确定性的前端异步驱动，覆盖默认迁移、Session 隔离、关闭绕过、开启恢复、Guard/目标保留、普通审批、过期计划、Terminal 双向重开及失败补偿。真实 Linux 内核与 SSH/PTY 行为需另做已授权的目标主机验收。
