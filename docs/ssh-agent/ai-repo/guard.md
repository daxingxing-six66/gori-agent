# Guard 功能代码路由

适用于 Guard 配置持久化、命令规则字段、规则 ID 所有权、整体 PATCH、预设规则包、revision 冲突和执行期匹配。

## 当前契约

- 每个 Workspace 创建时自动生成一个 Guard，Workspace 删除时由数据库级联删除 Guard。
- 匹配模式为 `contains`、`starts_with`、`regex`；正则表达式由 Service 校验。
- `PATCH` 提交完整 `rules` 数组：未提交的已有规则视为删除。
- 新规则不传 `id`，由后端生成并在响应中返回。
- 编辑已有规则必须携带当前 Guard 中的规则 ID；未知 ID 和重复 ID 返回 `validation_error`。
- 规则响应包含只读的 `source` 和 `level`；内置规则还包含 `originRuleId`、`packId` 和 `packVersion`。普通 PATCH 不能提交这些字段，编辑时由 Service 保留，新增规则写为 `source=user`、`level=critical`。
- 历史持久化规则缺少来源字段时，SQLite 映射层按 `source=user`、`level=critical` 返回。
- 更新使用 `expectedRevision`，成功后 revision 加一。
- `GET /api/workspaces/:workspaceId/guard/rule-packs` 返回后端内置目录及当前 Workspace 的导入数量。
- `POST /api/workspaces/:workspaceId/guard/rule-packs/import` 按全局唯一 `originRuleId` 去重，在一次 Guard revision 更新中追加缺失规则；全部已存在时不写数据库、不增加 revision。
- 内置目录在运行时装配时校验包 ID、全局 origin ID、必填文本、匹配模式和正则表达式；配置错误直接阻止启动，不会部分导入。
- Session 调度器取得进程许可后、获取 SSH Channel 前读取最新 Guard；命中启用规则时 Operation 进入 blocked，Tool 产生终止 Agent Run 的结构化错误。
- Chat 在创建远端 Tool 审批前预检查 Guard，批准后正式执行仍会再次检查；硬阻止命令不会创建审批记录。
- 持久化正则若无法编译会产生 `guard_configuration_invalid`，不会放行命令。
- Guard HTTP 错误和后端固定阻断提示在统一出口按 Locale 投影；规则包文本、用户规则文案、命令和匹配数据属于业务动态内容，不进入后端词典。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| Guard 和更新输入类型 | [guard.ts](../../../packages/ssh-agent/src/domain/guard.ts) |
| 规则包领域契约 | [guard-rule-pack.ts](../../../packages/ssh-agent/src/domain/guard-rule-pack.ts) |
| 内置规则目录与启动校验 | [guard-rule-pack-catalog.ts](../../../packages/ssh-agent/src/application/services/guard-rule-pack-catalog.ts) |
| ID 生成、规则校验和 revision | [guard-service.ts](../../../packages/ssh-agent/src/application/services/guard-service.ts) |
| Repository 接口 | [guard-repository.ts](../../../packages/ssh-agent/src/application/repositories/guard-repository.ts) |
| Workspace 创建默认 Guard | [workspace-service.ts](../../../packages/ssh-agent/src/application/services/workspace-service.ts) |
| HTTP 输入和路由 | [request-validation.ts](../../../packages/ssh-agent/src/api/request-validation.ts)、[http-handler.ts](../../../packages/ssh-agent/src/api/http-handler.ts) |
| SQLite 读写 | [sqlite-guard-repository.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/sqlite-guard-repository.ts)、[rows.ts](../../../packages/ssh-agent/src/infrastructure/sqlite/rows.ts) |
| 运行时 ID 生成器注入 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 契约回归测试 | [management-api.test.ts](../../../packages/ssh-agent/test/management-api.test.ts) |
| 规则包接口与兼容测试 | [guard-rule-pack-api.test.ts](../../../packages/ssh-agent/test/guard-rule-pack-api.test.ts) |
| 执行期 Guard 策略 | [command-guard-evaluator.ts](../../../packages/ssh-agent/src/application/services/command-guard-evaluator.ts) |
| 调度调用和阻断测试 | [command-operation-service.ts](../../../packages/ssh-agent/src/application/services/command-operation-service.ts)、[command-operation-service.test.ts](../../../packages/ssh-agent/test/command-operation-service.test.ts) |

Guard 配置 Service 只维护配置；执行匹配必须留在独立策略组件中，不能塞回配置 Service 或 HTTP handler。
