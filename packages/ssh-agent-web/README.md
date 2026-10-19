# Gori web

React / Vinext 浏览器界面。完整安装步骤见 [根 README](../../README.md)。

## 功能与代码

- `app/`：页面、语言恢复、主题和全局样式。
- `features/`：聊天、Workspace、Guard、模型配置、SFTP、终端与设置。
- `components/`：共享界面组件。
- `shared/`：独立 API/事件客户端和错误适配。
- `tests/`：前端测试。

HTTP 和 SSE 连接后端，终端通过 snapshot/SSE 展示 AI 交互，不提供人工终端键盘输入。浏览器不直接建立 SSH 连接。

## 开发

在独立仓库安装依赖后，运行 `npm run dev --workspace=@pi/ssh-agent-web`。同时运行后端。

开发模式普通请求默认使用 `http://127.0.0.1:3001`，独立生产构建未配置 API 时使用同源路径；事件在两种模式下均默认使用 `http://127.0.0.1:3002`。根构建脚本为本机发行方式显式设置 `NEXT_PUBLIC_SSH_AGENT_API_BASE_URL` 与 `NEXT_PUBLIC_SSH_AGENT_EVENTS_BASE_URL`，分别匹配后端 API/事件端口。

变更后端端口时同步配置这两个地址；反向代理部署也需使用不同 origin，以隔离 HTTP/1.1 连接额度。所有 SSE 适配器经 `shared/events/client.ts` 生成地址，普通 JSON/上传请求经 `shared/api/client.ts`。

`NEXT_PUBLIC_` 变量会暴露给浏览器，不应包含密码或 API Key。服务端凭据通过后端管理接口保存。

独立仓库使用 Vinext 的本地 Node 运行方式，不依赖原开发环境的 Sites/Cloudflare 预览配置。
