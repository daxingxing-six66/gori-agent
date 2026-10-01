# 远端 Linux 命令沙箱代码路由

适用于 `remote_server_call` 与 Terminal Mode 的远端文件访问约束、后端选择、启动器分发、能力探测、Full Access 与执行事实审计。当前 `RemoteSandboxCoordinator` 仅配置 Landlock 后端；Bubblewrap 还未实现，扩展边界见[多后端设计](../design/remote-sandbox-backends.md)。本地工作目录、SFTP 与监控不经过命令沙箱。Agent 可用的 `sftp_upload` 仍按 SSH 账号权限写入，新增文件不因 Landlock 受限；沙箱事实只针对命令或 PTY 进程。

## 策略与边界

- 缺省为 `workspace_write`。启动器授予 `/` 读取和执行，授予工作区 `remoteDefaultCwd`、规范化后的 `/tmp` 和真实 `/dev/null` 内容写入。Linux 常规权限仍同时生效。单条命令覆盖 `cwd` 不扩大可写范围。
- `remoteDefaultCwd` 既是 SSH/SFTP 默认目录，也是 Landlock 可写根；本地 `defaultCwd` 仅供本地 Session 使用。选定路径必须是非 `/` 的绝对路径，执行前远端 `realpath -e` 验证存在、可读、可进入；根别名、含换行/NUL 的路径及包含启动器缓存的可写目录均拒绝。临时目录仅接受 `realpath -e /tmp` 仍为 `/tmp`；启动器逐段禁止跟随规则路径中的符号链接，并拒绝将实际根目录授予写权限，防止准备与安装之间的路径置换扩大边界。
- v21 将旧工作区显式 `remote_sandbox_root` 优先迁为统一的 `remote_default_cwd`，保留原有写入边界，然后删除旧列。此前未配置独立根的旧工作区保留原远端目录；仍为 `/` 的记录无法开启受限写入，须通过编辑选择非根目录。历史命令审计事实不改写。
- Landlock 最低 ABI 为 **5**：ABI 3 才覆盖 truncate，ABI 5 才覆盖设备 ioctl。`remote_server_call` 对旧 ABI、缺失 syscall、未启用 LSM 或功能探针失败均拒绝默认执行，没有普通 SSH 回退。Terminal 仅在 Landlock 明确不可用或 ABI 不足时自动回退为 Full Access；非 Linux、架构不支持、根无效及准备失败均不自动回退。详见 [Terminal Interaction](./features/terminal-interaction.md)。
- `enforcement=full` 表示本策略要求的文件访问权限均可处理，不表示完整主机隔离。Landlock 未约束的文件元数据操作（chmod/chown 等）、网络和 IPC 不在策略内。受限 Terminal 在打开整段 PTY 时安装同一策略；SFTP 有独立权限边界。SSH 账号、Shell 启动文件及其可写启动器缓存属于信任前提：账号 Shell 可能在安装约束前运行代码，同账号无约束进程也可能篡改缓存；nonce 不是对恶意远端账号的证明。参考 [Linux Landlock 限制](https://docs.kernel.org/userspace-api/landlock.html#current-limitations)。

## 执行与审批

Chat Guard 预检查 → 审批 → Session FIFO/进程许可 → 最新 Guard → Full Access grant 消费 → Target/cwd → 沙箱准备 → Guard 再检查 → Broker exec。

`full_access` 必须提交非空 `justification`，始终等待人工审批，即使 Session 已开启 `autoAudit`。Chat 审批链验证决策 `source=user`，Command Service 消费一次性授权后才调用 Coordinator 包装无沙箱命令。内存 grant 绑定 Run、Tool Call、Session、原命令、cwd、timeout 和理由；一次消费即删除，参数不匹配也删除，Run 结束清理，重启不会恢复。它仍服从 Guard，也不提升 SSH 用户权限。原尝试失败后不能自动升级或重放。

所有路径和完整脚本通过单一 POSIX 参数引用 helper 组装。`cd` 成功后才启动独立 `bash --noprofile --norc -c`，因此脚本中的分号或换行不能越过失败的 cwd 检查。普通命令与 Terminal 各自生成本次随机 nonce；Native launcher 安装规则、设置 no_new_privs、关闭额外继承 FD 后才发出含 nonce 的 stderr 确认并 exec；后代进程继承限制。

Operation 初始审计保存 `enforcement=none/commandMayHaveRun=false`。独立的确认捕获器用 waiting/confirmed/missing 三种状态处理 stderr，只有含本次 nonce 的远端确认行匹配后才保存实际 ABI、launcherVersion、规范根与 `enforcement=full`，协议行不进入用户输出。SQLite 读取 `sandbox_json` 时验证枚举、ABI、根路径及可选布尔字段，损坏的审计事实不会直接进入领域对象。远端 shell 的前置诊断保留；有限长度内没有确认则返回 `sandbox_confirmation_missing`，保守记录命令可能已执行。超时、断线或运行中重启同样不能断言无副作用。

非零退出时 stderr/输出尾部的权限文案仅产生 `denialSuspected`，不冒充内核拒绝证据。此前已成功的写入仍可能保留。Tool 结果和 SQLite 保存实际 mode/backend/enforcement/ABI/root、Run/Tool 身份及 Full Access 理由；没有自动重试。

## 分发与探测

- `RemoteSandboxCoordinator` 按注入顺序尝试 `RemoteSandboxBackend`；只有明确不可用的后端错误才进入下一后端，根无效、投递或探测失败等错误直接失败关闭。`RemoteSandboxProvider` 供命令和 Terminal 准备使用，独立的 `RemoteSandboxProber` 供显式能力检测使用。Full Access 的无沙箱命令包装由 Coordinator 负责，不属于受限后端。
- 包携带 x64/arm64 静态 musl ELF，无远端编译或互联网下载要求。Zig 0.15.2 构建；资源 manifest 保存源码和产物摘要，`check:sandbox` 与后端 build 校验架构、静态链接及摘要。
- 远端通过 `uname` 选择架构，版本与二进制摘要确定 `$HOME/.cache/gori/sandbox/<launcherVersion>/<sha256>/gori-landlock-run`。同摘要现有文件可复用，否则 SFTP 投递随机临时文件，chmod 0700 后原子 rename，失败清理临时文件。
- v3 `--probe` 将 `ENOSYS`/`EOPNOTSUPP` 转换为明确的 unavailable 结果；其他探测错误仍失败关闭。能力可用时，在一次性子进程安装无授权规则，验证目录 open 确实被 EACCES 拒绝。成功能力只按完整 Connection Key 与 generation 缓存，同身份并发准备合并；显式刷新会等待同身份已开始的准备完成后清除缓存并重新探测。重连/凭据变化重新探测。
- `POST /api/workspaces/:id/sandbox` 通过 Coordinator 显式刷新能力，不执行用户命令；它会使用正式 Host Trust/连接并可能投递启动器。当前响应仍采用 Landlock 执行事实的形状，前端只在其包含有效的 `workspace_write/landlock/full`、整数 ABI 和有效根路径时显示通过。这只是最后一次能力检测结果，不证明后续命令已经受约束；命令仍在自己的执行路径校验。Overview 初始显示“尚未验证”，检测后显示 ABI、规范根或本地化失败原因及时间；修改 Workspace revision/离开页面会清理状态。
- 准备阶段限时 30 秒，并服从调用取消和执行超时；需要远端 Bash、realpath、sha256sum、stat 及原子 mv 工具。任何准备失败都不执行原始用户脚本。

## 代码与验证

| 职责 | 入口 |
|---|---|
| 策略类型、ABI、失败与根校验 | `packages/ssh-agent/src/domain/remote-sandbox.ts` |
| 应用端口及一次性授权 | `packages/ssh-agent/src/application/services/remote-sandbox-provider.ts`、`remote-sandbox-approval-store.ts` |
| 后端选择、Full Access 包装与显式探测 | `packages/ssh-agent/src/infrastructure/sandbox/remote-sandbox-coordinator.ts` |
| 分发、功能探针、缓存与引用 | `packages/ssh-agent/src/infrastructure/sandbox/landlock-remote-sandbox-provider.ts`、`shell-command.ts` |
| Native 规则、继承与 exec | `native/landlock-run/main.c`、[构建与内核测试说明](../../../native/landlock-run/README.md) |
| 构建和资源完整性 | `native/landlock-run/build.mjs`、`check-resources.mjs`、`packages/ssh-agent/resources/sandbox/` |
| 状态机、确认前缀与审计 | `packages/ssh-agent/src/application/services/command-operation-service.ts`、`sandbox-confirmation-capture.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-command-operation-repository.ts` |
| Chat 审批及 Tool 参数 | `packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts`、`chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/tools/remote-server-call-tool.ts` |
| 前端配置和检测 | `packages/ssh-agent-web/features/workspace/components/remote-sandbox-panel.tsx`、`workspace-dialog.tsx`、`workspace-edit-dialog.tsx` |
| 定向测试 | `packages/ssh-agent/test/remote-sandbox-coordinator.test.ts`、`remote-landlock-sandbox.test.ts`、`packages/ssh-agent-web/tests/remote-sandbox.test.tsx`、`native/landlock-run/security-test.py`、`native/landlock-run/ssh-smoke-test.mjs` |

模拟 Broker 测试覆盖部署/缓存、失败关闭、人工授权、Guard 变化和审计。原生内核测试使用一次性 Linux 与临时文件，覆盖内容写入、truncate、rename、删除、符号链接、解释器/后代进程、继承 FD、部分副作用和模拟缺失 syscall。交叉构建或 ELF 检查不能代替相应架构的实际 Linux 内核验证。

`ssh-smoke-test.mjs` 使用显式提供的一次性回环 SSH fixture、合成账户和内存数据库，贯穿正式 Target/Host Trust、SFTP 投递和内核执行。它验证后代进程越界拒绝、部分副作用、未审批 Full Access 和无效 cwd，不调用模型。fixture 准备与清理见 native README。
