# Gori backend

HTTP、SQLite、SSH 与聊天运行时。完整安装步骤见 [根 README](../../README.md)。

使用根目录 `node scripts/start.mjs --setup` 初始化，后续 `npm start`。启动器统一设置数据库、凭据密钥、本地目录和监听地址。

## 代码导航

- `src/domain/`：Workspace、Session、Credential、Guard 等领域类型。
- `src/application/`：聊天、工具、文件传输和生命周期服务。
- `src/infrastructure/`：SQLite 持久化、凭据加密与 ssh2 适配。
- `src/api/`：HTTP 请求解析与响应。
- `src/runtime/create-sqlite-management-backend.ts`：运行时组装。
- `src/server/environment.ts`：直接启动后端时的环境配置。

## 直接启动后端

直接使用 `npm run dev --workspace=@pi/ssh-agent` 时，数据库、credential-key、workspace、attachments 和 logs 默认放在 `~/.gori-agent/`，可通过 `SSH_AGENT_DATA_DIR` 统一更改。首次启动创建密钥，后续复用；已有数据库缺失密钥或密钥格式损坏时拒绝启动。后端不会自动加载 .env 文件。

仍可显式提供 `SSH_AGENT_DATABASE_PATH` 和 `SSH_AGENT_CREDENTIAL_KEY_BASE64`；后者必须是固定的 32 字节随机密钥的标准 Base64 表示。显式密钥优先，不写入 credential-key，使用此方式需自行保管并在后续启动继续提供。

可选配置包括 `SSH_AGENT_HOST`、`SSH_AGENT_PORT`、`SSH_AGENT_EVENTS_PORT`、`SSH_AGENT_LOCAL_CWD`、`SSH_AGENT_CORS_ORIGINS`、`SSH_AGENT_MAX_REQUEST_BODY_BYTES` 和 `SSH_AGENT_MAX_CONCURRENT_OPERATIONS`。以 environment.ts 为准。

同一进程和 Backend 默认监听两个端口：3001 处理普通 `/api/*` 请求，3002 只处理 `GET /api/**/events` SSE 推送；两个端口必须不同，都提供 `GET /healthz`。独立 origin 隔离浏览器的请求与推送连接额度，错误通道返回 404。

当前服务不提供登录认证。生产模式不等于可以公开暴露到互联网；见 [安全说明](../../SECURITY.md)。
