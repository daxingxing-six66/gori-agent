# 新会话自动标题

适用于新会话首条消息的模型命名、标题持久化和 Workspace SSE 标题更新。

## 触发和边界

- 新会话前端使用本地化的“新会话”作为占位标题；首次 `POST /api/sessions/:sessionId/chat/runs` 携带可选布尔值 `generateTitle: true`。旧客户端及显式命名调用不传该字段时保持原行为。
- `ChatService.createRun` 在插入 Run 前判断是否为该 Session 的首个 Run，Runtime 创建成功并启动正常聊天后才调度标题任务。HTTP 幂等重试直接返回原 Run；后续 Run 即便带该字段也不重复生成。启动失败、进程重启或标题失败不自动补跑。
- `SessionTitleService` 独立调用同一 Models 实例的 `completeSimple`，使用首次 Run 已选定的 Model 及现有认证；OpenCode Go 沿用 Session Header helper。它不使用 Agent 工具、不请求远端 SSH、不写聊天消息或 Agent Context，也不阻塞 Run 响应和聊天完成。
- 输入仅取首条消息文本前 8000 个 UTF-16 code units，不读取文件内容或图片；纯图片无文本时保留占位标题。Prompt 要求使用用户语言生成不超过 30 字符的单行标题。只接受 stop 终态的文本，清理首尾引号后拒绝空白、控制字符、多行或超过 Session 120 字符限制的结果。
- 单次请求最多等待 30 秒，并向 Provider 传递 AbortSignal。服务关闭中止并等待标题任务；Provider 不响应取消时仍结束本地等待，迟到结果不再写库。生成失败仅记录本地诊断、保留占位标题，不改变 Chat Run 状态。
- 不新增 migration。仅对创建时 revision=1 的会话执行，以原 revision 进行条件更新。用户提前或生成期间改名、修改设置、删除会话都会使自动更新跳过，避免覆盖用户操作。

## SSE 扩展

- 复用 `GET /api/workspaces/:workspaceId/events`，新增可选 `sessions` topic 和一个 `session.updated` 事件。原默认 topics、事件封装、订阅分发、心跳、Locale 和 EventSource 重连机制保持不变。
- 成功保存标题后才发布：`{ id, workspaceId, displayName, revision, updatedAt }`。标题属于模型输出，原文推送，不作词典翻译。
- `WorkspaceTreeProvider` 按当前 Workspace/Session 路由订阅对应工作区的 sessions topic，跨同工作区页面保留连接，不为全部工作区创建连接。更新共享树数据后，侧边栏及 Chat 页顶部读取同一标题。
- 每次 stream.ready（包括首次连接）读取 Workspace tree，补齐订阅建立前或断线期间的标题更新；切换到其他工作区也会同步。该事件不增加持久化重放能力。
- 前端校验事件，按 workspaceId、sessionId 和 revision 应用更新；延迟的 tree HTTP 响应不能覆盖更高 revision 的会话。已删除的条目不因旧 SSE 重新插入。

## 代码位置

| 关注点 | 入口 |
|---|---|
| 首次 Run 触发和服务关闭 | `packages/ssh-agent/src/application/services/chat-service.ts` |
| 模型命名、超时和条件写入 | `packages/ssh-agent/src/application/services/session-title-service.ts` |
| Models 和事件依赖装配 | `packages/ssh-agent/src/application/services/create-chat-service.ts`、`packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts` |
| Run 参数及 SSE topic 校验 | `packages/ssh-agent/src/api/request-validation.ts`、`packages/ssh-agent/src/api/http-handler.ts` |
| Workspace SSE 事件扩展 | `packages/ssh-agent/src/application/workspace-event-hub.ts` |
| 前端创建占位标题和启用自动命名 | `packages/ssh-agent-web/features/session/components/new-session-chat.tsx`、`packages/ssh-agent-web/features/chat/api/chat-api.ts` |
| 前端现有 SSE hook | `packages/ssh-agent-web/features/sftp/components/use-workspace-events.ts` |
| 当前工作区订阅、树刷新和归约 | `packages/ssh-agent-web/features/workspace/components/workspace-session-events.tsx`、`packages/ssh-agent-web/features/workspace/components/workspace-tree-provider.tsx`、`packages/ssh-agent-web/features/workspace/model/session-update.ts` |
| 定向回归 | `packages/ssh-agent/test/session-title.test.ts`、`packages/ssh-agent-web/tests/session-title.test.tsx` |
