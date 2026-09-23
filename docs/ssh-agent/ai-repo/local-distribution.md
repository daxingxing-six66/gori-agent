# Gori 本地工程与启动代码路由

适用于独立五模块工程，不套用原 pi 产品的发布脚本。

| 关注点 | 源码入口 |
| --- | --- |
| workspace、检查与命令 | `package.json` |
| 构建依赖顺序、浏览器 API 地址 | `scripts/build.mjs` |
| 初始化、固定密钥、双服务启动与关闭 | `scripts/start.mjs` |
| 统一数据目录、密钥读写与回归 | `packages/ssh-agent/src/data-directory.ts`、`packages/ssh-agent/src/server/credential-key.ts`、`packages/ssh-agent/test/data-directory.test.ts` |
| 无秘密配置参考 | `.env.example` |

- 构建顺序为 telemetry、ai、agent、SSH 后端、浏览器；ai 使用随源码携带的模型目录离线构建。
- 构建前清除旧 `.build-config.json`，完整成功后记录 API 端口。浏览器地址在构建时确定；启动时指定不一致的 `SSH_AGENT_PORT` 会失败。
- 默认网页端口 3000、API 端口 3001；网页端口由 `SSH_AGENT_WEB_PORT` 控制，二者只绑定 loopback。启动前检查端口，不结束其他程序。
- `--setup` 顺序执行忽略依赖生命周期脚本的安装、构建和启动。不创建 GitHub Release。
- 数据默认写入 `~/.gori-agent`，可由 `SSH_AGENT_DATA_DIR` 覆盖。数据库文件仍名为 `ssh-agent.sqlite`，密钥为 `credential-key`。密钥初始化由后端入口统一负责，直接启动与 dev 模式采用相同规则；显式环境密钥优先且不落盘。已有数据库却缺失密钥、或密钥格式无效时拒绝启动。
- 后端 cwd 设为数据目录，本地工作目录设为其 `workspace/`；日志写入数据目录的 `logs/`。启动器不自动迁移旧用户数据。
- 先等待后端健康检查，再启动网页服务；任一子进程失败会关闭另一进程。SIGINT/SIGTERM 关闭子进程，超时后强制结束。
- `.env.example` 仅是参考，启动器不会自动加载 `.env`。内部变量名仍用 SSH_AGENT；不能把秘密放入 NEXT_PUBLIC 变量。

安装、迁移与平台验证范围见根 README、[migration.md](../../migration.md) 和 [release-readiness.md](../../release-readiness.md)。
