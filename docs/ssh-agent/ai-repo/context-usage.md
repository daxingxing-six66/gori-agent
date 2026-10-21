# Context Usage 代码路由

适用于 Session 上下文占用估算、查询、Turn/压缩完成推送和手动压缩响应。

## 边界

- `ChatContextService.usage()` 复用 `estimate().corrected`，只读估算，不请求 Provider、读取图片或触发压缩。
- 含文档的用户消息保存服务端校验产生的 `attachmentKinds`，供同步、无 I/O 估算区分图片和文本。文档只计文件引用/read 提示的文字成本，不读取正文、不增加图片占位；旧图片消息未保存类型提示时保持原估算。实际 Provider 校验继续检查真实附件，不信任类型提示。
- `createChatContext()` 接收已保存的 System Prompt 快照，共用按名称排序的 18 工具定义。所有模式和结束状态均计算同样的 name/description/parameters，不含 label 等执行元数据。
- `ChatRunRuntime.context` 使用活动 Agent 的模型对应 Prompt/Tools，消息由 `ChatContextService.load()` 按持久化 compact 边界恢复。Agent transcript 不会随 Loop Context 替换而删除旧历史，不能直接用完整 transcript 作为占用输入。
- `turn_end` 处理结束后推送一次 `context.updated`。每次自动 `compaction.completed` 后推送已保存的 Context 占用；手动压缩只返回 HTTP 快照。
- 查询接口根据活动 Runtime 或最近 Run 的模型、固定头部快照和有效历史估算。无 Run、模型已移除或旧 Session 尚未初始化头部快照时返回 null；不需要凭证。未消费 Queue 和流式片段不计入。
- 固定头部与工具定义不包含当前模式、目录或任务事实。活动请求、离线查询及手动压缩共用状态格式与投影规则；查询只预览缺失快照，不写入 chat_messages 或 heads。同一离线状态重复查询稳定且不调用模型。状态提示不授予权限，工具执行仍复核后端事实。
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


诊断状态与内置 Skill 通过独立通道加入估算。结束后旧事件仍在历史内，最新 inactive 快照撤销旧指引；压缩保留最新通道版本。报告全文不放入任务元数据或历史卡片，详见 [runtime-context.md](./runtime-context.md)。

状态与 Skill 的文本成本计入当前有效消息；本次保持压缩阈值和工具输出上限，固定工具目录增加的基础占用需和缓存读取一起观测。
