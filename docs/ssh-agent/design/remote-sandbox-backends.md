# 远端沙箱多后端设计

## 选择与执行

`RemoteSandboxCoordinator` 按 `LandlockRemoteSandboxProvider`、`BubblewrapRemoteSandboxProvider` 的顺序尝试。Landlock 明确报告内核或 ABI 能力不足时，自动探测已安装的 Bubblewrap；任何可用后端都无需沙箱能力审批。根无效、投递或探测异常直接失败，不切换到无沙箱命令。普通 `remote_server_call` 永远不会因沙箱失败自动变为 Full Access。显式 Full Access 仍由人工批准准确命令并消费一次性 grant。

`getCapabilities()` 查询能力并复检当前策略，复用仍有效的后端元数据；`refreshCapabilities()` 用于主动重试或安装后的重新发现。两者都不运行用户命令，也不再构造虚拟 `true` 命令。首次受限命令、Terminal 打开和 Overview 的手动检查都会触发探测；创建 Session 本身不发 SSH 探测。成功的后端身份及连接 generation 用于缓存，但命令执行前仍会检查根和 Bubblewrap 的功能探针。命令和 Terminal 的真正生效事实，必须在后端启动后收到本次随机 nonce 确认才记为 `enforcement: full`。

新 Terminal 要求可用的受限后端。全部后端不可用或保护不足、Bubblewrap 缺失及其他准备错误都使打开失败；无沙箱 PTY 的人工授权入口尚未实现。旧版显式 Full Access 与自动回退记录仅在持久化读取边界兼容，不授予新 Terminal 权限。

## Bubblewrap 文件视图

后端只使用远端现有的 `bwrap`。发现时要求 Linux、规范绝对路径、root 拥有的可执行文件及各级父目录、无 setuid/可被组或其他用户写入，版本至少 0.12.0。最低版本基于 [上游 2026 年安全公告](https://github.com/containers/bubblewrap/security/advisories/GHSA-pxhw-h44j-8pfx)；旧版本即使包管理器做过补丁回移，当前仍按版本保守拒绝。root SSH 用户不显式创建 user namespace；非 root 用户允许 Bubblewrap 为挂载所必需的隐式 user namespace，目标机若禁用该机制则功能探测失败。二进制存在不等于可用。

每次准备使用 [Bubblewrap 挂载参数](https://github.com/containers/bubblewrap/blob/v0.13.0/bwrap.xml)：`--ro-bind / /` 为基础，规范 Workspace 根及真实 `/tmp` 单独 bind 为可写；`/dev` 是私有 tmpfs，仅重新映射真实 `/dev/null`；宿主 `/proc` 只读绑定，保留宿主 PID 和网络 namespace。没有显式 `--unshare-user`、`--unshare-pid` 或 `--die-with-parent`，使同 SSH 账号有权限的进程检查、信号操作及后台服务不因启动器退出而被主动终止。`--new-session` 仍防止控制终端注入。准备时读取宿主 PID 和网络 namespace 标识；在 Bubblewrap 内要求两者一致，并能读取、向仍在宿主运行的探测父进程发送信号 0。文件探测继续验证 Workspace 根和 `/tmp` 可写、`/dev/null` 可用，以及一个在宿主上可写且位于授权根外的目录在沙箱内变为只读。找不到可验证目录、挂载失败、宿主进程探测失败或非 root 用户所需的隐式 user namespace 不可用均拒绝使用。探测不提升 SSH 账号对其他进程的信号权限，也不验证特定服务的生命周期脚本。

命令脚本和 Terminal Shell 均在 Bubblewrap 完成命名空间与挂载后，由内部 Bash 输出随机确认标记。命令随后切换 `cwd` 执行；Terminal 使用 `bash --login -i`。Bubblewrap 的 `--new-session` 会移除控制终端，某些依赖 job control 或 `/dev/tty` 的交互程序可能不可用；正式目标机的 PTY 兼容性仍需验证。事实记录 `backend: bubblewrap`、`bubblewrapVersion`、规范根，不伪造 Landlock ABI。SQLite 旧 Landlock 与 Full Access 事实继续可读。

此约束只针对受限命令/PTY 的直接文件内容写入。网络、IPC、文件元数据、SFTP、同账号其他无约束进程和账号 Shell 启动阶段不在保证内。Bubblewrap 共享宿主进程视图；进程信号、服务管理器、`/proc/<pid>/root` 等路径或其他宿主进程可间接影响授权根外的文件，因此它是降低误操作风险的挂载边界，不是阻止有意绕过的完整安全隔离。`enforcement: full` 仅表示本策略的探测通过，不能推断 Landlock 与 Bubblewrap 的所有系统调用等价。

## 缺失安装时的人工决策

仅当 Landlock 明确不可用且 Bubblewrap 未安装时，Coordinator 返回 `sandbox_bubblewrap_not_installed`。模型可调用无需审批的 `bubblewrap_inspect` 读取发行版、SSH UID 与可用包管理器；`bubblewrap_install` 接受受限的包管理器、sudo 与索引刷新选项，服务端生成完整安装脚本。授权策略再次探测必要性并执行 Guard 预检查，再向用户展示**准确安装命令**。即使 Session 启用 autoAudit，也必须收到来源为 user 的批准。grant 绑定本 Run、Tool Call、Session、SSH 目标身份、命令、远端 `/`、十分钟 timeout 和固定理由，只能消费一次。Command Operation 继续执行队列、Guard 复检、目标身份校验与普通审计。

安装失败把退出原因和输出尾部交回模型；模型可据此选择另一包管理器、是否刷新索引或 sudo，重新提出安装方案并再次审批。成功后自动刷新两后端探测，后续探测和受限执行无需安装审批。已安装但版本太旧、功能不可用或发生其他探测故障时，不伪装成“未安装”，也不自动发起安装。

## 验证边界

当前仓库的模拟 Broker 测试覆盖选择顺序、缺失与不可用的区分、启动命令、宿主 PID/网络探针、nonce、安装 grant 和前端解析。开发机为 macOS，尚无可用 Linux 容器/目标机，因此 **Bubblewrap 的内核写入拒绝、宿主进程操作、后台服务存活、不同发行版安装和真实 SSH PTY 尚未完成实机验证**。启用目标机前须分别以 root 和非 root 临时 Linux 账户做宿主进程可见与有权信号、后台服务存活、越界写入、rename、truncate、符号链接、子进程、继承 FD、Terminal 和版本差异的端到端验收；这项限制不能由 TypeScript 单测代替。
