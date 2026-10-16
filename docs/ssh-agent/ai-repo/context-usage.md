# Context Usage 代码路由

适用于 Session 上下文占用估算、查询、Turn/压缩完成推送和手动压缩响应。

## 边界

- `ChatContextService.usage()` 复用 `estimate().corrected`，只读估算，不请求 Provider、读取图片或触发压缩。
- `createChatContext()` 接收已保存的 System Prompt 快照，共用普通工具的静态定义；离线查询和手动压缩读取当前部署模式，仅在活动模式中加入对应讨论、待审或执行工具及结束工具，结束后不再计算部署定义。工具估算只保留 Provider 的 name/description/parameters，避免 label 等执行元数据影响结果。
- `ChatRunRuntime.context` 使用活动 Agent 的模型对应 Prompt/Tools，消息由 `ChatContextService.load()` 按持久化 compact 边界恢复。Agent transcript 不会随 Loop Context 替换而删除旧历史，不能直接用完整 transcript 作为占用输入。
- `turn_end` 处理结束后推送一次 `context.updated`。每次自动 `compaction.completed` 后推送已保存的 Context 占用；手动压缩只返回 HTTP 快照。
- 查询接口根据活动 Runtime 或最近 Run 的模型、固定头部快照和有效历史估算。无 Run、模型已移除或旧 Session 尚未初始化头部快照时返回 null；不需要凭证。未消费 Queue 和流式片段不计入。
- 活动 Runtime 的 Prompt/Tools 包含当前可信 Session 沙盒和部署指引与描述；离线查询使用基础快照及当前模式的工具估算，不把历史沙盒指令当作当前权限，也不承诺与活动 Run 临时片段逐字相同。同一离线状态重复查询应稳定，且不调用模型。
- 不保存占用快照；头部复用独立的 `chat_prompt_snapshots`。校准系数沿用进程内生命周期，重启可能产生估算差异。

## 代码位置

| 关注点 | 入口 |
|---|---|
| 公共快照类型 | `packages/ssh-agent/src/domain/chat-context-usage.ts` |
| 共用 Prompt 和工具定义 | `packages/ssh-agent/src/application/chat-context.ts`、`packages/ssh-agent/src/application/tools/` |
| 估算和压缩事件 | `packages/ssh-agent/src/application/services/chat-context-service.ts` |
| Turn 订阅和活动快照 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`、`packages/ssh-agent/src/application/chat-run-runtime.ts` |
| 查询及手动响应 | `packages/ssh-agent/src/application/services/chat-service.ts`、`packages/ssh-agent/src/api/http-handler.ts` |
| 最近 Run | `packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts` |
| 回归 | `packages/ssh-agent/test/chat-context-service.test.ts`、`packages/ssh-agent/test/context-compaction-runtime.test.ts` |

前端契约见 [context-usage-integration.md](../frontend/context-usage-integration.md)。
