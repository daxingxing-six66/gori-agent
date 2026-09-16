# Gori 开发指南

Gori（小猩）是一款面向个人开发者的轻量 SSH Agent。用自然语言完成单台 Linux 服务器上的日常操作

本仓库是后续开发的唯一代码源。原 pi 仓库仅作开发历史备份，不需要每次发版复制 package。

## 从哪里开始

1. 阅读 [AI 代码路由](docs/ssh-agent/ai-repo/index.md)，选择当前功能文档。
2. 阅读功能文档指向的真实源码，再判断行为和修改方案。源码优先于文档。
3. 修改映射源码后，完整阅读受影响源码及功能文档；行为、边界或位置变化时修正文档。未变化时明确核对其仍然准确。
4. 只有完成核对后才能执行 `node docs/ssh-agent/ai-repo/check.mjs --update`，随后 `npm run check:ai-repo` 必须通过。不得仅刷新摘要来消除过期错误。
5. 新功能领域需补充聚焦的路由文档、index 入口及 manifest 源码映射。设计文档和历史记录不替代实现。

## 项目边界

- `packages/ssh-agent-web`：Gori 浏览器 UI。
- `packages/ssh-agent`：Gori HTTP、SQLite、SSH、SFTP、会话与终端运行时。
- `packages/agent`、`packages/ai`、`packages/telemetry`：运行必需的 pi 基础模块。
- 内部包名、源码路径和 `SSH_AGENT_*` 环境变量暂保留；产品名为 Gori，仓库名为 gori-agent。不得因字符串包含 pi 而删除必需代码。
- 首页只保留工作区导航。不要擅自新增欢迎页、宣传区或模拟会话。
- 本机支持目标为 macOS/Linux/Windows；远程操作主要面向 Linux。未实测的平台和真实服务调用不得宣称验证通过。

## 开发规则

- 交流简洁，向维护者解释必要的 TypeScript/前端知识，可使用 Java 类比。
- 修改前完整阅读目标文件；不要从搜索片段推断整体行为。
- 不使用不必要的 `any`、内联动态 import；外部 API 类型以已安装依赖为准。
- 根配置覆盖的 TypeScript 使用 erasable syntax，不使用 enum、namespace 或构造函数参数属性。
- 不直接修改 `packages/ai/src/models.generated.ts`；修改生成脚本再重新生成。
- 删除有意保留的功能前需获得维护者确认。不要自动重设计 UI。
- 外部直接依赖固定精确版本。安装使用 `npm ci --ignore-scripts` 或 `npm install --ignore-scripts`。
- 依赖元数据变化后运行 `npm install --package-lock-only --ignore-scripts`，审核锁文件，不绕过生命周期脚本限制。
- 升级 undici 前阅读目标版本变更记录并评估影响。

## 检查与运行

```sh
npm ci --ignore-scripts
npm run check
npm run build
npm start
```

代码修改后必须运行 `npm run check` 并处理错误。构建需在任务已授权构建/运行验收时执行；不要无关地运行完整测试集。

定向前端测试从 `packages/ssh-agent-web` 执行 `node ../../node_modules/vitest/dist/cli.js --run tests/<file>.test.tsx`；后端从 `packages/ssh-agent` 执行相同命令，路径为 `test/<file>.test.ts`。修改测试后必须运行该测试。

不要直接运行整个 pi 基础模块测试集；其中有真实供应商集成测试。没有明确授权时不得使用真实服务器凭据、付费模型或生产数据进行测试。

数据默认为 `~/.gori-agent`，由 `SSH_AGENT_DATA_DIR` 覆盖；数据库名仍为 `ssh-agent.sqlite`。凭据密钥必须与数据库共同备份。旧数据不会自动搬迁，参见 [迁移说明](docs/migration.md)。

## Git 与发布

- 未经要求不要提交、推送、打版本标签或发布。
- 不运行 `git reset --hard`、`git clean -fd`、`git stash`、`git add .`、`git add -A`，不强推，不覆盖其他会话修改。
- 只暂存本次修改的明确路径；提交前检查状态，使用 `feat:`、`fix:`、`docs:` 等清晰提交信息。
- 保留 MIT 许可证与 pi 原作者声明。不继承 pi 产品的 lockstep 发布、贡献者门禁或上游发布凭据。
- 构建和本地启动已自动化，发行包与 GitHub Release 自动化尚未完成；不要声称 `npm run build` 会发布版本。
