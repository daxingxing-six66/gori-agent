# Gori Web 前端代码路由

本文只索引 `packages/ssh-agent-web/`。目标是把前端功能修改快速路由到源码，不记录当前实现步骤、接口字段全集或后端行为；涉及服务端契约时，应另行查阅对应后端功能文档和源码。

创建工作区弹窗底部左侧提供可选“测试连接”，测试当前草稿，无需工作区名称或有效默认目录；结果复用 NoticeCard，在操作栏上方显示。ManagementDialog 增加可选 footerLeading/footerNotice 插槽，取消和创建保持右侧一组。测试期间禁用重复测试与创建，编辑连接字段、进入凭据配置或关闭时取消并清除结果；请求序号避免旧结果回写。实现、契约与测试见 [connection-test.md](./connection-test.md)。

侧边栏的工作区展开状态由根布局中的 `WorkspaceTreeProvider` 按工作区 ID 独立保存，切换工作区或会话页面不会收起其他工作区。首次进入尚无展开记录的工作区时默认展开；手动收起（包括当前工作区）会保留到本次页面生命周期结束，刷新浏览器后重新初始化。

创建工作区的默认工作目录通过 `LocalDirectoryPicker` 选择，复用新建聊天的 `GET /api/local-files` 本机目录浏览、筛选及面包屑。打开选择器时暂时卸载外层管理弹窗，取消/Escape 只返回草稿，确认后回填 `defaultCwd`；其余表单和连接测试结果保留。

新会话先使用本地化占位标题，首条消息成功启动后由同模型异步命名；WorkspaceTreeProvider 订阅当前工作区的 session.updated 更新侧边栏和页面标题，首次连接及重连均刷新持久化数据。见 [session-title.md](./session-title.md)。

Chat 协议接受 runtime system 消息，状态按 `runtimeEventId` 保留同毫秒内的不同切换。时间线不把模式协议显示为 Assistant 气泡，也不因仅有模式记录而隐藏空会话提示。回归见 `tests/chat-system-messages.test.tsx`。


工作区创建/编辑表单区分“默认本地工作目录”与“默认远端工作目录”：本地沿用 LocalDirectoryPicker，远端为绝对路径输入框，默认 `/`。概览分别显示二者；WorkspaceConsole 只将 `remoteDefaultCwd ?? "/"` 传给 SFTP 页，新会话仍继承 `defaultCwd`。

## 使用顺序

1. 先从“页面与总装配”确定功能出现在哪个页面。
2. 再从“功能路由”打开该功能的组件、运行时或状态入口。
3. API 请求改动同时检查该 feature 的 `api/`、`model/` 和对应测试。
4. 样式问题最后按组件类名定位 `app/globals.css`，不要从全局样式反推功能边界。

## 页面与总装配

| 页面或壳层 | 首要入口 | 继续追踪 |
|---|---|---|
| 全局 Theme/Settings/Provider 装配、元数据、全局样式 | `app/layout.tsx` | `features/theme/components/theme-provider.tsx`、`features/settings/components/settings-provider.tsx`、`features/llm-provider/components/llm-provider-provider.tsx`、`features/workspace/components/workspace-tree-provider.tsx`、`app/globals.css` |
| `/` 工作区导航壳层 | `app/page.tsx` | 仅装配 `components/workspace-sidebar.tsx`；无欢迎区、无演示会话，真实功能从侧边栏进入 |
| `/workspaces/:workspaceId` Workspace 控制台 | `app/workspaces/[workspaceId]/page.tsx` | `components/workspace-console.tsx`；在这里装配 Overview、Guard、Credential、SFTP Files 四个页签 |
| `/workspaces/:workspaceId/chat/new` 新会话 | `app/workspaces/[workspaceId]/chat/new/page.tsx` | `features/session/components/new-session-chat.tsx` |
| `/sessions/:sessionId` 真实会话 | `app/sessions/[sessionId]/page.tsx` | `features/chat/components/chat-console.tsx`；Terminal 也由该组件装配 |
| 全局 Workspace/Session 导航与管理入口 | `components/workspace-sidebar.tsx` | Workspace 创建、Session 重命名/删除、设置弹窗均从这里进入 |
| 全局设置总入口 | `components/settings-dialog.tsx` | 外观、上下文压缩、Provider Credential 和自定义 Provider 的分类与多视图流程 |

## 功能路由

| 要修改的前端功能 | 首要文件 | 状态、协议和辅助文件 | 对应测试 |
|---|---|---|---|
| Workspace/Session 树加载与全局刷新 | `features/workspace/components/workspace-tree-provider.tsx` | `workspace-tree-context.ts`、`features/workspace/api/workspace-api.ts`、`features/workspace/model/workspace.ts` | `tests/api-clients.test.ts` |
| Workspace 创建、重命名、删除 | `features/workspace/components/workspace-dialog.tsx`、`components/workspace-console.tsx` | `features/workspace/components/name-dialog.tsx`、`features/workspace/api/workspace-api.ts`；创建时复用 Credential 表单与 SFTP 绝对路径校验 | `tests/api-clients.test.ts`、`tests/sftp-state.test.ts` |
| SSH Credential 创建、列表、切换、删除 | `features/credential/components/credential-manager.tsx` | `credential-dialog.tsx`、`api/credential-api.ts`、`model/credential.ts` | `tests/api-clients.test.ts` |
| Session 创建、首次发送前选择工作目录、命名、自动审批、重命名和删除 | `features/session/components/new-session-chat.tsx`、`components/workspace-sidebar.tsx` | `session-dialog.tsx`、`session-delete-dialog.tsx`、`local-directory-picker.tsx`、`api/session-api.ts`、`model/session.ts`、`features/workspace/model/session-update.ts` | `tests/session-title.test.tsx`、`tests/session-directory-picker.test.tsx`、`tests/api-clients.test.ts` |
| Guard 规则编辑、开关、创建和删除 | `features/guard/components/guard-editor.tsx` | `guard-rule-dialog.tsx`、`guard-rule-switch.tsx`、`model/guard.ts`、`model/guard-editor-state.ts` | `tests/guard-editor-state.test.ts` |
| Guard 自动保存、冲突恢复和 optimistic 开关回滚 | `features/guard/components/use-guard-autosave.ts` | `api/guard-api.ts`、`model/guard-editor-state.ts` | `tests/guard-editor-state.test.ts`、`tests/api-clients.test.ts` |
| Guard 规则包浏览和导入 | `features/guard/components/guard-rule-pack-dialog.tsx` | `model/guard-rule-pack-state.ts`、`api/guard-api.ts` | `tests/guard-rule-pack-state.test.tsx` |
| Provider 全局目录状态 | `features/llm-provider/components/llm-provider-provider.tsx` | `llm-provider-context.ts`、`api/llm-provider-api.ts` | `tests/llm-provider-state.test.ts`、`tests/api-clients.test.ts` |
| 自动上下文压缩全局设置 | `features/context-compaction/components/context-compaction-settings.tsx` | `api/context-compaction-settings-api.ts`、`model/context-compaction-settings.ts`、`features/llm-provider/components/model-selector.tsx` | `tests/context-compaction-settings.test.ts`、`tests/api-clients.test.ts` |
| 明亮、暗部、跟随系统主题和设置分类 | `features/theme/components/theme-provider.tsx` | `features/settings/`、`features/theme/model/theme.ts`、`app/layout.tsx`、`app/globals.css` | `tests/theme-state.test.tsx` |
| Provider Credential 配置、轮换和删除 | `components/settings-dialog.tsx` | `features/llm-provider/api/llm-provider-api.ts`、`model/llm-provider.ts` | `tests/llm-provider-state.test.ts`、`tests/api-clients.test.ts` |
| 自定义 Provider、静态模型目录和浏览器模型发现 | `features/llm-provider/components/custom-provider-editor.tsx` | `model/custom-provider-model-discovery.ts`、`api/llm-provider-api.ts`、`model/llm-provider.ts` | `tests/custom-provider-model-discovery.test.ts`、`tests/api-clients.test.ts` |
| 模型和 Thinking 等级选择 | `features/llm-provider/components/model-thinking-selector.tsx` | `model-selector.tsx`、`thinking-level-selector.tsx`、`thinking-level-slider.tsx`、`model/llm-provider.ts` | `tests/llm-provider-state.test.ts` |
| Chat 页面总装配、输入、发送、停止、队列、自动审批、手动上下文压缩、图片附件上传和消息滚动 | `features/chat/components/chat-console.tsx` | `chat-token-editor.tsx` 从拖拽与剪贴板的 FileList/ClipboardItem 接收图片；`chat-composer-panel.tsx` 以缩略图网格呈现本地预处理及上传状态，并保存成功图片的 Attachment 投影，经 `use-chat-runtime.ts`、`api/chat-api.ts` 随新 Run 与 Queue 请求提交 ID。`chat-message.tsx` 使用消息响应的受控 `contentUrl` 回显 JPEG、PNG、WebP：历史附件在文字气泡上方独立展示，使用时间线 50% 宽度的右对齐单行横向轨道，缩略图不足一行时在轨道内右对齐，超出时横向滚动；文字气泡随内容收缩，最大宽度为时间线的 78%；`chat-image-preview-dialog.tsx` 为输入区和历史图片共用全屏预览、元数据与多图切换，不读取 `storagePath`。其余入口包括 `chat-timeline.tsx`、`chat-markdown.tsx`、`chat-reference.tsx`、`model/chat-scroll.ts`、`features/session/api/session-attachment-api.ts`。附件契约见 `docs/ssh-agent/frontend/chat-image-attachment-integration.md` | `tests/chat-token-editor.test.ts`、`tests/chat-composer-menu.test.ts`、`tests/chat-composer.test.ts`、`tests/chat-runtime-state.test.ts`、`tests/api-clients.test.ts` |
| Chat REST 请求、刷新恢复、Run/Queue/Approval/Compaction 状态和 SSE | `features/chat/runtime/use-chat-runtime.ts` | `api/chat-api.ts`、`runtime/chat-event-stream.ts`、`model/chat-runtime-state.ts`、`model/chat.ts` | `tests/chat-runtime-state.test.ts`、`tests/api-clients.test.ts` |
| Chat 模型选择恢复和失效处理 | `features/chat/runtime/use-chat-model-selection.ts` | `model/chat-model-selection-restore.ts`、`features/llm-provider/api/llm-provider-api.ts`、`features/session/api/session-api.ts` | `tests/chat-model-selection-restore.test.ts` |
| Chat 编辑器中的 `/`/`@` Composer Menu、Terminal/上下文压缩工具、本地文件引用、目录浏览和搜索 | `features/chat/components/chat-token-editor.tsx` | `model/chat-composer-menu.ts`、`api/local-files-api.ts`、`model/chat-composer.ts`、`chat-reference.tsx`、`app/globals.css` | `tests/chat-composer-menu.test.ts`、`tests/chat-composer.test.ts`、`tests/session-directory-picker.test.tsx` |
| SFTP 目录浏览、筛选、下载和删除 | `features/sftp/components/sftp-files-tab.tsx` | `use-sftp-directory.ts`、`sftp-directory-entries.tsx`、`sftp-delete-dialog.tsx`、`api/sftp-api.ts` | `tests/sftp-api.test.ts`、`tests/sftp-state.test.ts` |
| SFTP 上传、覆盖确认、取消、重试和离开页面保护 | `features/sftp/components/sftp-transfer-provider.tsx` | `sftp-transfer-queue.tsx`、`model/sftp-state.ts`、`model/sftp.ts`、`api/sftp-api.ts` | `tests/sftp-api.test.ts`、`tests/sftp-state.test.ts` |
| Workspace SSE、服务器指标和 Connection Pool 快照 | `features/sftp/components/realtime-overview-tab.tsx` | `use-workspace-events.ts`、`model/sftp-state.ts`、`model/sftp.ts` | `tests/sftp-state.test.ts` |
| Terminal Mode 的 Composer 工具入口、状态标识、开关、禁用原因、过渡和状态轮询 | `features/chat/components/chat-console.tsx` | `features/chat/components/chat-token-editor.tsx`、`features/chat/model/chat-composer-menu.ts`、`features/session/components/new-session-chat.tsx`、`features/terminal/runtime/use-terminal-mode.ts`、`features/terminal/api/terminal-api.ts`、`features/terminal/components/terminal-connection-state.tsx`、`features/terminal/model/terminal-ui-defaults.ts` | `tests/chat-composer-menu.test.ts`、`tests/terminal-client.test.ts` |
| 只读 xterm、主题动态配色、snapshot/replay/live 切换、focus ownership 和 resize | `features/terminal/components/terminal-panel.tsx` | `model/terminal-theme.ts`、`runtime/terminal-event-stream.ts`、`model/terminal.ts`、`api/terminal-api.ts` | `tests/terminal-client.test.ts`、`tests/terminal-theme.test.ts` |
| Terminal Observation 遮罩、范围投影和恢复 | `features/terminal/components/terminal-observation-mask.tsx` | `model/terminal-observation-mask.ts`、`model/terminal-observation-range.ts`、`runtime/terminal-observation-range-tracker.ts` | `tests/terminal-observation-mask.test.ts`、`tests/terminal-observation-range.test.ts` |
| Terminal 审计时间线 | `features/terminal/components/terminal-timeline.tsx` | `api/terminal-api.ts`、`model/terminal.ts` | `tests/terminal-client.test.ts` |
| 所有后端 API 的基地址、JSON 请求和错误解析 | `shared/api/client.ts` | `shared/errors/api-error.ts`；文件上传例外在 `features/sftp/api/sftp-api.ts` 使用 XHR | `tests/api-clients.test.ts`、`tests/sftp-api.test.ts` |
| 通用管理弹窗、Select、Switch | `components/management-dialog.tsx`、`components/custom-select.tsx`、`components/toggle-switch.tsx` | 使用方通常位于具体 feature 的 `components/` | 以各功能测试为主 |
| 页面布局、颜色、Terminal/弹窗/编辑器样式 | `app/globals.css` | 先从具体组件 className 反查；不要在此文件判断业务状态归属 | 无独立样式测试 |

## 目录职责

运行期间普通发送进入 follow_up。输入区 `chat-composer-panel.tsx` 的 `QueuePreview` 在 pending follow_up 行右侧提供回车图标，通过 `use-chat-runtime.ts` 调用 `chat-api.ts` 的原项转换接口，不重新发送消息；取消操作保留。队列区域按条数自然增高，最多完整显示四行（每行 36px，间距 4px），超过四条后纵向滚动。请求期间锁定队列操作，失败刷新队列；状态归约防止延迟响应恢复已消费项目。回归见 `tests/chat-queue-promotion.test.tsx`。

Chat 错误展示复用 `features/chat/components/chat-failure-details.tsx`，消息历史和当前 Run 都保留 errorId 与 recovery。`chat-timeline.tsx` 按同一 errorId 隐藏重复错误提示但保留文本/工具内容。`chat-event-stream.ts` 接受无 tokensBefore 的 compaction.failed，已知协议解析失败、stream.resync 和 run.persistence_failed 触发 `use-chat-runtime.ts` 的 REST 重同步。测试见 `tests/chat-event-stream-failure.test.ts`。

手动压缩请求状态由 `chat-console.tsx` 传给 Composer，复用 `NoticeCard` 的 `loading` 参数展示旋转圆圈及本地化进度文案。处理中隐藏关闭按钮和旧压缩结果，请求结束后恢复结果/异常卡片；动画遵守减少动画设置，不新增轮询。

通用提示卡片 `components/notice-card.tsx` 接收文案、`error/info` 色彩语义和关闭回调，无场景操作按钮。错误使用柔和红色及 alert，普通信息使用主题绿色及 status。`chat-composer-panel.tsx` 在输入框外侧上方装配 `chat-composer-notices.tsx`；后者负责运行时与自动审批设置异常、压缩完成或跳过提示的状态优先级和本地化，不持有请求或草稿状态。两者共用宽度容器并按文案自然撑高；提示和输入区内的 Follow-up/Steer 队列均占正常布局空间，不通过绝对定位叠放。模型恢复及附件局部状态保留各自入口。测试见 `tests/notice-card.test.tsx`、`tests/chat-composer-notices.test.tsx`。

`chat-console.tsx` 通过 `model/chat-activity.ts` 将等待当前 Run 首次内容的状态投影为 `showActivity`，排除等待审批及初始加载；忽略旧 Run 和空消息开始，当前 Run 有文本、思考或工具内容后隐藏。`chat-timeline.tsx` 在记录末尾居中显示无外圈的三点 CSS 动画，减少动画偏好下保持静态。指示出现时复用底部跟随逻辑，不打断用户向上阅读，不新增请求或写入消息历史。回归见 `tests/chat-timeline.test.tsx` 和 `tests/chat-activity.test.ts`。

上下文占用入口为 `features/chat/components/chat-context-usage-indicator.tsx`，由 Composer 在模型选择器旁展示圆环及中英文悬浮详情。`runtime/use-chat-runtime.ts` 复用 Run SSE 的 `context.updated`，通过 `runtime/chat-context-usage-store.ts` 接收查询及手动压缩快照；每个 Session 独立存储，查询取消和更新计数避免旧结果覆盖新快照。空数据隐藏，进度视觉上限为 100%，详情保留实际占用；使用统计快照中的模型，不按草稿模型选择预估。测试见 `tests/chat-context-usage.test.tsx`，协议见 [context-usage-integration.md](../frontend/context-usage-integration.md)。

工具参数被截断时，`chat-message.tsx` 的 `ToolRequestArguments` 展示完整参数浮层；右下角复制按钮将完整参数写入剪贴板，显示成功或失败反馈，并在按钮获得焦点时保持浮层打开。

| 目录 | 用途 |
|---|---|
| `app/` | 路由入口、全局 Provider 装配、元数据和全局样式 |
| `components/` | 跨 feature 的产品壳层、Workspace 控制台、侧边栏和通用交互 |
| `features/*/api/` | 浏览器到后端的 HTTP 请求封装；SSE 类通常位于对应 `runtime/` 或 hook |
| `features/*/components/` | 功能 UI、表单和 React hook；部分复杂客户端编排也在此层 |
| `features/*/model/` | 前端契约类型、纯状态转换、校验和解析函数 |
| `features/*/runtime/` | Chat/Terminal 的长生命周期连接、恢复和运行时编排 |
| `shared/` | 跨功能 API 客户端与错误语义 |
| `lib/` | 仅供未挂载的历史原型使用的数据，不是已接入功能的数据源 |
| `tests/` | API 客户端、纯状态和关键交互的定向测试 |

## 修改时的交叉检查

- 改页面入口或全局 Context：同时检查 `app/layout.tsx`、`components/workspace-sidebar.tsx` 和目标页面总装配组件。
- 改 HTTP/SSE 契约：同时检查 feature 的 `api/` 或 `runtime/`、`model/` 解析/类型以及相应 `tests/`。
- 改 Session Chat：通常需要一起检查 Chat、LLM Provider、Session 和 Terminal 四个目录，因为 `chat-console.tsx` 在一处组合它们。
- 改 Workspace Files/Overview：通常需要一起检查 `workspace-console.tsx`、SFTP transfer provider 和 Workspace SSE hook。
- 历史原型未挂载到路由，修改它不会影响真实 Chat/Workspace 页面；真实功能入口分别是 `chat-console.tsx` 和 `workspace-console.tsx`。

新会话目录默认显示当前 Workspace `defaultCwd`，异步树加载后直接派生，不覆盖手动选择；清除覆盖恢复工作区默认目录。首次发送提交显示路径，创建成功后使用返回的规范化目录。回归见 `tests/new-session-default-directory.test.tsx`。

模型选择器仅在用户切换 Provider/Model 时，将标识写入浏览器全局 `localStorage`（`gori:last-model-selection:v1`），同模型不重复写入；不缓存凭据、模型能力或思考强度。新会话挂载时读取并通过 `resolveConfiguredModel` 校验可用性后预选，存储损坏、不可用模型和目录查询失败均保留手动选择入口；手选及卸载会取消恢复，迟到响应不覆盖用户选择。已有会话继续使用自身模型记录，自动恢复和发送消息不写全局缓存。缓存跨工作区、刷新和同源标签页共享，不跨浏览器同步。

工作区控制台铅笔入口使用 `workspace-edit-dialog.tsx` 编辑名称和默认目录，复用 `LocalDirectoryPicker` 浏览本机目录；保存通过 Workspace PATCH 携带 `displayName/defaultCwd/remoteDefaultCwd/expectedRevision`，成功后刷新共享树。取消目录选择保留草稿，保存失败保留弹窗与路径。已有 Session 目录不随 Workspace 默认值变更。
