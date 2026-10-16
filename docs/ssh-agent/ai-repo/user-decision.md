# 用户决策工具代码路由

适用于 Agent 主动提问、浏览器回答、等待恢复与 Run 生命周期；不涉及命令授权或远端沙箱安装。

## 行为与状态所有权

- `ask_user_decision` 在普通命令模式和 Terminal Mode 中均可用。模型一次提交非空问题数组，每题必须有问题文本、三个带说明的互斥建议及推荐项索引；总问题 JSON 不超过 64 KiB。自由输入与“跳过”由浏览器提供，建议不预选。
- `ChatUserDecisionService` 独占进程内等待状态；SQLite 保存问题、Session/Run/Tool Call 绑定、答案和终态。回答必须按题序提交，分别为建议索引、自定义非空文本或明确跳过。重复的相同答案幂等，冲突、跨 Session、已取消和重启后的回答拒绝。回答不会生成任何授权凭据，后续命令仍走 Guard 与逐次审批。
- 请求与解决经当前 Run 的 `decision.requested` / `decision.resolved` SSE 事件传给浏览器。关闭输入框上方的决策面板或刷新页面不结束等待；`GET /api/sessions/:id/chat/decisions` 恢复当前待决项，输入框上方的入口可重新打开。取消 Run 中止等待；后端重启把待决项标记为 `interrupted`，现有 Run 恢复逻辑终止不能跨进程继续的 Run。等待没有定时超时。
- 等待决策时主动取消 Run，同时取消尚未消费的 steer/follow-up；这些队列内容不进入正式聊天历史，也不再调用模型。取消信号后的 Adapter 错误不把 Run 改判为 failed。
- 浏览器边界由 `isUserDecision` 验证 REST 和 SSE 数据；`ChatRuntimeState` 保存待决投影，输入框上方的面板仅持有当前未提交的本地草稿。面板贴着 Composer 向上展开，不遮蔽整页、锁定背景滚动或圈禁焦点；窄屏时选项区可滚动。关闭面板保留本页草稿且不回答，刷新后从未回答状态重新开始。三条建议与自由输入均不预选；选择建议或跳过后自动进入下一题，用户仍可返回修改。自由输入展开独立编辑区，非空文本经箭头或 Enter（Shift+Enter 换行）进入下一题；最后一题完成后才显示提交按钮。进度以步骤点或细进度条呈现，图标按钮保留名称、提示和键盘焦点，选项说明保持完整可读。选项、焦点与状态样式使用主题语义色。

## 入口

| 关注点 | 源码 |
|---|---|
| 契约和输入上限 | `packages/ssh-agent/src/domain/user-decision.ts`、`packages/ssh-agent/src/application/tools/ask-user-decision-tool.ts` |
| 等待、回答与 SSE | `packages/ssh-agent/src/application/services/chat-user-decision-service.ts`、`packages/ssh-agent/src/application/services/create-chat-service.ts` |
| Tool 装配和授权分类 | `packages/ssh-agent/src/application/services/chat-agent-runtime-factory.ts`、`packages/ssh-agent/src/application/services/chat-tool-authorization-policy.ts`、`packages/ssh-agent/src/application/chat-context.ts` |
| 持久化及重启收敛 | `packages/ssh-agent/src/application/repositories/chat-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/sqlite-chat-repository.ts`、`packages/ssh-agent/src/infrastructure/sqlite/migrations.ts` |
| REST 和前端协议 | `packages/ssh-agent/src/api/http-handler.ts`、`packages/ssh-agent-web/features/chat/api/chat-api.ts`、`packages/ssh-agent-web/features/chat/runtime/chat-event-stream.ts`、`packages/ssh-agent-web/features/chat/model/user-decision.ts` |
| 页面交互 | `packages/ssh-agent-web/features/chat/components/user-decision-panel.tsx`、`packages/ssh-agent-web/features/chat/components/chat-composer-panel.tsx`、`packages/ssh-agent-web/features/chat/components/chat-console.tsx`、`packages/ssh-agent-web/app/globals.css`、`packages/ssh-agent-web/features/chat/runtime/use-chat-runtime.ts` |
| 回归 | `packages/ssh-agent/test/chat-user-decision.test.ts`、`packages/ssh-agent/test/chat-user-decision-api.test.ts`、`packages/ssh-agent-web/tests/chat-runtime-state.test.ts`、`packages/ssh-agent-web/tests/chat-ui-hierarchy.test.tsx` |

`ChatService` 只协调 Run 取消和公开用例，不持有决策等待；`ChatUserDecisionService` 不接管审批或命令执行。新增决策功能应保持这一边界。
