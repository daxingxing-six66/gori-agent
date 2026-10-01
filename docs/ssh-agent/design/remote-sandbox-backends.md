# 远端沙箱多后端设计

本文区分已经落地的多后端协调层与后续扩展目标。当前仓库只有 Landlock 后端；Bubblewrap 尚未接入，也没有经过本项目的兼容性或安全验证。

## 当前边界

`remote_server_call` 默认请求 `workspace_write`。`RemoteSandboxCoordinator` 当前持有一个 `LandlockRemoteSandboxProvider`，后者准备启动器、检查远端能力和工作目录，并返回 SSH exec 命令及带随机 nonce 的确认标记；`CommandOperationService` 仅在收到启动器的 stderr 确认后把实际约束记入审计。用户逐次批准的 `full_access` 由 Coordinator 包装为普通远端命令，不安装沙箱。Landlock 不可用或 ABI 小于 5 时，默认命令失败关闭，不自动以 Full Access 重放。

Terminal Mode 在打开整段 PTY 时通过 Coordinator 调用受限后端的 `prepareTerminal`。当前只有 Landlock 明确报告不可用或 ABI 不足，`TerminalSessionService` 才通过普通 SSH shell 回退为整段会话的 Full Access，并记录 `source: "sandbox_unavailable"`、向用户显示提醒。非 Linux、架构不支持、根目录无效、启动器投递失败、探测异常及连接故障均不触发自动回退。受限 PTY 收到带随机 nonce 的启动确认、持久化为 `active` 后才释放启动输出。已打开的 Terminal 不按单条输入切换约束。

协调层已分离选择策略与具体机制：`RemoteSandboxBackend` 只准备受限命令与 PTY，并继承独立的 `RemoteSandboxProber`；`RemoteSandboxCoordinator` 实现命令/Terminal Provider，并由运行时调用其显式 `probe`。目前通过稳定错误码的 `isSandboxBackendUnavailable` 判断是否尝试下一后端，通过更窄的 `isTerminalSandboxFallbackEligible` 判断是否可自动开启无沙箱 PTY。命令、Terminal、SQLite 和前端事实目前仍只认识 `landlock` 与 `none`，前端的 ABI/提示文案也以 Landlock 为中心。

## 目标结构与职责

```text
CommandOperationService ─┐
                         ├─ RemoteSandboxCoordinator ─ 有序的 RemoteSandboxBackend[]
TerminalSessionService ───┘                           ├─ LandlockRemoteSandboxProvider（已实现）
                                                      └─ BubblewrapBackend（未来）
```

`RemoteSandboxCoordinator` 已是命令和 Terminal 的受限后端选择入口，位于 `infrastructure/sandbox`。它按注入顺序逐个尝试后端，提供显式能力检测及 Full Access 命令的无沙箱包装。逐次 Full Access 授权、Guard、Operation 状态、SSH Channel、Terminal 生命周期仍由现有所有者管理；Coordinator 不签发授权、不执行用户命令，也不将失败的受限尝试自动重放。

`RemoteSandboxBackend` 已定义 `probe`、受限命令 `prepare` 与受限 `prepareTerminal`；Full Access 不在这个接口中。现有 Landlock 后端按目标 SSH 身份与连接 generation 缓存能力，逐次规范化并验证工作区可写根，返回后端特有的约束证据和确认标记。接口尚未声明稳定的 backend ID；未来增加后端时应把 ID 纳入判别式事实。显式刷新能力与普通准备共享规则，但探测结果不能冒充某次命令的已生效事实。

当前 Coordinator 用 `SshAgentError` 的明确错误码分类：

| 结果 | 含义 | Coordinator 动作 |
|---|---|---|
| 准备成功 | 产生可执行的受限启动计划 | 停止选择，交给现有 Broker 执行 |
| 明确不可用 | `sandbox_unavailable`、`sandbox_partial_enforcement`、`sandbox_unsupported_platform` 或 `sandbox_unsupported_architecture` | 尝试下一个后端 |
| 其他错误或取消 | 根配置不安全、投递/探测失败、连接错误、超时或状态不明 | 立即失败，不尝试 Full Access |

“ABI 小于 5”只对 Landlock 构成明确不可用；未来 Bubblewrap 必须独立判断其可用条件。`/` 或其他不安全可写根是策略输入错误，不能因为另一个后端存在而回退为无约束。任何后端已经开始执行用户命令、打开 PTY 或丢失启动确认后，也不得切换到下一后端。取消应贯穿所有探测、准备和 Channel 打开阶段。未来可以把错误码分类收敛为判别式结果，避免新增后端时遗漏分类。

对 `remote_server_call`，全部受限后端明确不可用后仍按当前策略失败关闭；需要 Full Access 时必须发起新的、经人工审批的完整工具调用。对 Terminal，Coordinator 耗尽后端后，只有每个后端的错误都属于 `sandbox_unavailable` 或 `sandbox_partial_enforcement` 才允许回退；任一后端报告非 Linux 或架构不支持时，即使后续后端仅报告不可用，也不会自动回退。未来加入后端后，应让协调层返回能表明**所有后端均明确不可用且允许 Terminal 回退**的独立结论。UI 的提醒应说明本次 PTY 生命周期内的文件操作不受沙箱约束，不能把提醒误写成用户可选择的授权步骤。

## 启动确认与事实

`PreparedRemoteExecution` / `PreparedRemoteTerminal` 只包含**预期**约束、SSH 启动命令和确认协议；生成计划或收到 SSH exec 回调都不等于约束已生效。现有 Landlock 对普通命令和 Terminal 都使用本次随机 nonce；启动器安装约束后、运行用户脚本或 Shell 前输出确认。后续每个后端也必须提供同等可信的确认。Command 与 Terminal 各自使用有限缓冲的确认捕获；Command 将实际事实写入 Operation，Terminal 先持久化 `active` 与事实，再释放缓冲的启动输出。缺失确认、通道提前关闭和超时均不能触发后端切换或无沙箱重试。Bubblewrap 的准备进程或 `bwrap` 可执行文件存在本身不能充当成功确认。

请求模式与实际事实已分开保存。当前受限事实为 `backend: "landlock"`，保留 `abi`、`launcherVersion`、规范根；未来 Bubblewrap 分支应记录其自身可验证的版本/配置证据及同一规范根，不伪造 ABI。Full Access 使用 `backend: "none"`、`enforcement: "none"`；Terminal 自动回退的新记录使用 `source: "sandbox_unavailable"`，历史 `source: "landlock_unavailable"` 与 `approvedAt` 仍可读。Operation 在确认前保存尚未证实的状态；Terminal 的旧 `sandbox: null` 仍代表历史未知，不得迁为已受保护。

未来增加 backend 时，SQLite 与 HTTP/前端解析器应对每个已知 backend 单独严格校验必要字段，拒绝未知或矛盾的事实；不要把 ABI 或启动器版本设为所有 backend 的必需字段。当前显式检测接口仍返回 Landlock 形状的 `RemoteSandboxFacts`，前端也固定展示 ABI。后续应改为独立的 `SandboxProbeResult`（可用后端、能力证据、规范根，或全部明确不可用的理由），与执行后的 `SandboxExecutionFacts` 区分。新增 JSON 分支只需兼容性扩展读取边界，现有 SQLite JSON 字段和历史事实不需要覆写；若改变字段布局，应配套迁移和旧库回归测试。

## 文件策略与 Bubblewrap 接入门槛

当前 Landlock 策略允许 `/` 读取/执行、工作区统一的 `remoteDefaultCwd`、真实 `/tmp` 和真实 `/dev/null` 的内容写入；单条命令 `cwd` 不扩大可写范围。启动器用逐段不跟随符号链接的打开方式把规则绑定到最终 FD，拒绝规则路径被替换后指向 `/`；`/tmp` 如果规范化到其他目录也拒绝。`enforcement: "full"` 只表示该后端完整执行了**已声明的文件策略**，不表示完整主机隔离。网络、IPC 与其他未承诺的操作要按每个后端的实际配置分别说明。SSH 账号、Shell 启动文件及同账号可写的启动器缓存仍是信任前提；nonce 不能抵御恶意远端账号或先前获准的无约束进程篡改启动器。

Agent 另有 `sftp_upload` 工具，它通过独立 SFTP 协议写远端文件，不是 Landlock 或未来 Bubblewrap 子进程的一部分。当前新文件上传只按 SFTP/SSH 账号权限执行，覆盖已有文件才走该工具的覆盖审批；因此沙箱事实不能表述成“Agent 的所有远端写入均被限制在工作区”。如果产品目标扩展为这一层保证，需单独定义 SFTP 目标路径策略、符号链接与 TOCTOU 处理、审批及相应黑盒用例；仅增加第二种命令沙箱后端不会自动解决这个入口。

Bubblewrap 可以用挂载命名空间构造只读/可写视图；其上游文档列有 `--ro-bind` 和 `--bind`，但这些原语本身不证明 Gori 的策略等价或目标服务器可运行（[上游 README](https://github.com/containers/bubblewrap/blob/main/README.md)、[上游手册](https://github.com/containers/bubblewrap/blob/main/bwrap.xml)）。接入前至少完成以下工作：

1. 明确发行和信任模型：使用目标机已安装的 `bwrap` 还是随包投递，验证版本、文件身份和路径，决定是否允许 setuid 变体；不得在远端隐式下载执行文件。
2. 在目标 Linux 上验证用户命名空间、挂载命名空间及实际配置可用；通过真实写入拒绝测试确认完整策略。能力探测失败与明确不支持要分别返回。
3. 设计只读基础视图和工作区、`/tmp`、`/dev/null` 的可写映射，检查符号链接、已有子挂载、设备节点、继承文件描述符、工作目录、登录 Shell 初始化和子进程继承，验证没有越界写入通道。额外的 namespace 或网络隔离属于另行声明的策略，不可由 backend 名称推断。
4. 为命令和 PTY 都实现安装完成后的可信 nonce 确认、取消/关闭竞态处理和实际事实记录；在最初的受限启动失败时不得自动执行无约束 Shell。
5. 用同一组黑盒用例比较 Landlock 与 Bubblewrap 的允许写入、越界写入、重命名、删除、truncate、子进程、符号链接与部分副作用；覆盖不同发行版与内核条件。Full Access 的 Guard 和逐次审批维持独立测试。

完成这些验证前，Bubblewrap 不应被加入可选后端列表，也不应在 UI 宣称已提供保护。
