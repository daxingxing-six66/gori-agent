# Session 任务 Tab 容器

适用于已有 Session 的通用任务容器、标签选择、关闭请求和会话布局。当前接入 Terminal 与 Deploy；不提供 Monitor、多个 Terminal 实例或通用工作流执行引擎。

## 职责与契约

- `features/task-container/components/task-container.tsx` 接收 `tabs`、`activeTabId`、`tabListLabel`、`onSelect` 和可选 `display`。后者包含受控 `mode`、已本地化的放大/退出/收起/展开标签和 `onModeChange`；模式为 docked/fullscreen/collapsed。`TaskTab` 只包含 id、title、content、可选展示 status 和可选 close 能力；颜色 tone 为 neutral/positive/warning/danger，不识别业务状态名。
- 容器不导入 Terminal/Deploy/Monitor 模块、不调用业务 API。关闭按钮仅调用 `onRequestClose`；是否可关闭、原因和 busy 由调用方提供，功能模块决定关闭语义并由装配层移除页面：Terminal 需结束运行，Deploy 只隐藏展示，明确退出部署另走业务接口。
- 所有页通过稳定 id 保持挂载，未选中的 `tabpanel` 用 `hidden` 隐藏，切换页面不销毁运行状态。选择失效时展示第一个现有页，没有任务时返回 null。
- 标签和关闭按钮是独立原生 button，不嵌套。`tablist/tab/tabpanel` 通过 ARIA 关联，左右方向键循环激活并聚焦，Home/End 定位首尾，保留浏览器组合快捷键。
- `task-container.css` 管理标签栏、展示按钮、恢复入口和内部页面：44px 顶栏、精简标题/状态与关闭按钮，使用 Workbench 主题语义变量，不增加容器标题或任务启动列表。展示按钮不受业务关闭禁用状态影响，任务运行期间可以放大或收起。

## 会话装配与布局

- `features/chat/components/chat-console.tsx` 装配任务描述与具体页面，保持功能运行逻辑在各自模块。Terminal 与 Deploy 分别以固定功能 id `terminal`、`deploy` 接入，容器按 Session key 隔离。Deploy 的模式、历史选择、日志与草稿由自身模块管理，容器没有部署状态分支。
- `/` 或现有 `@` 工具菜单选择 Terminal 时，未打开则调用现有 open；已有页面则选中，包含正在连接、失败和关闭过渡中的页面，不重复打开或关闭。定位可在 Agent 运行期间进行，生命周期操作仍受原限制。
- `/deploy` 无活动部署时只展开 Agent 输入框上方的模块选择，不新增任务 Tab；选择后或已有活动部署时才展示任务。选择器属于 Deploy 功能，Composer 只提供展示插槽，通用容器不承接选择器。
- `chat-task-layout.css` 负责容器在会话页的位置，Terminal 内容不再拥有 Session 网格区域。1100px 及以下位于页首和聊天之间，高度为标签栏加 250px 内容区；1101px 起为全高右栏，占内容宽度 45%。退出期间右栏和聊天宽度同步过渡。
- 容器宽度和过渡时长从 `model/task-container-defaults.ts` 读取。最终页面数和业务模块的退出投影决定容器存在与展开状态。
- Terminal 模块由 `use-terminal-task.ts` 提供页面存在、阶段、关闭限制与动作；`terminal-task.tsx` 组合连接过程、失败和只读终端内容。其生命周期和权威恢复详见 [Terminal 功能文档](./features/terminal-interaction.md)。

## 放大、收起与恢复

- `use-task-container-display.ts` 只管理当前挂载 scope 的展示模式，与任务业务状态独立。切换 Session 时立即回到 docked，最后一个任务移除后复位；不写数据库或浏览器偏好。Composer 定位已收起任务时恢复 docked，定位放大中的任务保留 fullscreen。
- fullscreen 将同一个 `.session-task-area` 在 Session 主体内绝对定位，`grid-area: auto` 避免右侧零宽网格限制其覆盖范围。右侧 Tab 连同当前任务向左覆盖页首、聊天和输入区，左侧服务器导航保持原位置与交互；不用原生 Fullscreen API，也不将内容移入 portal。
- `data-task-container-scope` 标记会话主体边界。`task-container-fullscreen.ts` 仅对该边界内被覆盖的兄弟区域设置 inert，退出/卸载时恢复原值；焦点移到退出按钮，支持区域内 Escape 退出。放大是非模态区域，不困住焦点、不让服务器导航退出键盘导航。
- collapsed 隐藏标签栏和内容区，所有 taskpanel 及功能内容继续挂载。桌面右侧保留 40px 的恢复栏，1100px 及以下保留 44px 恢复行；展开按钮显示当前任务标题，多任务时显示数量。恢复不执行业务 open/close 或重建页面；聊天草稿保持原 DOM。
- 三种展示模式复用相同任务页面，关闭仍由 Tab 的业务关闭契约处理。Terminal 的隐藏、恢复与尺寸协商由自身 `TerminalViewportSync` 根据实际 DOM 尺寸处理，容器不调用 Terminal API，不向任务传递业务 geometry。

## 入口与验证

| 职责 | 源码 |
|---|---|
| 通用契约、标签交互与页面保留 | `packages/ssh-agent-web/features/task-container/components/task-container.tsx` |
| 标签栏和内部页面样式 | `packages/ssh-agent-web/features/task-container/components/task-container.css` |
| 容器宽度与过渡默认值 | `packages/ssh-agent-web/features/task-container/model/task-container-defaults.ts` |
| 展示模式与 scope 隔离 | `packages/ssh-agent-web/features/task-container/model/task-container-display.ts`、`runtime/use-task-container-display.ts` |
| 放大范围、键盘与背景控件隔离 | `packages/ssh-agent-web/features/task-container/runtime/task-container-fullscreen.ts` |
| 会话装配与 `/` 入口 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx` |
| 会话网格、响应式位置与退出过渡 | `packages/ssh-agent-web/features/chat/components/chat-task-layout.css` |
| 通用选择、关闭保护、键盘和内容保留回归 | `packages/ssh-agent-web/tests/task-container.test.tsx` |

定向测试采用 Node 环境的真实 React 输出与事件处理器检查，覆盖展示请求、页面保留和业务关闭隔离；Terminal 尺寸同步由 `tests/terminal-viewport-sync.test.ts` 覆盖。浏览器验证使用真实 React/xterm/ResizeObserver 与模拟 REST/SSE，核对桌面与窄屏覆盖范围、导航保留、收起恢复、scope 复位及连接不重建；不代表真实 SSH/PTY 或跨平台验证。已确认的长期约束见 [任务容器与 Terminal 重构约束](../design/task-container-terminal-refactor.md)。
