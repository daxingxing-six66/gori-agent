# 管理领域代码路由

适用于 Workspace、Session、Credential 的字段、生命周期、Service、Repository 接口以及 Workspace + Session tree 查询。HTTP 传输和 SQLite 实现分别由其他文档路由。

- 工作区创建与草稿连接测试共用 `application/workspace-connection.ts` 的地址/连接参数校验，以及 `credential-factory.ts` 的 Credential 校验。草稿测试不创建任何领域实体，见 [connection-test.md](./connection-test.md)。

## 当前边界

- 新会话首条消息可异步生成标题，使用 Session revision 条件更新避免覆盖手动编辑，成功后通过 Workspace SSE 通知前端。见 [session-title.md](./session-title.md)。

- Workspace 保存服务器静态信息、活动 Credential 引用、默认工作目录和连接参数；普通编辑允许修改 `displayName` 和可选 `defaultCwd`，省略目录时保留旧值；目录沿用创建时的非空及长度校验，SQLite 更新通过 revision 防止覆盖并发修改。创建时 `hostKey` 为 `null`，首次 Tool 调用后从 Workspace 所有的 Host Trust 记录水合。
- Session 固定绑定一个 Workspace；可编辑 `displayName`、本地 `workDir` 和 `autoAudit`。创建时未传 `workDir` 则继承 Workspace `defaultCwd` 并规范化、持久化；显式路径优先。继承与显式工作目录都必须存在且为目录，活动 Chat Run 期间不能修改后两项。
- 单 Session 详情响应会组合 Chat 领域的最近模型选择投影；该字段不是 Session 实体，也不进入 Workspace + Session Tree。
- Session 删除使用进程内 deletion barrier 阻止新的 Chat Run、Command Operation、Attachment upload、Terminal open 和 Session update。活动 Chat Run、Command Operation 或 Attachment upload 阻止删除；仅有 TerminalSession 时由 Terminal Service 先关闭资源再删除。数据库删除成功后只清理该 Session 的附件目录，清理失败记录日志但不回滚已经完成的删除。
- Credential 只能属于一个 Workspace；一个 Workspace 可以有多个 Credential，但通过 `activeCredentialId` 同时只使用一个。认证材料通过独立的 Secret Store 写入，当前提供 Workspace 范围的创建、读取、列表和删除，没有编辑接口。
- Workspace 与首个活动 Credential、Secret 和默认 Guard 在同一事务中创建；新增 Credential 默认不激活，切换活动项使用 Workspace revision。
- 活动 Credential 不能删除；删除无 Session 的 Workspace 会级联删除 Credential、Secret、Host Trust 和 Guard。
- 更新和删除通过 `revision` 实现乐观并发控制。
- 活动 Credential 切换及 Workspace/Credential 删除会通知 SSH Pool 失效相关连接；同一活动 Credential 的幂等切换不会失效连接。
- LLM Provider Credential 是独立的应用级领域，不属于 Workspace Credential；由 [llm-provider.md](./llm-provider.md) 路由。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Workspace、Session、Credential 类型和输入 | [workspace.ts](../../../packages/ssh-agent/src/domain/workspace.ts)、[session.ts](../../../packages/ssh-agent/src/domain/session.ts)、[credential.ts](../../../packages/ssh-agent/src/domain/credential.ts) |
| ID、时钟、ID 生成器 | [ids.ts](../../../packages/ssh-agent/src/domain/ids.ts) |
| Credential 构造和事务抽象 | [credential-factory.ts](../../../packages/ssh-agent/src/application/credential-factory.ts)、[transaction-runner.ts](../../../packages/ssh-agent/src/application/transaction-runner.ts) |
| 领域错误 | [errors.ts](../../../packages/ssh-agent/src/domain/errors.ts) |
| Service 规则 | [workspace-service.ts](../../../packages/ssh-agent/src/application/services/workspace-service.ts)、[session-service.ts](../../../packages/ssh-agent/src/application/services/session-service.ts)、[credential-service.ts](../../../packages/ssh-agent/src/application/services/credential-service.ts) |
| Workspace Host Trust 所有权和首次写入 | [workspace-host-trust-repository.ts](../../../packages/ssh-agent/src/application/repositories/workspace-host-trust-repository.ts)、[workspace-host-trust-service.ts](../../../packages/ssh-agent/src/application/services/workspace-host-trust-service.ts) |
| Repository 抽象 | [repositories](../../../packages/ssh-agent/src/application/repositories/) |
| 管理用例聚合和 tree 查询 | [management-api.ts](../../../packages/ssh-agent/src/application/management-api.ts) |
| 对外响应结构 | [contracts.ts](../../../packages/ssh-agent/src/api/contracts.ts) |
| 主要回归测试 | [management-api.test.ts](../../../packages/ssh-agent/test/management-api.test.ts) |
| Session 生命周期屏障和删除约束 | [session-lifecycle-coordinator.ts](../../../packages/ssh-agent/src/application/services/session-lifecycle-coordinator.ts)、[session-lifecycle-coordinator.test.ts](../../../packages/ssh-agent/test/session-lifecycle-coordinator.test.ts) |
| Session 附件生命周期 | [attachment-service.ts](../../../packages/ssh-agent/src/application/services/attachment-service.ts)、[attachments.md](./attachments.md) |

设计新行为时先修改领域类型和 Service 约束，再扩展 Repository/适配器。不要让 HTTP 或 SQLite 类型反向进入领域层。Credential 的归属必须通过 Workspace 范围接口校验，不能恢复全局 Credential 列表。
