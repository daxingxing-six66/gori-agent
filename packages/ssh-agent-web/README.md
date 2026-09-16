# Gori web

React / Vinext 浏览器界面。完整安装步骤见 [根 README](../../README.md)。

## 功能与代码

- `app/`：页面、语言恢复、主题和全局样式。
- `features/`：聊天、Workspace、Guard、模型配置、SFTP、终端与设置。
- `components/`：共享界面组件。
- `shared/`：API 和错误适配。
- `tests/`：前端测试。

HTTP 和 SSE 连接后端，终端通过 snapshot/SSE 展示 AI 交互，不提供人工终端键盘输入。浏览器不直接建立 SSH 连接。

## 开发

在独立仓库安装依赖后，运行 `npm run dev --workspace=@pi/ssh-agent-web`。同时运行后端。

开发模式默认请求 `http://127.0.0.1:3001`；默认生产配置使用同源路径。根构建脚本为本机发行方式显式设置 `NEXT_PUBLIC_SSH_AGENT_API_BASE_URL=http://127.0.0.1:3001`。

`NEXT_PUBLIC_` 变量会暴露给浏览器，不应包含密码或 API Key。服务端凭据通过后端管理接口保存。

独立仓库使用 Vinext 的本地 Node 运行方式，不依赖原开发环境的 Sites/Cloudflare 预览配置。
