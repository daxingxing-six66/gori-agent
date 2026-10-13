# Session 任务 Tab 容器

适用于已有 Session 的通用任务容器、标签选择、关闭请求和会话布局。当前唯一接入页面为 Terminal；不提供 Deploy/Monitor Tab、多个 Terminal 实例或工作流执行引擎。

## 职责与契约

- `features/task-container/components/task-container.tsx` 接收 `tabs`、`activeTabId`、`tabListLabel` 和 `onSelect`。`TaskTab` 只包含 id、title、content、可选展示 status 和可选 close 能力；颜色 tone 为 neutral/positive/warning/danger，不识别业务状态名。
- 容器不导入 Terminal/Deploy/Monitor 模块、不调用业务 API。关闭按钮仅调用 `onRequestClose`；是否可关闭、原因和 busy 由调用方提供，任务实际结束后由装配层移除页面。
- 所有页通过稳定 id 保持挂载，未选中的 `tabpanel` 用 `hidden` 隐藏，切换页面不销毁运行状态。选择失效时展示第一个现有页，没有任务时返回 null。
- 标签和关闭按钮是独立原生 button，不嵌套。`tablist/tab/tabpanel` 通过 ARIA 关联，左右方向键循环激活并聚焦，Home/End 定位首尾，保留浏览器组合快捷键。
- `task-container.css` 只管理标签栏和内部页面：44px 顶栏、精简标题/状态与关闭按钮，使用 Workbench 主题语义变量，不增加容器标题或任务启动列表。

## 会话装配与布局

- `features/chat/components/chat-console.tsx` 装配任务描述与具体页面，保持功能运行逻辑在各自模块。当前 Terminal 页面以固定功能 id `terminal` 接入，容器按 Session key 隔离。
- `/` 或现有 `@` 工具菜单选择 Terminal 时，未打开则调用现有 open；已有页面则选中，包含正在连接、失败和关闭过渡中的页面，不重复打开或关闭。定位可在 Agent 运行期间进行，生命周期操作仍受原限制。
- `chat-task-layout.css` 负责容器在会话页的位置，Terminal 内容不再拥有 Session 网格区域。1100px 及以下位于页首和聊天之间，高度为标签栏加 250px 内容区；1101px 起为全高右栏，占内容宽度 45%。退出期间右栏和聊天宽度同步过渡。
- 容器宽度和过渡时长从 `model/task-container-defaults.ts` 读取。最终页面数和业务模块的退出投影决定容器存在与展开状态。
- Terminal 模块由 `use-terminal-task.ts` 提供页面存在、阶段、关闭限制与动作；`terminal-task.tsx` 组合连接过程、失败和只读终端内容。其生命周期和权威恢复详见 [Terminal 功能文档](./features/terminal-interaction.md)。

## 入口与验证

| 职责 | 源码 |
|---|---|
| 通用契约、标签交互与页面保留 | `packages/ssh-agent-web/features/task-container/components/task-container.tsx` |
| 标签栏和内部页面样式 | `packages/ssh-agent-web/features/task-container/components/task-container.css` |
| 容器宽度与过渡默认值 | `packages/ssh-agent-web/features/task-container/model/task-container-defaults.ts` |
| 会话装配与 `/` 入口 | `packages/ssh-agent-web/features/chat/components/chat-console.tsx` |
| 会话网格、响应式位置与退出过渡 | `packages/ssh-agent-web/features/chat/components/chat-task-layout.css` |
| 通用选择、关闭保护、键盘和内容保留回归 | `packages/ssh-agent-web/tests/task-container.test.tsx` |

定向测试采用 Node 环境的真实 React 输出与事件处理器检查，验证通用容器的语义和职责；不代表真实 SSH、浏览器 PTY 或跨平台验证。已确认的长期约束见 [任务容器与 Terminal 重构约束](../design/task-container-terminal-refactor.md)。
