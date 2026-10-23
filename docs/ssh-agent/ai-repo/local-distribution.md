# Gori 本地工程与启动代码路由

适用于产品核心五模块及独立宣传站 package，不套用原 pi 产品的发布脚本。

| 关注点 | 源码入口 |
| --- | --- |
| workspace、检查与命令 | `package.json` |
| 构建依赖顺序、浏览器 API/事件地址 | `scripts/build.mjs`、`scripts/transport-config.mjs` |
| 初始化、固定密钥、生产/开发前后端进程及双 HTTP 监听启动与关闭 | `scripts/start.mjs`、`scripts/start.test.mjs` |
| 开发模式基础包源码映射 | `tsconfig.json` |
| 统一数据目录、密钥读写与回归 | `packages/ssh-agent/src/data-directory.ts`、`packages/ssh-agent/src/server/credential-key.ts`、`packages/ssh-agent/test/data-directory.test.ts` |
| 无秘密配置参考 | `.env.example` |

- 构建顺序为 telemetry、ai、agent、SSH 后端、浏览器；ai 使用随源码携带的模型目录离线构建。
- `packages/gori-website` 为独立静态宣传站，使用根 `dev:website`、`build:website`、`preview:website`，默认 loopback 4188。它不加入产品构建与启动链路，不依赖后端或真实模型；根 `check` 追加其 JavaScript 类型检查。详见 [宣传站路由](./gori-website.md)。
- 构建前清除旧 `.build-config.json`，完整成功后记录 API 和事件端口。浏览器两种地址在构建时确定；生产启动时指定不一致的 `SSH_AGENT_PORT` 或 `SSH_AGENT_EVENTS_PORT` 会失败，旧构建缺少事件端口时明确要求重建。
- 默认网页端口 3000、API 端口 3001、事件端口 3002，三者必须不同且只绑定 loopback。网页端口由 `SSH_AGENT_WEB_PORT` 控制；启动前检查所有端口，不结束其他程序。REST/SSE 连接隔离见 [transport-channels.md](./transport-channels.md)。
- `--setup` 顺序执行忽略依赖生命周期脚本的安装、构建和启动。不创建 GitHub Release。
- 根 `npm run dev` 执行 `start.mjs --dev`；安装依赖后即可启动，不要求构建产物，不读取或改写 `.build-config.json`。后端使用 `tsx watch --tsconfig <根 tsconfig.json>`，通过已有 paths 直接加载 agent、ai、telemetry 源码；显式监听四个后端包的 `src/`（包括尚未导入的文件）及根 tsconfig/base 配置。修改后自动重启后端，语法错误后可继续监听并在修复时恢复；前端执行 `vinext dev` 提供 HMR。后端重启重建运行时连接，不保留进程内任务状态。
- 开发模式直接读取三个 `SSH_AGENT_*PORT` 变量，校验互异和可用后同步前端 API/事件地址及后端 CORS，无需生产构建的端口记录。独立前端 dev 命令仍需自行保证端口匹配。
- 数据默认写入 `~/.gori-agent`，可由 `SSH_AGENT_DATA_DIR` 覆盖。数据库文件仍名为 `ssh-agent.sqlite`，密钥为 `credential-key`。密钥初始化由后端入口统一负责，直接启动与 dev 模式采用相同规则；显式环境密钥优先且不落盘。已有数据库却缺失密钥、或密钥格式无效时拒绝启动。
- 后端 cwd 设为数据目录，本地工作目录设为其 `workspace/`；日志写入数据目录的 `logs/`。启动器不自动迁移旧用户数据。
- 两种模式均先等待 API 与事件两个后端健康检查，再启动网页服务；任一受管子进程失败会关闭其余进程，开发模式 tsx worker 的编译错误则保留 watcher 以供修复。SIGINT/SIGTERM 关闭子进程；POSIX 使用独立进程组清理残余 worker、7 秒后强制结束，Windows 使用 taskkill 清理进程树。启动器回归 `node --test scripts/start.test.mjs` 使用临时源码工程、真实 tsx、模拟 Web 和本机临时端口，不连接真实 SSH/模型；覆盖基础包/后端更新、新文件、错误恢复、退出、残余 worker、子进程失败、生产启动兼容和端口占用。进程信号回归依赖 POSIX，Windows 跳过对应测试，仍需实机验收。
- `.env.example` 仅是参考，启动器不会自动加载 `.env`。内部变量名仍用 SSH_AGENT；不能把秘密放入 NEXT_PUBLIC 变量。
- CLI 入口启动时读取已导出的 HTTP_PROXY/HTTPS_PROXY/NO_PROXY（小写优先），为原生 fetch 及其 SDK 安装环境代理，始终绕过本机 loopback；HTTP/HTTPS 代理 URL 可用，SOCKS ALL_PROXY 不用于 fetch。启动器继承父 Shell 环境，不执行 proxy_on 或读取 Shell 配置。先在同一终端启用代理再启动；已有进程需重启，dist 代码更新需先构建。配置与回归见 `server/environment-proxy.ts` 和 `test/environment-proxy.test.ts`。

安装、迁移与平台验证范围见根 README、[migration.md](../../migration.md) 和 [release-readiness.md](../../release-readiness.md)。

后端包随 `resources/sandbox` 携带 Linux x64/arm64 静态启动器和 musl 版权说明。根 `npm run check` 与后端 build 校验源码/产物摘要、ELF 架构及静态链接；修改 C 源码须以 Zig 0.15.2 重建。常规构建不下载 C 编译器。见 [remote-sandbox.md](./remote-sandbox.md)。
