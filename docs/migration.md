# 从 pi 开发仓库迁移到 Gori

2026-09-11，独立候选工程从 `pi/.artifacts/ssh-agent` 移动到与 pi 同级的 `gori-agent`。后续修改、检查和发布均在本仓库完成；原 pi 代码和 Git 历史保留作备份。

## 保留内容

- 五个必要 workspace：ssh-agent-web、ssh-agent、agent、ai、telemetry。
- 完整 AI 代码路由、源码摘要和检查程序，以及被引用的 frontend/design 文档。
- `agent.md` 为开发约定正文，`AGENTS.md` 为 AI 工具自动发现入口。
- 模型目录数据、安装锁文件、构建启动脚本、三平台 CI、README、许可证、贡献与安全说明、现有静态介绍网站。

没有迁入 coding-agent、tui 等其他产品、原 Git 历史、个人配置、阶段进度报告或真实服务器资料。基础模块中的 pi 名称代表代码来源和内部依赖，不是遗漏的产品改名。

源码对照原仓库提交 `6c266da7f`：除已说明的独立构建配置、类型修正、测试类型修正及 Gori 文案/首页变更外，其余迁入源码一致。依赖 coding-agent 的单个 ai 实时探针未迁入。

## 命名边界

产品名为 Gori（小猩），根 npm 工程名为 `gori-agent`。保留 `packages/ssh-agent*`、`docs/ssh-agent`、内部 `@pi/ssh-agent*` 包名和 `SSH_AGENT_*` 环境变量，使源码引用和文档索引稳定。后端命令名为 `gori-server`；常规用户仍使用根 `npm start`。

首页不再挂载欢迎页或模拟聊天，只保留现有侧边栏。创建工作区与设置从侧边栏进入；真实聊天、SFTP 和终端页面保持原实现。

## 本地数据

代码迁移不等于迁移用户数据。Gori 默认目录为 `~/.gori-agent`，不会自动读取、覆盖或搬走旧 `.ssh-agent` 数据。

若要继续使用旧数据，先停止访问该数据的旧实例并备份整个目录，再通过 `SSH_AGENT_DATA_DIR` 显式指定原目录。数据库、credential-key 与附件必须成套保留，不要单独复制数据库或重新生成密钥。数据库内部格式与名称未在本轮改变。

真实服务器配置和 API 密钥不写入本仓库。`docs/ssh-agent/test-environments.md` 是不含秘密的联调约定；详细私有记录放在忽略目录 `.local/`。

## 后续开发

在 Codex 或编辑器中打开 `gori-agent` 目录。`npm run check` 同时检查 AI 文档摘要、模型目录和 TypeScript 类型。发版不再需要移动 package；发行包与 GitHub Releases 自动化仍是待完成工作。

## 统一运行数据目录

根启动器、直接启动后端和 dev 模式现在默认使用 `~/.gori-agent/`，`SSH_AGENT_DATA_DIR` 可覆盖此目录（支持绝对路径、相对路径和 `~/`）。数据库、保存的密钥、默认 workspace、attachments、logs 均放在其中。相对 DATA_DIR 按启动时工作目录解析；推荐使用绝对路径。显式 DATABASE_PATH/LOCAL_CWD 及已保存的 Session workDir 不会被重写；显式 CREDENTIAL_KEY_BASE64 优先且不自动写入文件，必须继续提供或自行安全备份。

旧数据不会自动搬迁。此前直接启动后端可能使用自定义数据库、环境变量密钥、`~/.ssh-agent/workspace`，附件可能在 `packages/ssh-agent/attachments`，日志在 `packages/ssh-agent/logs`。迁移时：

1. 停止所有访问旧数据的实例，备份数据库、对应密钥、附件和工作目录。
2. 在空的目标数据目录中成套复制数据库（默认文件名 `ssh-agent.sqlite`）、原密钥（文件名 `credential-key`，标准 Base64）、`attachments/` 和需要保留的 `workspace/`；不要覆盖目标已有数据库或密钥。旧日志可另行归档。
3. 设置 `SSH_AGENT_DATA_DIR` 指向目标，再启动并检查凭据解密、会话附件和本地目录。数据库的附件相对路径保持不变，无需修改记录。
4. 已保存的 Workspace defaultCwd、Session workDir 为原路径；移动相关文件后应通过界面更新目录。确认迁移和备份有效前保留旧数据。

只有新数据库才会自动创建密钥；已有数据库缺失密钥时会拒绝启动。不要通过删除数据库或生成新密钥来绕过恢复要求。
