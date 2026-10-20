# REST 与事件推送传输隔离

适用于历史、模型等普通请求被 SSE 占满浏览器 HTTP/1.1 连接额度后排队的问题。连接额度由浏览器按 origin 管理；只创建两个客户端对象、修改 URL 路径或减少部分订阅，不能隔离两类流量。

## 入口与职责

| 职责 | 入口 |
|---|---|
| 两个监听器、通道准入和共同关闭 | `packages/ssh-agent/src/server/management-http-transport.ts` |
| 唯一后端与数据库所有权、启动失败回滚 | `packages/ssh-agent/src/server/ssh-agent-server.ts` |
| Node HTTP、CORS、响应流和连接释放 | `packages/ssh-agent/src/server/node-http-server.ts` |
| 端口配置与 CLI 地址输出 | `packages/ssh-agent/src/server/environment.ts`、`main.ts` |
| 构建/启动共享端口校验与浏览器环境 | `scripts/transport-config.mjs`、`build.mjs`、`start.mjs` |
| 普通 JSON/上传请求 | `packages/ssh-agent-web/shared/api/client.ts` |
| 独立事件地址与 Locale 查询参数 | `packages/ssh-agent-web/shared/events/client.ts` |
| 同页 Workspace topic 订阅与连接复用 | `packages/ssh-agent-web/shared/events/workspace-events.ts` |

- 同一进程创建一个 Backend、一组 Services/EventHub 和一份数据库所有权，向两个 HTTP 监听器注入同一个请求处理器。默认 API `127.0.0.1:3001`，事件推送 `127.0.0.1:3002`；没有第二个业务服务或数据库连接池。
- `ManagementHttpTransport` 按请求方法和路径隔离流量：`GET /api/**/events` 只进入事件监听器，其余业务 API 只进入请求监听器；错误通道返回 404。两个监听器都提供 `/healthz`，并沿用同一 CORS allowlist、Locale、body limit 与流式适配。
- Chat、Terminal、Workspace（标题、SFTP、监控、Deploy、Diagnose）及全局会话活动流统一使用 `shared/events/client.ts`；业务适配器继续持有协议校验、重连和取消。HTTP 通道不解析业务事件，也不合并业务 topic 或接管业务生命周期。
- 同一浏览器页面的 Workspace 订阅按 Workspace + Locale 复用一条 EventSource，底层请求为当前消费者 topics 的并集。订阅变更在同一 microtask 合并；topic 并集变化时关闭旧流再建立新流，各功能按 stream.ready 补读自己的事实。相同 topics 的迟到消费者可收到已有 ready；旧流和已取消消费者不再接收回调，单个消费者异常不会阻断其他功能。最后一个消费者离开才关闭连接；监控消费者离开时移除 monitoring topic，不为复用连接继续保留采集订阅。
- `SSH_AGENT_PORT` 与 `SSH_AGENT_EVENTS_PORT` 必须不同；程序化测试允许两者均为 0，由系统分配不同空闲端口。`listen()` 保留原 API 地址字段，并在 `events` 返回事件地址。
- 任一监听绑定失败，Server 关闭两个监听、唯一 Backend 并释放数据库所有权。正常关闭先停止两侧接受连接，业务关闭结束流后等待 HTTP drain；结束的 SSE 即使声明 keep-alive，也会在关闭期间释放新空闲连接。客户端断开只取消订阅，不取消 Agent。

## 构建和部署

- 前端分别使用 `NEXT_PUBLIC_SSH_AGENT_API_BASE_URL` 与 `NEXT_PUBLIC_SSH_AGENT_EVENTS_BASE_URL`。事件地址缺省为 `http://127.0.0.1:3002`，生产模式也不退回 REST 同源路径。
- 根构建记录两个端口到 `.build-config.json` 并注入浏览器地址。启动验证网页/API/事件三个端口互异、环境与构建一致、端口可用，并等待两个后端健康检查再启动 Web；旧构建缺少事件端口时明确要求重新构建。
- 独立启动开发服务时，默认端口直接可用；变更后端端口时同步设置两种 `NEXT_PUBLIC_*` 地址。反向代理部署必须给 REST 与事件不同 origin（例如不同端口）；仅按路径转发到同一个 HTTP/1.1 origin 会再次共享连接额度。跨域推送沿用后端 CORS 配置。
- 该隔离保证长连接不占 REST 额度。Workspace 复用让同页 Chat + Terminal + 全局活动 + Workspace 使用 4 条长连接，避免加入 Diagnose 后各功能独立常驻导致超过 HTTP/1.1 的 6 条连接额度、Terminal 等待 ready 或 Chat 事件排队。事件 origin 仍受浏览器上限约束；不同浏览器标签页之间不共享本页连接池。

## 验证

- `packages/ssh-agent/test/transport-channels.test.ts`：真实 TCP、每 origin 最多 6 条连接的 HTTP Agent，保持 6 条 SSE 时历史/模型请求正常完成；通道准入、CORS、健康检查、开放订阅时关闭与第二监听失败回滚。
- `packages/ssh-agent/test/http-server.test.ts`：两个端口的绑定失败均释放跨进程数据库所有权，保留原 API/CORS/上传检查。
- `packages/ssh-agent/test/server-environment.test.ts`：双端口缺省、独立配置、冲突与非法值。
- `packages/ssh-agent-web/tests/transport-channels.test.ts`：包含 Diagnose 的七种事件适配器均使用事件 origin，同一 Workspace 合并后共 4 条连接；Locale/cursor/topic 保留，普通请求仍走 API，清理只移除各自订阅。
- `packages/ssh-agent-web/tests/workspace-events.test.ts`：topic 并集、消费者增减、重配旧流拒绝、迟到 ready、Workspace/Locale 隔离、零消费者清理及异常消费者隔离。

测试只使用内存/临时 SQLite、faux 模型与本机临时 TCP 端口，不请求真实模型或 SSH。

Diagnose 的 diagnoses topic 使用同一 Workspace 连接，适配器位于 features/diagnose/runtime/diagnose-event-stream.ts，业务校验与重连补齐归 Diagnose Hook。Terminal 独立 attachment SSE 和 Chat 独立 Run SSE 的协议、ready 门禁及重放规则不变。
