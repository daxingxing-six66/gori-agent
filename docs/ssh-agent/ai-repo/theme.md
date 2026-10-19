# Gori Web 主题系统代码路由

适用于明亮、暗部、明暗分层实验、ION 离子终端主题与跟随系统偏好，设置入口、语义配色和 xterm 动态配色。

## 当前边界

- 主题偏好为 `light`、`dark`、`contrast`、`ion`、`system`，未设置或值无效时默认 `system`。`contrast` 对应“明暗分层 · 实验”，`ion` 对应“ION · 离子终端”，沿用同一选择入口和浏览器 `localStorage` 的 `ssh-agent-theme`，不进入后端、Workspace 或 Session 数据。`system` 仍只解析为明亮或暗部。
- 根布局在 React hydration 前运行无副作用的主题脚本，把偏好和解析后的主题写入 `html` 的 `data-theme-preference`、`data-theme`，避免首屏亮暗闪烁。`color-scheme` 在暗部与 ION 为 `dark`，明亮和明暗分层为 `light`。Theme Provider 随后接管状态，并只在 `system` 模式下响应系统主题变化。
- 通用 Settings Provider 独立持有设置弹窗生命周期。设置默认进入“外观”，并提供“上下文压缩”和“LLM Provider”分类；切换到 “LLM Provider” 后才加载 Provider 数据，各业务设置保存期间共享禁止关闭和切换分类的 busy 语义。弹窗外框使用 `overflow: clip`，防止隐藏 radio 获得焦点时滚动外框并裁掉页首；内容仍由原有内部区域滚动。
- `globals.css` 定义页面、文字、边界、交互、状态、浮层阴影及 Sidebar/Workbench/Terminal/Code 语义变量。明亮保留灰绿导航、明亮对话和浅绿灰 Terminal；暗部保留深色导航、较亮的炭灰对话和深色 Terminal。明暗分层采用低饱和深绿导航 `#263B30`、近白对话 `#FAFBF9`、中性 Workbench 外壳 `#F0F2EF` 与内部深灰绿 Terminal `#252C29`，默认终端文字为 `#DAE3DD`，不再使用蓝灰底色。Workbench 顶栏与活动记录使用独立语义变量，深色 Terminal 不向未来其他工作台视图扩散；暗部的 Workbench 外壳使用对应中性暗表面。导航在 `.workspace-sidebar` 内覆盖自己的语义色，不向弹窗或正文泄漏；原有三套配色的侧栏品牌栏只显示 Gori 文字。父级服务器选中使用轻量背景，无强化边框或指示条；当前会话用细指示条、更明确文字与适度底色强调，树线和缩进继续保留。Terminal 保留原有直角、贴边、全高右栏及响应式上下布局。
- 原有三种主题共用普通组件 8px、Composer 12px、紧凑状态标签 5px 的圆角 Token。普通卡片与输入框不使用装饰阴影，弹窗及菜单保留浮层阴影。对话正文 14px、行高 1.7，标题通过字重和间距分层，思考过程使用更弱的文字和细线。聊天代码块使用随主题变化的 Code 表面、12px 等宽文字，明亮/明暗分层为浅色，不修改代码内容、复制或滚动。Composer 保持多行输入和原操作分组；编辑区最小高度 56px，常规操作栏不换行且无附件/队列时，空闲输入框总高约 116px。内容随行数自然增高，编辑区达到 200px 后内部滚动，清空后回到最小高度，不增加 JavaScript 尺寸同步。原有三套配色的新会话和已有会话 Composer 均保持细中性边框，聚焦不改变边框或增加外圈高光。
- 外观选择继续使用原生 radio，展示四套配色及跟随系统，缩略图同时呈现导航、对话和 Terminal；主题卡片只保留名称与选中标识，跟随系统保留当前解析状态，不添加配色说明。
- 页面骨架由 `components/page-layout.css` 提供，共用页首、Tab、管理页标题以及聊天阅读列。`--workspace-header-height` 将 Sidebar 品牌栏、Chat/新会话页首与 Terminal 顶栏统一为 44px；原有三套配色的品牌栏仅单行显示 Gori，底部设置与统计入口展开时为 46px 横排、收起时为 82px 纵排，聊天不显示工作区/本地目录副标题及空闲“就绪”标签，活动运行、重连、失败和取消反馈仍保留。窄屏页首保持单行，标题截断，侧栏入口缩为 28px；管理页继续使用原有上下文页首。任务容器标签栏接替 Terminal 顶栏，只显示名称、连接阶段和关闭按钮，默认不挂载底部活动列表，Workbench 外壳仍使用独立主题变量。通用标签样式位于 `features/task-container/components/task-container.css`，会话布局位于 `features/chat/components/chat-task-layout.css`，Terminal 内容样式位于 `features/terminal/components/terminal-task.css`。Dashboard、文件、凭据和沙箱检测的样式位于各 feature 的局部 CSS，统一引用主题语义变量，不各自硬编码明暗配色或持有主题偏好。
- xterm 使用独立的完整 light/dark/contrast/ion ANSI palette，与各主题的 Terminal 容器底色一致。主题变化只更新现有 `Terminal.options.theme`，不重新 attach、detach、创建 SSE、清空 scrollback 或改变 geometry。

- ION 是独立可选的终端与 AI 视觉实验，样式集中在 `features/theme/styles/ion.css` 并由 globals 导入。服务器导航使用近黑暖底与琥珀 `#F2B56B`，Agent 会话使用紫黑 `#13101D` 与紫罗兰 `#BE9BFF`，运行观察使用蓝黑 Terminal `#080E18` 与冰蓝 `#79BAFF`。成功状态和 ANSI green/brightGreen 槽均使用蓝色，ANSI cyan 使用冰蓝，不引入绿色或青绿色。统计页局部语义变量、旧 Tailwind 明亮/绿色工具类与焦点样式均覆盖为 ION 配色。
- ION 专属 `ion-only` 装饰包含终端品牌符号、ION 标记与三个区域编号条；原有主题隐藏这些元素。区域条不承担运行状态或数据。服务器区保留树状导航并以命令提示符强调当前会话，Agent 区使用点阵底纹、方形 AI 标记、推理轴线与紫色顶边 Composer，运行区保留独立任务容器与真实 Terminal 内容。新会话用 CPU/电路图形替代绿色品牌位图；不影响浏览器静态 favicon。
- ION 普通组件 3px、Composer 4px、标签 2px 圆角，顶栏及输入使用系统等宽字体，正文仍为 14px 可读字体。Composer 顶部为 2px 紫色边线并保留轻微紫色阴影；不改变输入增长、操作分组、草稿与审批行为。窄屏在显示服务器指标时隐藏装饰 CPU 前缀以避免增加标题行。新增的静态区域条高 26px，760px 以下为 22px；任务区窄屏为它额外预留 26px，收起时隐藏区域条。既有任务的放大、关闭、挂载和 Terminal 尺寸同步仍由原机制负责。

桌面侧栏展开宽度为 256px，收起宽度为 44px，展开与设置按钮在收起栏内居中。侧栏宽度过渡改变 Terminal 的实际容器尺寸，仍由既有 `ResizeObserver` 和 `FitAddon.proposeDimensions()` 测量行列数；拥有 resize 权限的 attachment 在防抖后通过原接口提交，仅在行列数变化时请求，并以服务端 `terminal.resized` 事件更新 xterm。

任务容器的放大/退出与收起按钮位于标签栏右侧，沿用 Workbench 语义色。放大仅覆盖 Session 主体中的 Agent 对话区，左侧服务器导航保持可见与可操作；没有全局遮罩或原生浏览器全屏。收起后桌面保留 40px 右栏，窄屏保留 44px 恢复行，当前任务页隐藏但不卸载。放大视口在窄屏也填充主体高度，实际尺寸变化由 Terminal 的独立视口同步控制器处理；样式不自行调整逻辑行列数。详见 [task-container.md](./task-container.md)。

Composer 的发送/停止主操作按钮共用 32px 尺寸，原有三套配色使用圆形外观，ION 使用 3px 圆角，各主题的配色、禁用及加载状态沿用原样式。

命令详情使用 `chat-command-details.css` 的局部样式，统一引用 Surface/Code、文字和分割线变量：单一外框内区分请求、次级参数和输出，不嵌套卡片或新增装饰色。SSH 与 Terminal 共用外观，窄屏参数可换行，原始输出保留横纵滚动。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 首屏主题恢复与全局 Provider 装配 | `packages/ssh-agent-web/app/layout.tsx`、`packages/ssh-agent-web/features/theme/model/theme-bootstrap.ts` |
| 偏好解析、系统跟随和 React Context | `packages/ssh-agent-web/features/theme/model/theme.ts`、`packages/ssh-agent-web/features/theme/components/theme-provider.tsx` |
| 设置生命周期和主题选择界面 | `packages/ssh-agent-web/features/settings/`、`packages/ssh-agent-web/components/settings-dialog.tsx`、`packages/ssh-agent-web/features/theme/components/theme-selector.tsx` |
| 明暗语义色、Workbench/Code 表面、组件圆角和兼容样式 | `packages/ssh-agent-web/app/globals.css` |
| ION 独立配色、三区域样式、区域标记与统计配色覆盖 | `packages/ssh-agent-web/features/theme/styles/ion.css` |
| 共用页面骨架与聊天阅读宽度 | `packages/ssh-agent-web/components/page-layout.tsx`、`page-layout.css` |
| xterm palette 与运行时更新 | `packages/ssh-agent-web/features/terminal/model/terminal-theme.ts`、`packages/ssh-agent-web/features/terminal/components/terminal-panel.tsx` |
| 状态与 Terminal 配色测试 | `packages/ssh-agent-web/tests/theme-state.test.tsx`、`packages/ssh-agent-web/tests/terminal-theme.test.ts` |

多目录字段及远端多选器使用 `features/workspace/components/sandbox-writable-roots.css` 的局部样式与主题变量，目录列表保持紧凑行高、小图标及文字操作，选中路径以可移除标签呈现；窄屏操作区换行，列表文本截断并保留完整 title。Session 编辑弹窗复用同一字段及 `ManagementDialog` 的主题、滚动和操作区，不另建明暗配色；页首沙盒标识保留只读标签样式。

统计页面采用独立的分析视图风格，样式在 `features/statistics/components/statistics.css`：仅在统计 main 内覆盖语义变量为中性灰/深色表面，Sidebar 和其他页面不受影响。深色 KPI、面板标题带、较强边框和多色数据序列区分指标、分析和明细区域；四种主题仍使用统一偏好入口。图表浮层使用统计局部固定定位，不进入全局主题或业务状态。详见 [statistics.md](./statistics.md)。

用户决策的自定义想法输入区使用 `globals.css` 的 `decision-custom-*` 样式，复用表面、边框和文字语义变量。激活后保持单行，随文本换行增高至 144px 后内部滚动；使用完整中性边框，无下划线或装饰阴影，继续按钮为 44px 圆形。组件中的尺寸测量只控制 textarea 高度，不接管 Chat Composer、Terminal 或主题状态。

Deploy 计划使用 deployment-plan.css 的局部竖向时间轴和连接卡片，复用 Surface/Ink/Line/Code 语义变量。开始按钮采用中性高对比色，按用户精修为 32px 高，位于分隔线上方，通过轻微阴影区分层次；不修改全局按钮或其他功能配色。阶段节点间距 32px，节点图标/展开箭头使用轻微 drop-shadow，阶段文字和数量摘要使用 text-shadow；阴影颜色从当前主题 Ink 混合透明色得到，限于计划节点。完整内容按需展开；执行进度仍由原事实驱动。deployment-task.css 的横向流程增加 ClipboardList 准备图标，并复用其余四个语义图标作为线上节点，保留轻微图标阴影；连接线与小状态标记使用 Line/Accent/Danger 语义色，阶段身份不会被运行或结果图标替换。样式仅作用于 Deploy，不修改容器或全局图标。构建命令在局部引用块中使用 SurfaceMuted 背景和 LineStrong 左侧边线，步骤按钮右对齐；日志标题控制整块视口折叠，收回整个日志区的占高，连续文本使用同一等宽区域，不再有执行分组卡片。
