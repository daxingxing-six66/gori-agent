# 工作区草稿连接测试

适用于创建工作区弹窗中的可选 SSH 认证测试。正式连接池与主机信任仍见 [connection-runtime.md](./connection-runtime.md)。

## 行为边界

- `POST /api/workspaces/test-connection` 只接收 `host`、`credential`、可选 `connection`，字段结构与创建工作区相同；不需要工作区 ID、工作区显示名称、环境或默认目录。成功返回 `200 { "success": true }`。
- 地址、连接参数及 Credential 校验与创建逻辑共享。测试额外要求 `connectTimeoutMs` 在 `1..2147483647` 范围，以保证 Node 计时器有效；默认值仍为 `10000 / 15000 / 3`。正式创建的原有校验规则保持兼容。
- `ConnectionTestService` 依赖 `SshConnectionTester` 端口。`Ssh2ConnectionTester` 为每次调用创建独立客户端，以 SSH `ready`（认证成功）为准，不创建 exec、PTY 或 SFTP Channel，不进入连接池、不重试、不写入任何业务或主机信任记录。
- 草稿没有 Host Trust，本次连接临时接受支持算法的服务器主机密钥；成功不等于持久化信任，也不会改变正式连接的首次 TOFU。
- 支持密码、私钥和带口令私钥。解析失败或公钥冒充私钥返回 `invalid_private_key`；认证、拒绝、DNS、不可达、超时、传输丢失按已有 SSH code 本地化，原始 ssh2 异常和凭据不进入响应或日志。
- 一个整体 deadline 覆盖建连、握手与认证；成功、失败、同步异常、提前关闭、取消和 backend close 均释放客户端及 timer。Node HTTP 适配器在请求体读取完成后仍监听响应连接断开，传递 AbortSignal；正常响应结束不误取消请求。
- 前端按钮位于创建弹窗左下角，取消/创建位于右侧并作为一组换行。测试不触发创建表单校验，测试失败或未测试不阻止创建。测试期间禁止重复测试和创建。
- 地址、端口、凭据、连接参数变化，进入凭据配置、关闭或卸载弹窗都会取消测试并清除结果；工作区名称、环境和默认目录变化不清除结果。controller 使用请求序号忽略晚到的成功/失败响应，且不保存草稿凭据。
- 测试后保留内存中的凭据草稿以供重试或创建；创建提交开始清除旧测试结果，创建提交完成仍按原逻辑清空草稿秘密。前端不把秘密保存到 localStorage、日志或 analytics。

## 代码路由

| 关注点 | 入口 |
|---|---|
| 共用连接校验、测试输入类型 | `packages/ssh-agent/src/application/workspace-connection.ts` |
| Credential 共用校验 | `packages/ssh-agent/src/application/credential-factory.ts` |
| 应用服务与测试器端口 | `packages/ssh-agent/src/application/services/connection-test-service.ts` |
| 临时 ssh2 适配器 | `packages/ssh-agent/src/infrastructure/ssh/ssh2-connection-tester.ts` |
| 路由、解析、装配和请求取消 | `packages/ssh-agent/src/api/http-handler.ts`、`packages/ssh-agent/src/api/request-validation.ts`、`packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts`、`packages/ssh-agent/src/server/node-http-server.ts` |
| 弹窗、底部插槽、API | `packages/ssh-agent-web/features/workspace/components/workspace-dialog.tsx`、`packages/ssh-agent-web/components/management-dialog.tsx`、`packages/ssh-agent-web/features/workspace/api/workspace-api.ts` |
| 前端资格校验、状态与取消 | `packages/ssh-agent-web/features/workspace/runtime/connection-test-controller.ts` |
| 回归测试 | `packages/ssh-agent/test/connection-test.test.ts`、`packages/ssh-agent-web/tests/workspace-connection-test.test.tsx` |

接口示例见 [Workspace/Credential 联调](../frontend/workspace-credential-integration.md#211-创建前测试连接)。不引入数据库 migration 或新依赖。
