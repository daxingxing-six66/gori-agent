# 远端 Linux 命令沙箱代码路由

适用于 `remote_server_call`、`/deploy` 与 Terminal Mode 的远端文件访问约束、后端选择、启动器分发、能力探测、Full Access 与执行事实审计。当前 `RemoteSandboxCoordinator` 依次配置 Landlock 与 Bubblewrap 两个后端，扩展边界见[多后端设计](../design/remote-sandbox-backends.md)。Session 默认开启普通沙盒；非只读模式开启时命令预检优先选择可用沙箱，明确无后端或已知写入路径越界才申请一次性人工 Full Access 例外。用户通过 Session 设置关闭时，普通命令、部署远端阶段与 PTY 直接跳过探测、准备和受限执行，无逐次例外 grant，仍保留 Guard 与普通审批。配置与自动重开见 [session-sandbox.md](./session-sandbox.md)。本地工作目录、SFTP 与监控不经过命令沙箱。非只读 Session 的 `sftp_upload` 仍按 SSH 账号权限写入，新增文件不因命令沙箱受限；沙箱事实只针对命令或 PTY 进程。

`/deploy` 的 RESTART/VERIFY 由绑定的 Agent 逐阶段请求，仍通过 `CommandOperationService` 执行。Session 开启沙盒时，服务端按已声明写入路径和实际沙箱能力选择执行模式：受限步骤服从 Session `autoAudit`，例外步骤必须逐条人工批准；计划确认不等于 Full Access 授权。UPLOAD 仍走 SFTP，不受命令沙箱约束；部署服务额外以 SFTP realpath 检查上传目录处于 Profile 允许目录内，不能把该检查等同于内核沙箱。详见 [deployment.md](./deployment.md)。

## 只读 Session

Session `sandboxReadOnly=true` 时，目标实际范围固定为 `/tmp`（另保留 `/dev/null`），忽略但保留原可写目录配置。命令、Terminal 继续使用现有受限后端，审计保持实际 `workspace_write` + `sandboxRoots=["/tmp"]`，不引入第三种内核后端模式。禁止显式或路由产生的 Full Access 例外，缺少沙盒直接失败；Agent 上传、安装和部署写入入口被禁用。读取日志不受目录白名单限制，仍需 SSH 账号读取权限。完整策略、API 与生命周期见 [session-sandbox.md](./session-sandbox.md)。以下关于 Full Access 例外和安装的流程仅适用于非只读模式。

只读准备只复用已存在且摘要验证通过的 Landlock launcher；不创建缓存目录、不上传或修复文件。缺失时尝试已安装的 Bubblewrap，仍要求版本/所有权/功能验证。Bubblewrap 只在 `/tmp` 生成写入探针，根外通过已有宿主可写目录在受限视图中的不可写性验证，不生成或清理根外探针。普通模式保留原部署/探测行为。两个模式的发现缓存分别隔离，连接和 generation 规则不变。无现成后端的服务器必须先独立准备，不能在只读排障中自动安装。

只读仍沿用下述直接文件写入策略及信任前提，网络、IPC、进程信号、元数据和 Bubblewrap 宿主进程路径等既有边界不变；本地工具、Workspace 独立 SFTP 页面不受 Session 选项控制。定向回归为 `test/read-only-sandbox.test.ts`，未进行生产服务器或真实 Linux 内核验收。

## 策略与边界

- Session 缺省开启，对应 `workspace_write`；只有明确关闭才对应无沙盒 `full_access`。以下受限规则适用于开启状态。启动器授予 `/` 读取和执行，授予当前 Session 的 `sandboxWritableRoots`、规范化后的 `/tmp` 和真实 `/dev/null` 内容写入。Linux 常规权限仍同时生效。单条命令覆盖 `cwd` 不扩大可写范围。
- 已取消 `remoteDefaultCwd`；未指定 cwd 的命令从 SSH 用户家目录启动，PTY 保留 SSH 初始目录，SFTP 默认从 `/` 浏览；本地 `defaultCwd` 仅供本地 Session 使用。Workspace 保存 `sandboxWritableRoots` 默认列表，新 Session 创建时复制为独立配置，已有 Session 不随 Workspace 修改。显式列表接受 1–16 个互不重复的绝对非根路径，每条最多 4096 字符、不含换行/NUL。配置层保留原文，不 trim 或折叠 `..`，避免改变远端符号链接语义。执行前逐条远端 `realpath -e` 验证存在、可读、可进入，规范别名去重；根别名及任何包含启动器缓存的可写目录均拒绝。临时目录仅接受 `realpath -e /tmp` 仍为 `/tmp`；启动器逐段禁止跟随规则路径中的符号链接，并拒绝将实际根目录授予写权限，防止准备与安装之间的路径置换扩大边界。
- v21 将旧工作区显式 `remote_sandbox_root` 优先迁为统一的 `remote_default_cwd`，保留原有写入边界，然后删除旧列。此前未配置独立根的旧工作区保留原远端目录；仍为 `/` 的记录无法开启受限写入，须通过编辑选择非根目录。历史命令审计事实不改写。v28 将旧远端目录复制为 Workspace 单元素列表，再复制到已有 Session；`/` 迁为显式空列表，表示尚未配置。保留路径拼写、revision 和历史；显式空列表不回退到 cwd，受限准备失败关闭。v32 删除远端默认目录列，保留已迁移的独立目录列表和历史事实。
- Landlock 最低 ABI 为 **5**：ABI 3 才覆盖 truncate，ABI 5 才覆盖设备 ioctl。`remote_server_call` 对旧 ABI、缺失 syscall 或未启用 LSM 自动尝试 Bubblewrap；功能探针故障直接失败。Session 开启时，Terminal 打开要求可用的受限后端；能力不足、Bubblewrap 缺失、根无效及准备失败都会保留具体失败码，不启动无沙箱 PTY。详见 [Terminal Interaction](./features/terminal-interaction.md)。
- `enforcement=full` 表示本策略要求的直接文件写入规则通过探测，不表示完整主机隔离。Bubblewrap 的运维兼容模式共享宿主 PID 与网络视图，保留同 SSH 账号在 Linux 权限内的进程检查和信号操作；通过控制宿主进程或 `/proc/<pid>/root` 等路径可间接影响授权根外文件，不能将挂载规则当作防恶意绕过的边界。文件元数据操作（chmod/chown 等）、网络和 IPC 不在共同策略内。受限 Terminal 在打开整段 PTY 时安装选中的后端策略；SFTP 有独立权限边界。SSH 账号、Shell 启动文件及其可写启动器缓存属于信任前提：账号 Shell 可能在安装约束前运行代码，同账号无约束进程也可能篡改缓存；nonce 不是对恶意远端账号的证明。参考 [Linux Landlock 限制](https://docs.kernel.org/userspace-api/landlock.html#current-limitations)。

## 执行与审批

Chat Guard 预检查 → 当前 Session 策略与审批计划 → Session FIFO/进程许可 → 最新 Guard → 解析 Target/复核 Session 策略 → 例外 grant 消费或 Session 授权来源验证 → expectedTarget/cwd 校验 → 按模式准备 → Guard 再检查 → Broker exec。关闭时按模式准备只进行共用 Bash/cwd 包装，不进入沙箱 Provider。

Command Service 按上述顺序编排，`CommandExecutionPolicy` 集中执行期检查并消费授权，`CommandOperationRecorder` 集中 Operation 状态、输出、事件和沙箱审计。策略不修改 Operation，也不决定新的执行模式；状态记录器不批准权限或执行命令。两次 Guard 复检共用失败组装，但保留各自的时间边界。

普通 Chat 命令在授权阶段生成不可变 `RemoteCommandExecutionPlan`，显式记录原请求、调用身份、`workspace_write` 或 `full_access`、例外理由和已解析目标。Coordinator 只在审批通过并完成 grant 记录后返回内部执行上下文，Agent 将同一计划交给对应远端 Tool。Tool 先校验调用身份和参数，再直接提交计划的权限与 `expectedTarget`。`RemoteSandboxApprovalStore` 只保存 grant 签名和目标签名，负责一次性验证/消费及清理；审批理由不再用作“是否获准 Full Access”的查询接口。Session 关闭的计划使用 `authorizationSource=session_setting`，不请求例外 grant，提交与出队均复核当前设置；开启状态的 Full Access 计划本身不能替代 grant，已消费或被清理的例外计划仍会在派发时失败，不能隐式降回沙箱执行。受限命令与 Full Access 命令均检查审批阶段确定的目标，Workspace 身份或 Session 完整可写目录列表变化时拒绝执行。Target 数组在计划中复制并冻结，grant 的目标签名也绑定完整列表。

Session 开启的普通 Chat Run 先通过 `evaluateRemoteSandboxRoute` 探测后端与规范根，并检查模型声明的已知绝对 `write_paths`，落在任一规范可写根内即可；路径前缀相似的相邻目录不算在范围内。后端可用且路径在可写范围内时，默认 `remote_server_call` 按 `workspace_write` 执行：`autoAudit=true` 自动批准，`autoAudit=false` 逐条人工批准，批准本身不会取消沙箱。未声明的脚本副作用无法可靠预判，先在沙箱内尝试。明确无可用后端或已知路径越界时，审批记录使用 `remote_sandbox_exception` 标识并要求人工批准；准确命令获得一次性 Full Access grant。Session 开启时，模型显式请求 `sandbox_permissions: "full_access"` 仍需非空理由和人工批准；只传理由会在审批前返回可修正错误。Chat 审批链验证 Full Access 决策 `source=user`。部署沙箱例外使用部署专属逐命令审批；受限的重启/验证步骤由 `autoAudit` 决定是否逐条弹出 Chat 审批。两条命令流程最终都由 Command Service 检查受限模式或消费一次性 grant。grant 绑定授权范围、Tool Call、Session、原命令、cwd、timeout 和理由；一次消费即删除，参数不匹配也删除，工作流结束清理，重启不会恢复。部署另外在派发前及命令队列出队后检查固定 SSH 目标身份。Full Access 仍服从 Guard，也不提升 SSH 用户权限；失败的受限命令不会自动升级或重放，新的 Full Access 重试须重新人工批准。

所有路径和完整脚本通过单一 POSIX 参数引用 helper 组装。`cd` 成功后才启动独立 `bash --noprofile --norc -c`，因此脚本中的分号或换行不能越过失败的 cwd 检查。普通命令与 Terminal 各自生成本次随机 nonce；Native launcher 安装规则、设置 no_new_privs、关闭额外继承 FD 后才发出含 nonce 的 stderr 确认并 exec；后代进程继承限制。

开启状态的显式 Full Access 请求缺少非空理由、仅传理由却未声明 Full Access，以及所有状态下 `write_paths` 使用相对路径或包含非法字符，均在审批前以 `terminate: false` 返回 Tool 错误，让模型修正参数。路径格式错误在探测前拒绝，不创建审批或执行命令。纠正后仍需逐次人工审批；错误反馈本身不生成 grant，也不放宽 Guard。交互模式不允许的沙箱检查、安装工具只拒绝本次调用并将错误交回模型；部署模式不额外禁用命令模式中已有的检查和人工审批安装能力。

各工具模块持有自己的审批准备逻辑；`ChatToolAuthorizationPolicy.prepare()` 只分发并按 `tool-authorization.ts` 的契约转换已知请求错误。工具自身的可用性检查在审批前和直接执行入口生效。探针故障、持久化故障与未知异常不当作可修正参数错误，继续失败关闭。

Operation 初始审计保存 `enforcement=none/commandMayHaveRun=false`。独立的确认捕获器用 waiting/confirmed/missing 三种状态处理 stderr，只有含本次 nonce 的远端确认行匹配后才保存实际后端、Landlock ABI/launcherVersion 或 Bubblewrap 版本、完整 `sandboxRoots`、首根兼容字段 `sandboxRoot` 与 `enforcement=full`，协议行不进入用户输出。`stored-command-sandbox.ts` 在 SQLite 读取 `sandbox_json` 时按后端验证必要字段、根路径及可选布尔字段，损坏的审计事实不会直接进入领域对象。远端 shell 的前置诊断保留；有限长度内没有确认则返回 `sandbox_confirmation_missing`，保守记录命令可能已执行。超时、断线或运行中重启同样不能断言无副作用。

非零退出时 stderr/输出尾部的权限文案仅产生 `denialSuspected`，不冒充内核拒绝证据。此前已成功的写入仍可能保留。Tool 结果和 SQLite 保存实际 mode/backend/enforcement、后端版本与规范根、Run/Tool 身份及 Full Access 理由；没有自动重试。

## Bubblewrap 交互终端

普通命令与文件系统探针继续使用 `--new-session`。`prepareTerminal` 单独复用原 SSH 控制终端，不用 `setsid` 脱离它；否则内层 Bash 无作业控制、外层 monitor 仍在前台，Ctrl+C 会误杀整个终端。共同挂载参数由同一函数生成，交互路径仅补控制终端 `/dev/tty`，不暴露整个宿主 `/dev`，不创建第二个 PTY。该设备访问不扩大目录可写根，只读 Session 同样保留正常终端操作。

`bubblewrap-terminal-launch.ts` 用外层无配置 Bash 的 builtin `printf` 把固定 cBPF 字节写到短生命周期内存管道，通过 `--seccomp 3` 传入。bwrap 加载并关闭 FD，在 exec 前安装规则；无远端过滤文件、编译器、运行时安装或常驻转发进程，也不在只读准备中写入缓存。`terminal-seccomp-filter.ts` 按 arch/syscall 识别 x86_64/x32/i386/aarch64/ARM EABI 的 ioctl，按内核实际使用的低 32 位 request 拒绝 TIOCSTI/TIOCLINUX（EPERM），保留正常 ioctl 和其他 syscall；未知 ABI 返回 ENOSYS，不能无过滤继续运行。规则补充终端注入防护，不改变共享 PID/网络的既有安全边界。

受限引导 Bash 使用 `--noprofile --norc -i -c`，先检查 job-control 标志、stdin/stdout TTY 与 `/dev/tty` 可打开，再发原 nonce 并 exec 原 `bash --login -i`。失败返回 125 且不确认；seccomp 安装失败发生在该 Shell 启动前。账号登录脚本顺序保留，仍属信任前提，可自行修改终端设置。空闲 Ctrl+C 取消输入；普通前台命令按前台进程组接收信号；raw-mode 程序自行处理按键。主动退出和断线保留原 Channel/Actor 生命周期，不忽略 SIGINT、不自动重开或重放输入，不新增 `--die-with-parent`。

该修复不改工具目录、固定提示词、人工交接正文结构或 Session 缓存键，不新增模型上下文元数据。真实 PTY 验收入口见 [内核回归](../../../native/bubblewrap-terminal/README.md)，macOS/Windows 上的单元测试不能代替内核验证。

2026-10-27 验证：非 root、无 capabilities、无网络和宿主挂载的一次性 Linux arm64/Bubblewrap 0.12.0 环境通过 23 项真实 PTY/内核检查，覆盖空闲/未完成输入/前台命令/管道 Ctrl+C、Ctrl+Z/bg/fg、注入与根外写入拒绝、alternate screen/SIGWINCH、Vim/CJK、只读、exit 状态和挂断清理。另经授权在 Linux x64/Bubblewrap 0.13.0 的原会话通过内部浏览器发送同一 `0x03` 字节，确认空闲与 sleep 中断后原 Shell PID 保留，前台归属恢复，并以无效 FD 验证注入请求 EPERM、普通 ioctl EBADF。兼容 ABI 目前只有 cBPF 指令解释测试，不声称全部做过原生内核实测；未调用付费模型。

## 分发与探测

Bubblewrap 只使用远端已安装的、root 拥有且非 setuid 的 0.12.0 及以上 `bwrap`。Landlock 明确不可用时自动尝试；缺失时返回 `sandbox_bubblewrap_not_installed`。Session 开启时，普通命令若要在无沙箱状态下执行，必须另经标识明确的人工例外审批，不会自行绕过沙箱。模型可先用无需审批的 `bubblewrap_inspect` 读取发行版、UID 和包管理器，再用 `bubblewrap_install` 提交服务端生成的准确安装命令。此工具无论 `autoAudit` 设置如何都要求用户批准，Command Operation 消费绑定该命令及审批时 SSH 目标身份的一次性 Full Access grant。安装失败将输出交回模型供其调整包管理器、sudo 或索引刷新后重新提案；安装成功自动重新探测，后续探测和受限沙箱使用无需安装审批。已安装但不能运行不按“未安装”处理。新 Session 创建本身不连接目标机，首次受限命令、Terminal 打开或 Overview 手动检测才触发探测。

Bubblewrap 不显式创建 user/PID/network namespace：root 使用现有身份，非 root 允许 Bubblewrap 为挂载创建必需的内部 user namespace。共享宿主 `/proc` 的只读绑定不重新挂载私有 procfs；功能探测要求沙箱内外 PID 与网络 namespace 标识一致、可读取宿主探测父进程并对其执行同账号允许的信号 0，同时逐根检查写入成功，检查所有根之外的直接写入被拒绝。多个 bind 按父目录先于子目录排序，防止嵌套挂载覆盖。`--die-with-parent` 不再使用，避免启动器退出时主动终止后台服务。失败则在执行原始命令前返回沙箱不可用。真实服务停止、启动和 PTY 行为仍需目标 Linux 主机验收。

Terminal 打开后异步探测失败时，前端保留失败卡片，展示后端的 `failureMessage`，并用 `failureCode` 决定可用操作。若为 `sandbox_bubblewrap_not_installed`，用户可在卡片点击“交给模型处理安装”；这会以命令模式创建 Chat Run，模型随后执行检查并提出安装审批。点击入口本身不批准安装。

- `RemoteSandboxCoordinator` 按注入顺序尝试 `RemoteSandboxBackend`；只有明确不可用的后端错误才进入下一后端，根无效、投递或探测失败等错误直接失败关闭。`RemoteSandboxProvider` 供命令和 Terminal 准备使用，独立的 `RemoteSandboxCapabilityProvider` 提供普通 `getCapabilities()` 与强制 `refreshCapabilities()`，调用方明确表达查询或刷新的意图。开启状态的 Full Access 例外包装由 Coordinator 负责；Session 关闭时由应用层直接调用 `remote-shell-command.ts`，不调用 Coordinator。两者共用 POSIX 引用 helper。
- 包携带 x64/arm64 静态 musl ELF，无远端编译或互联网下载要求。Zig 0.15.2 构建；资源 manifest 保存源码和产物摘要，`check:sandbox` 与后端 build 校验架构、静态链接及摘要。
- 远端通过 `uname` 选择架构，版本与二进制摘要确定 `$HOME/.cache/gori/sandbox/<launcherVersion>/<sha256>/gori-landlock-run`。同摘要现有文件可复用，否则 SFTP 投递随机临时文件，chmod 0700 后原子 rename，失败清理临时文件。
- v3 `--probe` 将 `ENOSYS`/`EOPNOTSUPP` 转换为明确的 unavailable 结果；其他探测错误仍失败关闭。能力可用时，在一次性子进程安装无授权规则，验证目录 open 确实被 EACCES 拒绝。两个后端共用 `SandboxCapabilityCache`，只缓存成功的 launcher/runner 元数据，按完整 Connection Key、只读标记与 generation 隔离；失败不缓存。普通查询复用有效元数据，强制刷新等待较早的发现完成后再重新发现，同身份的并发刷新合并。刷新中的新查询等待新结果；取消等待者不取消其他请求拥有的发现。重连/凭据变化重新发现。每次查询和准备仍检查目录、设备及 Bubblewrap 实际约束，缓存不是单次执行受约束的证明。
- Chat/部署预检及安装必要性检查使用 `getCapabilities()`；Overview 手动检测和安装完成后的验证使用 `refreshCapabilities()`。能力查询直接生成校验后的事实，不再通过准备一条 `true` 命令生成无用的确认 nonce。刷新操作的 30 秒时限覆盖等待发现、重新发现及策略复检。
- `RemoteSandboxRules` 共用可写根、真实 `/tmp`、真实 `/dev/null` 与启动器位于可写范围外的校验。`SandboxCommandRunner` 共用准备命令执行与诊断：stdout 限制为 16 KiB，stderr 最多保留 4 KiB；失败包含检查阶段、退出码/信号、限长 stderr 和原始 cause，保留已有 SSH 失败码与取消语义。公开 HTTP/SSE 仍按稳定 code 本地化，内部诊断不直接透传浏览器。
- `POST /api/workspaces/:id/sandbox` 通过 Coordinator 显式刷新能力，不执行用户命令；它会使用正式 Host Trust/连接并可能投递启动器。响应按 Landlock ABI 或 Bubblewrap 版本分别校验，并展示 Workspace 默认列表的所有规范根。这不是 Session 的当前范围，只是最后一次能力检测结果，不证明后续命令已经受约束；命令仍在自己的执行路径校验。Overview 初始显示“尚未验证”，检测后显示后端能力、规范根或本地化失败原因及时间；修改 Workspace revision/离开页面会清理状态。检测面板位于 Dashboard 辅助区域，限制说明可展开查看；状态与检测入口直接可见，折叠说明不触发检测或更改 Session 设置。
- 准备阶段限时 30 秒，并服从调用取消和执行超时；需要远端 Bash、realpath、sha256sum、stat 及原子 mv 工具。任何准备失败都不执行原始用户脚本。

## 代码与验证

| 职责 | 入口 |
|---|---|
| Session 设置、集中策略、直接执行与 Terminal 重开 | [session-sandbox.md](./session-sandbox.md)、`packages/ssh-agent/src/application/services/session-sandbox-policy.ts` |
| 策略类型、ABI、失败与根校验 | `packages/ssh-agent/src/domain/remote-sandbox.ts` |
| 应用端口、预检路由及一次性授权 | `packages/ssh-agent/src/application/services/remote-sandbox-provider.ts`、`remote-sandbox-routing.ts`、`remote-sandbox-approval-store.ts` |
| 后端选择、Full Access 包装与显式探测 | `packages/ssh-agent/src/infrastructure/sandbox/remote-sandbox-coordinator.ts` |
| 分发、Landlock 功能探针与引用 | `packages/ssh-agent/src/infrastructure/sandbox/landlock-remote-sandbox-provider.ts`、`shell-command.ts` |
| 元数据缓存、强制刷新与并发等待 | `packages/ssh-agent/src/infrastructure/sandbox/sandbox-capability-cache.ts` |
| 准备命令、限长诊断与共同文件规则 | `packages/ssh-agent/src/infrastructure/sandbox/sandbox-command-runner.ts`、`remote-sandbox-rules.ts` |
| 新旧审计事实的 SQLite 读取边界 | `packages/ssh-agent/src/infrastructure/sqlite/stored-command-sandbox.ts`、`stored-terminal-sandbox.ts` |
| Bubblewrap 探测、执行与安装 | `packages/ssh-agent/src/infrastructure/sandbox/bubblewrap-remote-sandbox-provider.ts`、`packages/ssh-agent/src/application/services/bubblewrap-installation-service.ts`、`packages/ssh-agent/src/application/tools/bubblewrap-installation-tool.ts` |
| Bubblewrap PTY 启动、seccomp 与真实内核验收 | `packages/ssh-agent/src/infrastructure/sandbox/bubblewrap-terminal-launch.ts`、`terminal-seccomp-filter.ts`、`packages/ssh-agent/test/bubblewrap-terminal-launch.test.ts`、`terminal-seccomp-filter.test.ts`、`native/bubblewrap-terminal/` |
| Native 规则、继承与 exec | `native/landlock-run/main.c`、[构建与内核测试说明](../../../native/landlock-run/README.md) |
| 构建和资源完整性 | `native/landlock-run/build.mjs`、`check-resources.mjs`、`packages/ssh-agent/resources/sandbox/` |
| 命令编排与执行期策略 | `packages/ssh-agent/src/application/services/command-operation-service.ts`、`command-execution-policy.ts` |
| 状态、确认前缀与审计 | `packages/ssh-agent/src/application/services/command-operation-recorder.ts`、`sandbox-confirmation-capture.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-command-operation-repository.ts` |
| Chat 审批及 Tool 参数 | `packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts`、`chat-tool-call-coordinator.ts`、`packages/ssh-agent/src/application/tools/remote-server-call-tool.ts`、`tool-authorization.ts` |
| 命令计划、参数/目标快照与内部交接 | `packages/ssh-agent/src/application/tools/remote-command-execution-plan.ts`、`packages/agent/src/types.ts`、`packages/agent/src/agent-loop.ts`；测试见 `packages/ssh-agent/test/remote-command-execution-plan.test.ts`、`packages/agent/test/tool-execution-context.test.ts` |
| 前端配置和检测 | `packages/ssh-agent-web/features/workspace/components/remote-sandbox-panel.tsx`、`remote-sandbox-panel.css`、`workspace-dialog.tsx`、`workspace-edit-dialog.tsx` |
| 定向测试 | `packages/ssh-agent/test/remote-sandbox-coordinator.test.ts`、`remote-sandbox-routing.test.ts`、`remote-landlock-sandbox.test.ts`、`bubblewrap-remote-sandbox.test.ts`、`bubblewrap-installation-approval.test.ts`、`packages/ssh-agent-web/tests/remote-sandbox.test.tsx`、`native/landlock-run/security-test.py`、`native/landlock-run/ssh-smoke-test.mjs` |

模拟 Broker 测试覆盖部署/缓存、普通查询与刷新分离、并发刷新合并、等待取消、诊断长度/Unicode/退出状态、失败关闭、人工授权、Guard 变化和新旧审计读取。共同组件回归见 `sandbox-capability-cache.test.ts`、`sandbox-command-runner.test.ts`。原生内核测试使用一次性 Linux 与临时文件，覆盖内容写入、truncate、rename、删除、符号链接、解释器/后代进程、继承 FD、部分副作用和模拟缺失 syscall。交叉构建或 ELF 检查不能代替相应架构的实际 Linux 内核验证。

`ssh-smoke-test.mjs` 使用显式提供的一次性回环 SSH fixture、合成账户和内存数据库，贯穿正式 Target/Host Trust、SFTP 投递和内核执行。它验证后代进程越界拒绝、部分副作用、未审批 Full Access 和无效 cwd，不调用模型。fixture 准备与清理见 native README。

多目录公共校验位于 `src/domain/sandbox-writable-roots.ts`，管理字段校验位于 `src/application/sandbox-writable-roots.ts`，SQLite 配置读取位于 `stored-sandbox-writable-roots.ts`。新审计事实携带完整 `sandboxRoots`，`sandboxRoot` 必须等于首项；历史仅有单根的事实保持可读，不据其恢复授权。前端共用 `sandbox-writable-roots-field.tsx`、`model/sandbox-writable-roots.ts` 与多选 `remote-directory-picker.tsx`，Session 编辑入口为侧边栏铅笔打开的 `session-edit-dialog.tsx`，目录在 `session-dialog.tsx` 与其他字段一起保存；页首标识只读。回归见 `test/sandbox-writable-roots.test.ts`、`test/multiple-sandbox-roots.test.ts`、`test/deployment-sandbox-roots.test.ts` 及前端同名列表测试。
