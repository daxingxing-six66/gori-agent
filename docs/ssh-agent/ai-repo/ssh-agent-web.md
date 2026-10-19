# Gori Web 前端代码路由

本文只索引 `packages/ssh-agent-web/`。目标是把前端功能修改快速路由到源码，不记录当前实现步骤、接口字段全集或后端行为；涉及服务端契约时，应另行查阅对应后端功能文档和源码。

浏览器图标由 `app/layout.tsx` 的 Metadata 与显式 head 链接声明：`public/favicon-16.png`、`public/favicon-32.png` 供小尺寸标签页使用，`public/favicon.png` 为 256px 版本，`public/apple-touch-icon.png` 为 180px 触屏图标。图像保留大猩猩与绿色终端符号，外围透明，无黑色底板；根目录 `icon.png` 与 256px 版本保持一致。替换资源时同步尺寸声明并递增图标 URL 的版本参数，避免旧浏览器缓存。

新会话页 `new-session-chat.tsx` 在原有三套配色的提示标题上方复用透明的 `public/favicon.png`，替代原星光图标；桌面显示为 96px，640px 以下显示为 80px，与标题及说明保持左对齐，不增加底板或边框。ION 主题隐藏该位图，改用无绿色的 CPU/电路图形，桌面 88px、窄屏 72px。

创建工作区弹窗底部左侧提供可选“测试连接”，测试当前草稿，无需工作区名称或有效默认目录；结果复用 NoticeCard，在操作栏上方显示。ManagementDialog 增加可选 footerLeading/footerNotice 插槽，取消和创建保持右侧一组。测试期间禁用重复测试与创建，编辑连接字段、进入凭据配置或关闭时取消并清除结果；请求序号避免旧结果回写。实现、契约与测试见 [connection-test.md](./connection-test.md)。

工作区创建/编辑弹窗使用 `workspace-form.tsx` 共用分区、紧凑凭据行和目录控件，局部样式集中于 `workspace-form.css`，通过 `workspace-management-dialog` 限定作用范围。桌面端采用左侧说明、右侧表单，600px 以下改为单列；凭据仅展示名称、用户与类型，说明位于控件下方并关联无障碍描述。本地/远端目录使用不同的小图标和截断路径，标签位于控件上方；目录、凭据控件与输入框保持相同高度，不使用图标底座和大面积强调底色。创建时高级连接参数默认收起，字段发生原生或服务端校验错误时自动展开；编辑弹窗标题下显示主机、端口和环境。ManagementDialog 的可选 className/headerIcon 支持这类扩展，其余管理弹窗保留默认外观。

侧边栏的工作区展开状态由根布局中的 `WorkspaceTreeProvider` 按工作区 ID 独立保存，切换工作区或会话页面不会收起其他工作区。首次进入尚无展开记录的工作区时默认展开；手动收起（包括当前工作区）会保留到本次页面生命周期结束，刷新浏览器后重新初始化。

左侧会话行由独立 `components/sidebar-session-row.tsx` 展示，右侧固定槽通过 `features/session-activity/` 显示运行旋转、审批/回答等待和本次观察到的完成、失败、停止图标；悬浮或键盘聚焦时编辑/删除优先显示，标题与左侧导航圆点不移动。点击会话清除该会话当前已结束结果的未读标识，已读按 Run ID 保存在当前浏览器，刷新/重连不复现，新 Run 可重新提示；正在运行或等待处理的状态继续显示。当前可见会话成功完成会自动已读并直接清除运行标识，其他会话及后台完成结果保留提醒；失败、停止和待处理状态不自动清除。根布局挂载共享 Provider，通过一个全局流观察，只向 Store 上报路由与页面可见性，自动已读归 Store 处理，前端按 Session ID 独立通知目标行。初始不批量回填历史结果；断线清除旧显示，重连恢复本进程的快照。WorkspaceSidebar 只装配导航与管理回调，不参与状态归约和聊天生命周期。边界见 [session-activity.md](./session-activity.md)。

桌面 `WorkspaceSidebar` 展开宽度保持 256px，收起宽度为 44px，展开与设置按钮居中。宽度变化由 Terminal 容器已有的 `ResizeObserver` 感知，owner 在防抖后测量、提交行列数，服务端确认事件再同步 xterm；布局样式不直接改 PTY geometry，也不重新建立 attachment。

窄屏首页仍显示工作区导航；在 Workspace 与 Session 页面，`WorkspaceSidebar` 改为可从页首按钮打开的抽屉，支持关闭按钮、遮罩和 Escape，并在关闭后将焦点还给入口。Workspace 控制台将工作区上下文页首与 Tab 导航分为两层，Tab 支持方向键循环切换及 Home/End，活动面板通过 ARIA 关联。跨页面骨架使用 `components/page-layout.tsx` 的 PageHeader/PageHeading，布局位于 `page-layout.css`，颜色继续引用 `app/globals.css` 的主题变量；不改变 Workspace/Session 路由及审批状态归属。

页面按用途组织：Dashboard 先展示 CPU/内存/磁盘指标和进程表，连接池与显式沙箱检测作为辅助区域，SSH 参数默认折叠；Guard、Credential、SFTP 使用统一内容标题及操作区，凭据和文件采用紧凑列表。Chat 与新会话在桌面使用 44px 单行页首和 820px 阅读列，页首不显示工作区/目录副标题，空闲“就绪”不展示，运行、重连、失败及取消状态仍保留。Sidebar 品牌栏与 Terminal 顶栏同高，原有三套配色的品牌栏只显示 Gori，底部设置与统计入口在展开时为 46px 横排，收起时为 82px 纵排；窄屏侧栏按钮为 28px，标题截断而不撑高页首。对话、提示和输入区对齐，窄屏输入区控件可换行；Session 右侧由通用任务容器承载，标签栏接替 Terminal 顶栏，名称和连接阶段只展示一次；Terminal 内部保留原有输出与恢复，底部活动列表不再挂载。容器布局与业务生命周期分别管理，见 [task-container.md](./task-container.md)。侧边栏采用小图标与更紧凑的工作区/会话行。

视觉精修沿用原主题系统；新增 ION 离子终端为可选实验，独立 `features/theme/styles/ion.css` 提供琥珀服务器机架、紫色 Agent 核心与冰蓝运行观察三个区域，以及等宽顶栏、区域编号、锐利边界和无绿色 ANSI palette。原有三套配色：明暗分层实验主题使用深绿导航、近白对话及浅中性 Workbench 外壳，内部 Terminal 使用中性深灰绿；明亮与暗部保留各自配色，共用轻量组件样式。`globals.css` 集中提供 Sidebar/Workbench/Terminal/Code 与圆角语义变量，顶栏和活动记录不继承 Terminal 深底。正文 14px、代码 12px，聊天代码块随主题使用轻量表面；原有三套配色的普通卡片去除装饰阴影，Composer 使用 12px 圆角和细中性边框，新会话及已有会话均取消聚焦时的边框变色与外圈高光。父级服务器与当前会话通过底色重量、细指示条、字重和树线分层；Tool Call 继续使用紧凑行和原生展开控件。布局、输入、审批、模型选择、复制及 Terminal 的 attach/SSE/resize 行为不由样式接管。完整主题边界见 [theme.md](./theme.md)。

创建工作区的默认工作目录通过 `LocalDirectoryPicker` 选择，复用新建聊天的 `GET /api/local-files` 本机目录浏览、筛选及面包屑。打开选择器时暂时卸载外层管理弹窗，取消/Escape 只返回草稿，确认后回填 `defaultCwd`；其余表单和连接测试结果保留。

只读模式统一从编辑会话设置，Composer 不提供只读入口或命令，详见 [session-sandbox.md](./session-sandbox.md)。新会话先使用本地化占位标题，首条消息成功启动后由同模型异步命名；WorkspaceTreeProvider 订阅当前工作区的 session.updated 更新侧边栏和页面标题，首次连接及重连均刷新持久化数据。见 [session-title.md](./session-title.md)。

Chat 协议接受 runtime system 消息，状态按 `runtimeEventId` 保留同毫秒内的不同切换。时间线不把模式协议显示为 Assistant 气泡，也不因仅有模式记录而隐藏空会话提示。回归见 `tests/chat-system-messages.test.tsx`。 部署入口使用独立 custom 消息，支持字符串或文本块 content；先按 role 分流，仅 Assistant 数组进入内容渲染，REST 与 SSE 按稳定身份合并。

Deploy 模块选定后的自动发布消息使用后端返回的 Discussion 服务名称填充 `deploy.planning.prompt`，例如“我想发布 AI Web API……”，只补名称。该意图仍走普通 user 提交流程；选择来源、Profile/模块绑定及阶段状态由后端运行时 system 上下文独立提供。


工作区创建/编辑表单提供默认本地工作目录和独立沙盒可写目录列表，已移除默认远端工作目录。本地沿用 LocalDirectoryPicker；沙盒列表由 RemoteDirectoryPicker 通过 SFTP 多选，初始浏览路径为首个已选目录或 `/`。创建时使用尚未保存的主机/凭据临时连接，配置完整后才能浏览；编辑时使用当前工作区 SFTP API。选择器只列目录，支持面包屑、搜索、加载和失败重试，`/` 可浏览但不能加入可写列表，确认后回填规范路径。概览只展示本地默认目录，新会话继承本地 `defaultCwd`，SFTP 默认从 `/` 浏览。


工作区表单分别提供单个默认远端目录与紧凑的沙盒可写目录列表。多选 `RemoteDirectoryPicker` 通过勾选跨目录保留选择，显示可移除标签、数量和批量确认，最多 16 条；列表字段共用 `sandbox-writable-roots-field.tsx` 与局部 CSS。Overview 通过 `remote-sandbox-panel.tsx` 显示尚未验证、显式检测后的 ABI/规范根或失败原因和时间，初始不宣称已开启。检测响应在 Workspace model 边界验证模式、后端、完整约束、ABI 与完整根列表及首根兼容字段后才展示为成功；畸形响应进入错误状态。检测请求可取消，状态按 Workspace ID/revision 隔离。见 [remote-sandbox.md](./remote-sandbox.md) 与 `tests/remote-sandbox.test.tsx`。

## 使用顺序

已有 Session 页首在沙盒标识左侧通过展示插槽挂载独立 `features/server-metrics/`：CPU、内存和服务器网络收发速率按 Workspace 共享缓存与订阅，窄屏页首可换行。指标组件与 Chat/Terminal 请求解耦，Overview 卡片保持原样。入口、状态边界及移除方式见 [session-server-metrics.md](./session-server-metrics.md)。

Chat 的 `UserDecisionPanel` 在输入框上方向上展开，显示模型提供的一个或多个建议、推荐图标、自定义输入和跳过；建议选择或跳过自动进入下一题，最后一题完成后才显示提交，返回仍可修改，更多交互见 [user-decision.md](./user-decision.md)。`use-chat-runtime.ts` 将待审批、待决 REST 恢复与 Run SSE 合并到 `ChatRuntimeState`；切回 Session 后加载更早消息或合并压缩结果只更新消息，不丢弃已恢复的待审批和待决状态。关闭决策面板仅隐藏，可从输入框上方重新打开，不向后端提交跳过。普通工具记录以动作与目标组成紧凑单行，展开后显示完整参数和输出；失败线索直接可见，待审批操作保留完整说明和操作按钮。思考、压缩摘要与部署详情沿用各自的展开控件。

1. 先从“页面与总装配”确定功能出现在哪个页面。
2. 再从“功能路由”打开该功能的组件、运行时或状态入口。
3. API 请求改动同时检查该 feature 的 `api/`、`model/` 和对应测试。
4. 样式问题按组件类名定位共用或 feature 局部 CSS；基础主题变量在 `app/globals.css`，ION 扩展在 `features/theme/styles/ion.css`，不要从全局样式反推功能边界。

## 页面与总装配

| 页面或壳层 | 首要入口 | 继续追踪 |
|---|---|---|
| 全局 Theme/Settings/Provider 装配、元数据、全局样式 | `app/layout.tsx` | `features/theme/components/theme-provider.tsx`、`features/settings/components/settings-provider.tsx`、`features/llm-provider/components/llm-provider-provider.tsx`、`features/workspace/components/workspace-tree-provider.tsx`、`app/globals.css` |
| `/statistics` 全局使用统计 | `app/statistics/page.tsx` | 独立 `features/statistics/`，概览、模型用量、运行记录、工作区用量四个 Tab；详见 [statistics.md](./statistics.md) |
| `/` 工作区导航壳层 | `app/page.tsx` | 仅装配 `components/workspace-sidebar.tsx`；无欢迎区、无演示会话，真实功能从侧边栏进入 |
| `/workspaces/:workspaceId` Workspace 控制台 | `app/workspaces/[workspaceId]/page.tsx` | `components/workspace-console.tsx`；在这里装配 Overview、Guard、Credential、SFTP Files 四个页签 |
| `/workspaces/:workspaceId/chat/new` 新会话 | `app/workspaces/[workspaceId]/chat/new/page.tsx` | `features/session/components/new-session-chat.tsx` |
| `/sessions/:sessionId` 真实会话 | `app/sessions/[sessionId]/page.tsx` | `features/chat/components/chat-console.tsx`；Terminal 也由该组件装配 |
| 共用页首、内容标题与 Workspace Tab 导航 | `components/page-layout.tsx`、`components/page-layout.css` | `features/workspace/components/workspace-tab-navigation.tsx` 提供受控 Tab、键盘焦点和面板标识；`features/chat/components/chat-page-header.tsx` 组合聊天/沙盒状态与服务器指标展示插槽 |
| 全局 Workspace/Session 导航与管理入口 | `components/workspace-sidebar.tsx` | Workspace 创建、Session 重命名/删除、设置弹窗均从这里进入 |
| 全局设置总入口 | `components/settings-dialog.tsx` | 外观、上下文压缩、Provider Credential 和自定义 Provider 的分类与多视图流程 |

## 功能路由

普通请求使用 `shared/api/client.ts`，所有 EventSource 地址使用独立的 `shared/events/client.ts`，通过不同 origin 隔离浏览器连接额度。各功能适配器保留事件解析、重连与取消；后端双监听和构建配置见 [transport-channels.md](./transport-channels.md)。

`@` 非空文件检索由 `features/chat/runtime/use-local-file-search.ts` 持有防抖、取消和响应身份，`local-files-api.ts` 只发一次后端索引查询；菜单显示最多 80 项，支持包含忽略文件、手动刷新及部分结果提示。规则与性能预算见 [local-file-search.md](./local-file-search.md)。

成功的 `read` / `write` 工具行可点击文件名，经 ChatConsole 打开独立 `features/file-reader/` 标签页；代码使用 Highlight.js，Markdown 直接阅读预览，自有 Hook/API/局部 CSS 与双语目录。阅读器不依赖 Terminal/Deploy 或其生命周期，通用 TaskContainer 无新增业务分支。内容读取、去重、取消和边界及测试见 [file-reader.md](./file-reader.md)。

| 要修改的前端功能 | 首要文件 | 状态、协议和辅助文件 | 对应测试 |
|---|---|---|---|
| Workspace/Session 树加载与全局刷新 | `features/workspace/components/workspace-tree-provider.tsx` | `workspace-tree-context.ts`、`features/workspace/api/workspace-api.ts`、`features/workspace/model/workspace.ts` | `tests/api-clients.test.ts` |
| Workspace 创建、编辑、删除和远端目录选择 | `features/workspace/components/workspace-dialog.tsx`、`features/workspace/components/workspace-edit-dialog.tsx`、`components/workspace-console.tsx` | `features/workspace/components/workspace-form.tsx`、`workspace-form.css`、`remote-directory-picker.tsx`、`name-dialog.tsx`、`features/workspace/api/workspace-api.ts`；创建时复用 Credential 草稿和临时 SFTP 浏览，编辑时使用工作区 SFTP API | `tests/workspace-connection-test.test.tsx`、`tests/workspace-edit-dialog.test.tsx`、`tests/api-clients.test.ts` |
| SSH Credential 创建、列表、切换、删除 | `features/credential/components/credential-manager.tsx` | `credential-manager.css`、`credential-dialog.tsx`、`api/credential-api.ts`、`model/credential.ts` | `tests/api-clients.test.ts` |
| Session 创建、首次发送前选择工作目录、命名、自动审批、重命名和删除 | `features/session/components/new-session-chat.tsx`、`components/workspace-sidebar.tsx` | `session-edit-dialog.tsx`、`session-dialog.tsx`、`session-delete-dialog.tsx`、`local-directory-picker.tsx`、`api/session-api.ts`、`model/session.ts`、`features/workspace/model/session-update.ts` | `tests/session-title.test.tsx`、`tests/session-directory-picker.test.tsx`、`tests/api-clients.test.ts` |
| Session 沙盒开关及只读设置、呼吸灯、页首标识、配置更新与 Terminal 自动重开 | `features/session/runtime/use-session-sandbox.ts`、`features/session/components/session-dialog.tsx` | `model/session-sandbox-command.ts`、`components/session-sandbox-badge.tsx`、`components/session-sandbox-status.tsx`、`features/chat/components/chat-console.tsx`、`features/i18n/messages/*/session.ts`；菜单仅保留开关入口，状态以呼吸灯表示；“只读”选择位于编辑会话的目录标题后方同一行，说明通过信息图标悬浮展示，勾选后给目录区加禁用蒙层；页首运行状态左侧以图标和短文案显示已确认设置；详见 [session-sandbox.md](./session-sandbox.md) | `tests/use-session-sandbox.test.ts`、`tests/session-sandbox-command.test.tsx`、`tests/session-edit-dialog.test.tsx`、`tests/sandbox-writable-roots.test.tsx` |
| Guard 规则编辑、开关、创建和删除 | `features/guard/components/guard-editor.tsx` | `guard-rule-dialog.tsx`、`guard-rule-switch.tsx`、`model/guard.ts`、`model/guard-editor-state.ts` | `tests/guard-editor-state.test.ts` |
| Guard 自动保存、冲突恢复和 optimistic 开关回滚 | `features/guard/components/use-guard-autosave.ts` | `api/guard-api.ts`、`model/guard-editor-state.ts` | `tests/guard-editor-state.test.ts`、`tests/api-clients.test.ts` |
| Guard 规则包浏览和导入 | `features/guard/components/guard-rule-pack-dialog.tsx` | `model/guard-rule-pack-state.ts`、`api/guard-api.ts` | `tests/guard-rule-pack-state.test.tsx` |
| Provider 全局目录状态 | `features/llm-provider/components/llm-provider-provider.tsx` | `llm-provider-context.ts`、`api/llm-provider-api.ts` | `tests/llm-provider-state.test.ts`、`tests/api-clients.test.ts` |
| 自动上下文压缩全局设置 | `features/context-compaction/components/context-compaction-settings.tsx` | `api/context-compaction-settings-api.ts`、`model/context-compaction-settings.ts`、`features/llm-provider/components/model-selector.tsx` | `tests/context-compaction-settings.test.ts`、`tests/api-clients.test.ts` |
| 明亮、暗部、明暗分层实验、ION 离子终端、跟随系统主题和设置分类 | `features/theme/components/theme-provider.tsx` | `features/settings/`、`features/theme/model/theme.ts`、`app/layout.tsx`、`app/globals.css`；导航语义色独立，服务器/子会话有不同选中样式，Terminal 保留原有布局和对齐 | `tests/theme-state.test.tsx` |
| Provider Credential 配置、轮换和删除 | `components/settings-dialog.tsx` | `features/llm-provider/api/llm-provider-api.ts`、`model/llm-provider.ts` | `tests/llm-provider-state.test.ts`、`tests/api-clients.test.ts` |
| 自定义 Provider、静态模型目录和浏览器模型发现 | `features/llm-provider/components/custom-provider-editor.tsx` | `model/custom-provider-model-discovery.ts`、`api/llm-provider-api.ts`、`model/llm-provider.ts` | `tests/custom-provider-model-discovery.test.ts`、`tests/api-clients.test.ts` |
| 模型和 Thinking 等级选择 | `features/llm-provider/components/model-thinking-selector.tsx` | `model-selector.tsx`、`thinking-level-selector.tsx`、`thinking-level-slider.tsx`、`model/llm-provider.ts` | `tests/llm-provider-state.test.ts` |
| Chat 页面总装配、输入、发送、停止、队列、自动审批、手动上下文压缩、图片附件上传和消息滚动 | `features/chat/components/chat-console.tsx` | `chat-token-editor.tsx` 从拖拽与剪贴板的 FileList/ClipboardItem 接收图片；`chat-composer-panel.tsx` 以缩略图网格呈现本地预处理及上传状态，并保存成功图片的 Attachment 投影，经 `use-chat-runtime.ts`、`api/chat-api.ts` 随新 Run 与 Queue 请求提交 ID。`chat-message.tsx` 使用消息响应的受控 `contentUrl` 回显 JPEG、PNG、WebP：历史附件在文字气泡上方独立展示，使用时间线 50% 宽度的右对齐单行横向轨道，缩略图不足一行时在轨道内右对齐，超出时横向滚动；文字气泡随内容收缩，最大宽度为时间线的 78%；`chat-image-preview-dialog.tsx` 为输入区和历史图片共用全屏预览、元数据与多图切换，不读取 `storagePath`。其余入口包括 `chat-timeline.tsx`、`chat-markdown.tsx`、`chat-reference.tsx`、`model/chat-scroll.ts`、`features/session/api/session-attachment-api.ts`。附件契约见 `docs/ssh-agent/frontend/chat-image-attachment-integration.md` | `tests/chat-token-editor.test.ts`、`tests/chat-composer-menu.test.ts`、`tests/chat-composer.test.ts`、`tests/chat-runtime-state.test.ts`、`tests/api-clients.test.ts` |
| Chat REST 请求、刷新恢复、Run/Queue/Approval/Compaction 状态和 SSE | `features/chat/runtime/use-chat-runtime.ts` | `api/chat-api.ts`、`runtime/chat-event-stream.ts`、`model/chat-runtime-state.ts`、`model/chat.ts` | `tests/chat-runtime-state.test.ts`、`tests/api-clients.test.ts` |
| Chat 模型选择恢复和失效处理 | `features/chat/runtime/use-chat-model-selection.ts` | `model/chat-model-selection-restore.ts`、`features/llm-provider/api/llm-provider-api.ts`、`features/session/api/session-api.ts` | `tests/chat-model-selection-restore.test.ts` |
| Chat 编辑器中的 `/`/`@` Composer Menu、Terminal/上下文压缩工具、本地文件引用、目录浏览和搜索 | `features/chat/components/chat-token-editor.tsx` | `model/chat-composer-menu.ts`、`api/local-files-api.ts`、`model/chat-composer.ts`、`chat-reference.tsx`、`app/globals.css` | `tests/chat-composer-menu.test.ts`、`tests/chat-composer.test.ts`、`tests/session-directory-picker.test.tsx` |
| `/deploy` 服务选择、持久化模式、横向阶段、日志与历史入口 | `features/deploy/components/deployment-module-picker.tsx`、`deployment-task-page.tsx`、`deployment-review.tsx` | 无活动部署时，模块选择在 Agent Composer 上方向上展开，使用独立局部 CSS 和 `model/deployment-module-options.ts`；选择后才创建讨论并显示任务，有活动部署直接定位。`runtime/use-deployment.ts` 分开装配模式/目录/选择面板/任务显示，`use-deployment-tasks.ts` 读取权威活动身份，`use-deployment-catalog.ts` 只缓存已读取 Run，不再请求独立历史分页；`deployment-event-stream.ts` 独立订阅部署事件，`deployment-log-store.ts` 用 REST+SSE 游标补齐日志。正式 custom 历史消息由 Deploy 独立历史卡片打开右侧页，结束时同一入口移至结束位置；模型文字、用户问题和命令权限审批留在中间，部署计划确认与修订在右侧。关闭 Tab 不结束部署，放大补充框复用同一 Session 发送/排队。旧数据兼容只读；详见 [deployment.md](./deployment.md)。 | `tests/deployment-completion-history.test.tsx`、`tests/deployment-task.test.tsx`、`tests/chat-custom-messages.test.tsx`、`tests/deployment-panel.test.tsx`、`tests/use-deployment-races.test.ts` |
| SFTP 目录浏览、筛选、下载和删除 | `features/sftp/components/sftp-files-tab.tsx` | `use-sftp-directory.ts`、`sftp-directory-entries.tsx`、`sftp-delete-dialog.tsx`、`api/sftp-api.ts` | `tests/sftp-api.test.ts`、`tests/sftp-state.test.ts` |
| SFTP 上传、覆盖确认、取消、重试和离开页面保护 | `features/sftp/components/sftp-transfer-provider.tsx` | `sftp-transfer-queue.tsx`、`model/sftp-state.ts`、`model/sftp.ts`、`api/sftp-api.ts` | `tests/sftp-api.test.ts`、`tests/sftp-state.test.ts` |
| Workspace SSE、服务器指标和 Connection Pool 快照 | `features/sftp/components/realtime-overview-tab.tsx` | `overview-dashboard.css`、`use-workspace-events.ts`、`model/sftp-state.ts`、`model/sftp.ts`；概览顶部为三个指标卡，主区域展示进程表，侧栏展示 Pool 与沙箱检测，SSH 详情可展开；状态由原有 SSE 快照推导，监控失败仍保留最后一次成功数据 | `tests/sftp-state.test.ts`、`tests/overview-i18n.test.tsx` |
| 通用任务标签栏、停靠/放大/收起、页面保留与会话区域布局 | `features/task-container/components/task-container.tsx` | `task-container.css`、`model/task-container-defaults.ts`、`runtime/use-task-container-display.ts`、`runtime/task-container-fullscreen.ts`、`features/chat/components/chat-task-layout.css`；右侧任务页可向左覆盖对话区，左侧导航保留，收起不卸载内容；容器不认识业务模块，装配见 ChatConsole 与 [task-container.md](./task-container.md) | `tests/task-container.test.tsx` |
| Terminal 打开/定位入口、标签关闭、失败、过渡和状态恢复 | `features/terminal/runtime/use-terminal-task.ts`、`features/terminal/components/terminal-task.tsx` | `runtime/use-terminal-mode.ts` 管理后端状态、Session 隔离和同步请求锁；`use-terminal-task.ts` 投影页面与动作；`terminal-task.tsx` 组合连接过程、失败和只读输出。已有 Tab 可在 Agent 运行时定位，新开和关闭保持原运行限制；标签关闭复用 close，失败页只收起。详见 [Terminal](./features/terminal-interaction.md) | `tests/use-terminal-task.test.ts`、`tests/use-terminal-mode.test.ts`、`tests/terminal-open-failure.test.tsx` |
| 只读 xterm、输出批处理、snapshot/replay/live 切换、focus ownership 和 resize | `features/terminal/components/terminal-panel.tsx` | `runtime/terminal-event-queue.ts` 保留输出边界；`runtime/terminal-viewport-sync.ts` 处理可见性、ownership 与串行尺寸请求，隐藏时释放权限、恢复时测量，geometry 只由服务端事件确认；`model/terminal-theme.ts`、`runtime/terminal-event-stream.ts`、`model/terminal.ts`、`api/terminal-api.ts` | `tests/terminal-viewport-sync.test.ts`、`tests/terminal-event-queue.test.ts`、`tests/terminal-client.test.ts`、`tests/terminal-theme.test.ts` |
| Terminal Observation 遮罩、范围投影和恢复 | `features/terminal/components/terminal-observation-mask.tsx` | `model/terminal-observation-mask.ts`、`model/terminal-observation-range.ts`、`runtime/terminal-observation-range-tracker.ts` | `tests/terminal-observation-mask.test.ts`、`tests/terminal-observation-range.test.ts` |
| Terminal 审计时间线与 Observation 恢复 | `features/terminal/components/terminal-panel.tsx` | `api/terminal-api.ts`、`model/terminal.ts`；面板继续读取时间线恢复 Observation，默认不展示底部列表；`terminal-timeline.tsx` 保留组件但不挂载 | `tests/terminal-client.test.ts`、`tests/terminal-observation-mask.test.ts` |
| 所有后端 API 的基地址、JSON 请求和错误解析 | `shared/api/client.ts` | `shared/errors/api-error.ts`；文件上传例外在 `features/sftp/api/sftp-api.ts` 使用 XHR | `tests/api-clients.test.ts`、`tests/sftp-api.test.ts` |
| 通用管理弹窗、Select、Switch | `components/management-dialog.tsx`、`components/custom-select.tsx`、`components/toggle-switch.tsx` | 使用方通常位于具体 feature 的 `components/` | 以各功能测试为主 |
| 页面布局、颜色、Terminal/弹窗/编辑器样式 | `components/page-layout.css`、`app/globals.css` | Dashboard、SFTP、凭据、沙箱检测和 Workspace 表单分别使用 feature 局部 CSS；先从具体组件 className 反查，不在样式文件判断业务状态归属 | 无独立样式测试 |

命令详情由 `chat-tool-details.tsx` 的工具类型注册表选择独立渲染器：`chat-remote-command-details.tsx` 负责 SSH 请求及已有退出码/退出信号，`chat-terminal-interaction-details.tsx` 负责 submit/key/observe，并通过动作注册表选择输入或快捷键展示；卡片不显示操作（action）和观察预期（expectation）参数行，仅在展示层过滤，原请求、复制及 SSE 数据保持不变；观察结束不推断远端进程完成。两者复用 `chat-command-details.tsx` 与局部 CSS 的请求、参数和输出排版，参数标签/值格式化在 `chat-command-parameters.ts`，未知参数保留原值。只有已有字段才显示工作目录、超时、请求权限和截断标记，不补默认值或查询新数据。命令结果从已有 SSE Tool Result 的 `content` 或历史文本块读取，输出原文、空白及滚动能力保留；状态归约、复制及待审批分支沿用原链路。上传/下载独立入口与既有路径/进度投影移到 `chat-transfer-details.tsx`，默认工具使用通用渲染器。渲染器不订阅 SSE；Chat、Terminal、Workspace/Deploy 继续使用各自已有的解析和分发入口。回归见 `tests/chat-command-details.test.tsx` 和 `tests/chat-ui-hierarchy.test.tsx`。

## 目录职责

运行期间普通发送进入 follow_up。输入区 `chat-composer-panel.tsx` 的 `QueuePreview` 在 pending follow_up 行右侧提供无背景、无边框、无阴影的引导图标，尺寸为 14px、描边为 2.25，相比初始的 12px / 2 仅轻微加大加粗，保留原主题图标色和键盘焦点提示，通过 `use-chat-runtime.ts` 调用 `chat-api.ts` 的原项转换接口，不重新发送消息；取消操作保留。每行以标签、可收缩文本和固定 52px 右侧操作列排版，长文本省略，不将图标推到内容尾部或撑宽行。队列区域按条数自然增高，最多完整显示四行（每行 36px，间距 4px），超过四条后纵向滚动。请求期间锁定队列操作，失败刷新队列；状态归约防止延迟响应恢复已消费项目。回归见 `tests/chat-queue-promotion.test.tsx`。

点击停止输出且存在排队消息时，后端中断当前输出，每次只将队首一条加入同一 Run，其余消息继续排队；`use-chat-runtime.ts` 不主动清空 pending 控件，而按返回的 Run 状态和 REST/SSE 同步。真正进入终态才由 reducer 清理，重同步失败时继续保留已有队列。队列为空时仍取消 Run；回归见 `tests/chat-runtime-cancel.test.ts`，后端生命周期边界见 [chat-runtime.md](./chat-runtime.md)。

Chat 错误展示复用 `features/chat/components/chat-failure-details.tsx`，消息历史和当前 Run 都保留 errorId 与 recovery。`chat-timeline.tsx` 按同一 errorId 隐藏重复错误提示但保留文本/工具内容。`chat-event-stream.ts` 接受无 tokensBefore 的 compaction.failed，已知协议解析失败、stream.resync 和 run.persistence_failed 触发 `use-chat-runtime.ts` 的 REST 重同步。测试见 `tests/chat-event-stream-failure.test.ts`。

手动压缩请求状态由 `chat-console.tsx` 传给 Composer，复用 `NoticeCard` 的 `loading` 参数展示旋转圆圈及本地化进度文案。处理中隐藏关闭按钮和旧压缩结果，请求结束后恢复结果/异常卡片；动画遵守减少动画设置，不新增轮询。

通用提示卡片 `components/notice-card.tsx` 接收文案、`error/info` 色彩语义和关闭回调，无场景操作按钮。错误使用柔和红色及 alert，普通信息使用主题强调色及 status。`chat-composer-panel.tsx` 在输入框外侧上方装配 `chat-composer-notices.tsx`；后者负责运行时与自动审批设置异常、压缩完成或跳过提示的状态优先级和本地化，不持有请求或草稿状态。两者共用宽度容器并按文案自然撑高；提示和输入区内的 Follow-up/Steer 队列均占正常布局空间，不通过绝对定位叠放。模型恢复及附件局部状态保留各自入口。测试见 `tests/notice-card.test.tsx`、`tests/chat-composer-notices.test.tsx`。

`chat-console.tsx` 通过 `model/chat-activity.ts` 将等待当前 Run 首次内容的状态投影为 `showActivity`，排除等待审批及初始加载；忽略旧 Run 和空消息开始，当前 Run 有文本、思考或工具内容后隐藏。`chat-timeline.tsx` 在记录末尾居中显示无外圈的三点 CSS 动画，减少动画偏好下保持静态。指示出现时复用底部跟随逻辑，不打断用户向上阅读，不新增请求或写入消息历史。回归见 `tests/chat-timeline.test.tsx` 和 `tests/chat-activity.test.ts`。

上下文占用入口为 `features/chat/components/chat-context-usage-indicator.tsx`，由 Composer 在模型选择器旁展示圆环及中英文悬浮详情。`runtime/use-chat-runtime.ts` 复用 Run SSE 的 `context.updated`，通过 `runtime/chat-context-usage-store.ts` 接收查询及手动压缩快照；每个 Session 独立存储，查询取消和更新计数避免旧结果覆盖新快照。空数据隐藏，进度视觉上限为 100%，详情保留实际占用；使用统计快照中的模型，不按草稿模型选择预估。测试见 `tests/chat-context-usage.test.tsx`，协议见 [context-usage-integration.md](../frontend/context-usage-integration.md)。

`chat-message.tsx` 的普通工具记录使用原生 `details`：收起时只显示动作、截断的目标和状态线索，展开后可查看完整参数、输出、耗时并复制参数。上传/下载详情共用路径排版：下载显示“远程文件 / 本地路径”（未得到落地文件路径时为“本地目录”），上传显示“本地文件 / 远程路径”（未得到目标文件路径时为“远程目录”）；优先使用结果中的实际路径，长路径自然换行，不直接展示参数键名。两者保留进度条、百分比和已传输/总字节，完成或失败后从既有结果 `details` 恢复，正常传输去除底部重复结果说明，错误、结果不确定说明及原参数复制仍保留。`chat-runtime-state.ts` 保存已有 Tool Result 的可选详情供 UI 使用，不扩展 HTTP/SSE 协议。连续的纯工具消息在 `chat-timeline.tsx` 中缩小垂直间距。待审批记录使用紧凑的行内确认区：命令预览可滚动，完整参数可展开，后端权限说明、已知远端主机与具体批准动作直接可见；批准或拒绝按钮在请求处理中禁用而不消失。主机从当前 Workspace 只读传入，不改变审批对象或后端权限判断。

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

工作区控制台铅笔入口使用 `workspace-edit-dialog.tsx` 编辑名称、本地默认目录及沙盒可写默认列表，分别使用 `LocalDirectoryPicker` 和 `RemoteDirectoryPicker` 浏览本机与远端目录；保存通过 Workspace PATCH 携带 `displayName/defaultCwd/sandboxWritableRoots/expectedRevision`，成功后刷新共享树。取消目录选择保留草稿，保存失败保留弹窗与路径。已有 Session 目录不随 Workspace 默认值变更。

新 Session 创建时复制 Workspace 的可写目录列表，之后独立保存；Workspace 更新不覆盖已有 Session。侧边栏每个 Session 的铅笔入口打开 `features/session/components/session-edit-dialog.tsx`：先读取权威 Session，再在 `session-dialog.tsx` 一起编辑名称、本地目录、自动审批、只读模式及多目录，允许显式复制最新 Workspace 默认列表。“只读”复选框位于目录标题后方同一行，信息图标悬浮或聚焦展示说明；勾选后下方选择和移除区显示禁用蒙层并禁用按钮，隐藏目录继承说明，取消后恢复已选目录。恢复 Workspace 默认目录改为标题行右侧的刷新图标，保留悬浮标题和无障碍名称，只读时禁用。提交沿用编辑时 revision，冲突不能自动覆盖；目录未变时省略字段，一次保存携带编辑快照 revision；保存成功或可能已提交的 PTY 重开失败都会刷新树及当前 Terminal。页首沙盒标识恢复为只读图标与短文案，`use-session-sandbox.ts` 只负责 `/sandbox` 切换。前端纯校验及新旧审计解析位于 `features/workspace/model/sandbox-writable-roots.ts`，回归见 `tests/sandbox-writable-roots.test.tsx`、`tests/session-edit-dialog.test.tsx` 和 `tests/use-session-sandbox.test.ts`。

部署历史卡片由 `features/deploy/components/deployment-history-card.tsx` 与局部 CSS 独立呈现，`model/deployment-history.ts` 只识别服务端历史条目及缓存 Run，统一分页和旧记录结束位置由后端 Chat 历史查询负责，入口解析和卡片/结束工具共享摘要归 `deployment-history-entry.ts`。成功/失败/取消复用同一消息 ID；通用 Chat reducer 只按较新 sequence 防止旧 REST/SSE 覆盖，部署事件仍走独立 adapter。`deployment-completion-history.ts` 在精确匹配已完成的结束工具结果时，用同一张卡片替换该工具展示并移除原重复入口，保留其他消息内容，不改取消或错误展示。上传/下载继续走 `chat-transfer-details.tsx`，不共享 Deploy 的状态、卡片或样式。

阶段失败不再触发“让模型分析修复”卡片。`model/deployment-review.ts` 的 `deploymentReviewState()` 集中计算真实审阅需求；`use-deployment-review.ts` 在最近有效审批到期时用单次 timeout 刷新共享快照，ChatConsole 的右侧计划审阅和中间权限审批使用同一份结果，不每秒轮询聊天。DeploymentReview 仅呈现快照，无需决定时返回空；权限按钮由独立 DeploymentFullAccessReview 呈现。任务契约/校验保留在 deployment-task.ts，不混入审阅规则。计划确认、待审修订、确认后继续及必要的逐命令权限决定保留，移除额外启动恢复 Run 的按钮与回调。

Deploy 模块选择由 ChatConsole 装配到 Composer 的通用 `aboveInputPanel` 插槽，Composer 不认识部署业务；TaskPage 已移除 Profile 和选择回调。非模态面板沿用聊天输入框底色，有序列表的每项为约 36px 高的独立圆角卡片，细边框和轻微底部阴影区分边界，前置单选圆点并自动编号，仅显示模块名称，去掉图标、配置来源和绿色高光；保留内部滚动、键盘导航和外部关闭，Esc/关闭按钮恢复输入焦点；浏览/关闭不创建部署或发送模型请求。模式/目录错误在面板内展示并可重试。回归见 `deployment-task-interactions.test.tsx` 与 `use-deployment-races.test.ts`。

ChatTimeline 不再接收 deployments/discussion 或部署历史分页回调，消息和部署入口都来自同一次 Chat 历史响应；加载完成前不渲染独立到达的卡片。前端 reducer 用 sequence/historyOrder 稳定合并锚点及附属旧卡片，重复页或先到的旧页不打乱同组顺序。原部署结束工具的精确展示替换和右侧日志查询保留。

右侧 Deploy 待确认计划使用 deployment-plan-overview.tsx 的竖向时间轴：保留阶段图标，32px 节点间距，默认收起，展开通过连接线延伸为独立内容卡片。deployment-plan.css 管理局部样式；开始按钮在分隔线上方，32px 高、中性高对比色与轻微阴影。use-deployment-execution.ts 处理确认意图、重复点击和迟到响应，后端确认开始后才由独立 DeploymentPipeline 显示准备及四个执行节点；计划不会提前显示执行成功，进入执行页面后移除底部计划折叠入口；开始前审阅和必要修订确认保留。执行节点与计划复用 deployment-stage-icon.tsx 的 Hammer/Upload/RotateCw/ShieldCheck，图标位于横向连接线上；阶段结果以颜色、小状态标记及无障碍名称表达，点击继续切换日志。prepare 使用 ClipboardList 清单图标作为第一个可见节点，详情复用 DeploymentPlanOverview 展示本次计划，不提供重复执行按钮。查看准备时隐藏执行日志区域，原日志页面保持挂载，切回执行节点继续查看日志；浏览计划不改变真实执行阶段。普通工具和 Full Access 审批仍在中间，历史计划不获得当前部署的操作回调。任务页不展示结算 reason 的长篇总结，模型结论保留在中间会话。DeploymentBuildSteps 独立提供右对齐的步骤上一/下一命令浏览，引用块背景及左边线强化命令，浏览不改变真实执行状态；DeploymentLogs 将同阶段各次执行按原文连续追加到一个视口，通过日志标题整块折叠，不再创建执行分组卡片；错误定位和跟随输出会展开日志。
