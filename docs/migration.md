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
