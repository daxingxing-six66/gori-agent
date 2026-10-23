# Gori 宣传网站

适用于独立宣传 package `packages/gori-website`。它不改变 `ssh-agent-web` 产品首页，不导入后端服务，不加入产品构建/启动链路。

## 入口与职责

| 入口 | 职责 |
| --- | --- |
| `packages/gori-website/package.json`、`vite.config.js`、`tsconfig.json` | Vite 静态构建、loopback 4188 开发/预览、checkJs 类型检查 |
| `packages/gori-website/index.html` | 公共静态页面和工作台、审批、安装、FAQ 等可复用节点 |
| `packages/gori-website/src/scenarios.js` | 四个固定演示的数据及结果片段 |
| `packages/gori-website/src/demo.js` | 场景/步骤、键盘、文件导航、主题与焦点 |
| `packages/gori-website/src/main.js`、`src/dom.js` | 外链、移动导航、审批示例、复制及 DOM 边界 |
| `packages/gori-website/src/styles.css`、`src/workspace.css` | 页面布局、工作台主题、响应式与减少动态效果 |
| `packages/gori-website/src/designs.js`、`src/designs.css`、`src/tabby.css`、`src/mono.css` | 暖色终端、空间实验、黑白编辑三版的入口与独立视觉 |
| `packages/gori-website/src/studio.html`、`src/studio-experience.css` | Studio 专用四幕叙事、能力展廊、授权与开始使用，以及全屏菜单/工作台布局 |
| `packages/gori-website/src/studio-page.js` | 挂载专用页面、移动公共节点、dialog 与焦点恢复、按钮指针反馈 |
| `packages/gori-website/src/studio-scene.js` | 统一滚动进度、章节/HUD、意图与数据包、横向展廊、暂停和可见性生命周期 |
| `packages/gori-website/src/studio-dataflow.js` | 原生 Canvas2D 透视字符、轨道、数据包与结果形态绘制；不拥有独立 RAF/事件监听 |
| `packages/gori-website/README.md` | 本地使用、官方开源站参考依据与交付边界 |

## 行为与边界

- 根命令为 `dev:website` / `build:website` / `preview:website`，构建到该 package 的 `dist/`，资源地址相对化，可用于静态托管。根 `check` 包含宣传站类型检查。根 `build` 与产品 `start` 不包含宣传站。
- `design` 参数允许 tabby/studio/mono，默认 tabby。Tabby / Mono 使用公共静态页面；Studio 挂载专用完整布局，把同一套工作台、审批、安装和 FAQ 节点移入新结构。比较入口在 Tabby / Mono 的页面底部、Studio 的探索菜单中；URL 切换后刷新仍保留所选方案，不存储用户偏好。
- 四个 Tab 切换内存检查、部署、诊断和远程文件示例。切换回到第一步；首屏默认停在内存读取后的步骤以展示结果。步骤可向前、重播或点选，不使用模拟后台定时器。
- 文件示例支持 logs、config、文件预览与返回。独立审批卡支持批准、拒绝和重置。复制安装命令失败时选中文本并提示手动复制。
- 所有终端、状态、进度、日志和诊断均为固定示例，并有明确标记；没有 fetch、模型、SSH、真实文件浏览或后台调用。演示不表示真实请求已执行或验证通过。
- 场景选择采用 Tab 键盘规范；Tabby / Mono 的功能入口滚动并聚焦工作台。Studio 在捕获阶段先打开全屏工作台 dialog，再交给共用演示处理器选择场景和聚焦原面板。关闭后恢复触发焦点，Escape 沿用原生 dialog 关闭。探索菜单也是全屏 dialog，内部提供章节与方案入口。
- Studio 的全屏四幕按意图、命令、SSH、观测推进。原生纵向滚动通过统一进度同步章节、HUD 与共享 Canvas2D 透视数据流；不拦截 wheel，也不发起 SSH。章节可直接跳转，选择意图、发送意图与数据包按钮均只改变预设内容和视觉。
- 能力展廊在宽屏把原生纵向滚动映射成横向位移；窄屏或减少动态效果偏好下按纵向排布。各面板打开原工作台的对应场景，示例状态逻辑没有复制一套。
- 数据流为原创字符、轨道与数据包，不使用 Lusion 模型或资产。控制器处理暂停、减少动态效果、可见性与资源释放；绘制模块只消费帧参数。Canvas2D 不可用时保留静态字符背景与 DOM 内容，动态视觉不承载功能事实。
- 不加入客户背书、星数或性能数字。模型请求会发送至供应商；命令沙箱不承诺完整主机隔离。部署权限和 SFTP 范围按真实实现描述。
- 当前按本地 package 交付，没有注册、同步源码或部署 Sites。原 `docs/site` 留作旧静态介绍页，不参与本 package。

交互架构参考 Lusion 官方 [WebGL Scroll Sync](https://webgl-scroll-sync.lusion.co/) 与 [GitHub 说明](https://github.com/lusionltd/WebGL-Scroll-Sync) 中共享 Canvas 与 DOM 滚动同步的思路；本项目使用原生 Canvas2D 与自己的数据流叙事，不声称复制其渲染代码或完整官网效果。功能事实依据见 package README、[部署](./deployment.md)、[诊断](./diagnose.md)、[SFTP/监控](./sftp-monitoring.md)、[远端沙箱](./remote-sandbox.md) 与根 README。

## 验证

本轮浏览器检查覆盖 Studio 桌面与手机布局、原生滚动/章节跳转、意图/HUD 与结果入口同步、暂停与数据包、横向展廊与手机纵向布局、全屏菜单/工作台/锚点的关闭和焦点、部署/诊断/文件演示、主题、审批决定、安装复制及 FAQ。具体尺寸与检查边界见 package README。

变更后运行宣传站类型检查、静态构建及根 `npm run check`。减少动态效果、无 Canvas2D 和后台生命周期只做源码核对，未模拟系统或驱动故障；真实 SSH/模型操作不属于宣传站验收。
