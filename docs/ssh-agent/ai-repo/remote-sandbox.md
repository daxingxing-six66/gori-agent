# 远端 Linux 命令沙箱代码路由

适用于 `remote_server_call` 的远端内核文件访问策略、启动器分发、能力探测、逐次 Full Access 审批和执行事实审计。本地工作目录、Terminal PTY、SFTP 与监控不经过此策略。

## 策略与边界

- 缺省为 `workspace_write`。启动器授予 `/` 读取和执行，授予显式配置的 `remoteSandboxRoot`、规范化后的 `/tmp` 和真实 `/dev/null` 内容写入。Linux 常规权限仍同时生效。
- `remoteSandboxRoot` 与本地 `defaultCwd`、远端 `remoteDefaultCwd`、调用的 `cwd` 分别保存。它必须是非 `/` 的绝对路径，执行前远端 `realpath -e` 验证存在、可读、可进入；根别名、含换行/NUL 的路径及包含启动器缓存的可写目录均拒绝。
- v19 为旧工作区增加 nullable 根字段，不猜测旧目录的用途。缺少配置会阻止默认命令；UI 创建/编辑表单要求显式填写根，普通 API 客户端仍可省略字段。
- 最低 ABI 为 **5**：ABI 3 才覆盖 truncate，ABI 5 才覆盖设备 ioctl。旧 ABI、缺失 syscall、未启用 LSM 或功能探针失败均拒绝默认执行，没有普通 SSH 回退。
- `enforcement=full` 表示本策略要求的文件访问权限均可处理，不表示完整主机隔离。文件元数据操作（chmod/chown 等）、网络和 IPC 不在策略内。Terminal/SFTP 保留独立权限与审批边界。参考 [Linux Landlock 限制](https://docs.kernel.org/userspace-api/landlock.html#current-limitations)。

## 执行与审批

Chat Guard 预检查 → 审批 → Session FIFO/进程许可 → 最新 Guard → Full Access grant 消费 → Target/cwd → 沙箱准备 → Guard 再检查 → Broker exec。

`full_access` 必须提交非空 `justification`，始终等待人工审批，即使 Session 已开启 `autoAudit`。Coordinator 还验证决策 `source=user`。内存 grant 绑定 Run、Tool Call、Session、原命令、cwd、timeout 和理由；一次消费即删除，参数不匹配也删除，Run 结束清理，重启不会恢复。它仍服从 Guard，也不提升 SSH 用户权限。原尝试失败后不能自动升级或重放。

所有路径和完整脚本通过单一 POSIX 参数引用 helper 组装。`cd` 成功后才启动独立 `bash --noprofile --norc -c`，因此脚本中的分号或换行不能越过失败的 cwd 检查。Native launcher 安装规则、设置 no_new_privs、关闭额外继承 FD 后才发出 stderr 确认并 exec；后代进程继承限制。

Operation 初始审计保存 `enforcement=none/commandMayHaveRun=false`。独立的确认捕获器用 waiting/confirmed/missing 三种状态处理 stderr，只有远端确认行匹配后才保存实际 ABI、launcherVersion、规范根与 `enforcement=full`，协议行不进入用户输出。SQLite 读取 `sandbox_json` 时验证枚举、ABI、根路径及可选布尔字段，损坏的审计事实不会直接进入领域对象。远端 shell 的前置诊断保留；有限长度内没有确认则返回 `sandbox_confirmation_missing`，保守记录命令可能已执行。超时、断线或运行中重启同样不能断言无副作用。

非零退出时 stderr/输出尾部的权限文案仅产生 `denialSuspected`，不冒充内核拒绝证据。此前已成功的写入仍可能保留。Tool 结果和 SQLite 保存实际 mode/backend/enforcement/ABI/root、Run/Tool 身份及 Full Access 理由；没有自动重试。

## 分发与探测

- 包携带 x64/arm64 静态 musl ELF，无远端编译或互联网下载要求。Zig 0.15.2 构建；资源 manifest 保存源码和产物摘要，`check:sandbox` 与后端 build 校验架构、静态链接及摘要。
- 远端通过 `uname` 选择架构，版本与二进制摘要确定 `$HOME/.cache/gori/sandbox/1/<sha256>/gori-landlock-run`。同摘要现有文件可复用，否则 SFTP 投递随机临时文件，chmod 0700 后原子 rename，失败清理临时文件。
- `--probe` 在一次性子进程安装无授权规则，验证目录 open 确实被 EACCES 拒绝。成功能力只按完整 Connection Key 与 generation 缓存，同身份并发准备合并；显式刷新会等待同身份已开始的准备完成后清除缓存并重新探测。重连/凭据变化重新探测。
- `POST /api/workspaces/:id/sandbox` 显式刷新能力，不执行用户命令；它会使用正式 Host Trust/连接并可能投递启动器。前端只在响应包含有效的 `workspace_write/landlock/full`、整数 ABI 和有效根路径时显示通过。Overview 初始显示“尚未验证”，检测后显示 ABI、规范根或本地化失败原因及时间；修改 Workspace revision/离开页面会清理状态。显示的是最后检测结果，命令仍在自己的执行路径校验。
- 准备阶段限时 30 秒，并服从调用取消和执行超时；需要远端 Bash、realpath、sha256sum、stat 及原子 mv 工具。任何准备失败都不执行原始用户脚本。

## 代码与验证

| 职责 | 入口 |
|---|---|
| 策略类型、ABI、失败与根校验 | `packages/ssh-agent/src/domain/remote-sandbox.ts` |
| 应用端口及一次性授权 | `packages/ssh-agent/src/application/services/remote-sandbox-provider.ts`、`remote-sandbox-approval-store.ts` |
| 分发、功能探针、缓存与引用 | `packages/ssh-agent/src/infrastructure/sandbox/landlock-remote-sandbox-provider.ts`、`shell-command.ts` |
| Native 规则、继承与 exec | `native/landlock-run/main.c`、[构建与内核测试说明](../../../native/landlock-run/README.md) |
| 构建和资源完整性 | `native/landlock-run/build.mjs`、`check-resources.mjs`、`packages/ssh-agent/resources/sandbox/` |
| 状态机、确认前缀与审计 | `packages/ssh-agent/src/application/services/command-operation-service.ts`、`sandbox-confirmation-capture.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-command-operation-repository.ts` |
| Chat 审批及 Tool 参数 | `packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts`、`chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/tools/remote-server-call-tool.ts` |
| 前端配置和检测 | `packages/ssh-agent-web/features/workspace/components/remote-sandbox-panel.tsx`、`workspace-dialog.tsx`、`workspace-edit-dialog.tsx` |
| 定向测试 | `packages/ssh-agent/test/remote-landlock-sandbox.test.ts`、`packages/ssh-agent-web/tests/remote-sandbox.test.tsx`、`native/landlock-run/security-test.py`、`native/landlock-run/ssh-smoke-test.mjs` |

模拟 Broker 测试覆盖部署/缓存、失败关闭、人工授权、Guard 变化和审计。原生内核测试使用一次性 Linux 与临时文件，覆盖内容写入、truncate、rename、删除、符号链接、解释器/后代进程、继承 FD、部分副作用和模拟缺失 syscall。交叉构建或 ELF 检查不能代替相应架构的实际 Linux 内核验证。

`ssh-smoke-test.mjs` 使用显式提供的一次性回环 SSH fixture、合成账户和内存数据库，贯穿正式 Target/Host Trust、SFTP 投递和内核执行。它验证后代进程越界拒绝、部分副作用、未审批 Full Access 和无效 cwd，不调用模型。fixture 准备与清理见 native README。
