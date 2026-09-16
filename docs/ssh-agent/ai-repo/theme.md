# Gori Web 主题系统代码路由

适用于全局明亮、暗部、跟随系统三态主题，设置入口、语义配色和 xterm 动态配色。

## 当前边界

- 主题偏好为 `light`、`dark`、`system`，未设置或值无效时默认 `system`。偏好只保存在浏览器 `localStorage` 的 `ssh-agent-theme`，不进入后端、Workspace 或 Session 数据。
- 根布局在 React hydration 前运行无副作用的主题脚本，把偏好和解析后的主题写入 `html` 的 `data-theme-preference`、`data-theme` 与 `color-scheme`，避免首屏亮暗闪烁。Theme Provider 随后接管状态，并只在 `system` 模式下响应系统主题变化。
- 通用 Settings Provider 独立持有设置弹窗生命周期。设置默认进入“外观”，并提供“上下文压缩”和“LLM Provider”分类；切换到 “LLM Provider” 后才加载 Provider 数据，各业务设置保存期间共享禁止关闭和切换分类的 busy 语义。
- `globals.css` 定义页面、文字、边界、交互、状态、阴影和 Terminal 语义变量。暗部使用低饱和绿色炭灰表面；弹窗、浮层和侧边栏才启用磨砂，普通卡片保持实色。
- xterm 使用独立的完整 light/dark ANSI palette。主题变化只更新现有 `Terminal.options.theme`，不重新 attach、detach、创建 SSE、清空 scrollback 或改变 geometry。

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 首屏主题恢复与全局 Provider 装配 | `packages/ssh-agent-web/app/layout.tsx`、`packages/ssh-agent-web/features/theme/model/theme-bootstrap.ts` |
| 偏好解析、系统跟随和 React Context | `packages/ssh-agent-web/features/theme/model/theme.ts`、`packages/ssh-agent-web/features/theme/components/theme-provider.tsx` |
| 设置生命周期和三态选择界面 | `packages/ssh-agent-web/features/settings/`、`packages/ssh-agent-web/components/settings-dialog.tsx`、`packages/ssh-agent-web/features/theme/components/theme-selector.tsx` |
| 明暗语义色、磨砂表面和兼容样式 | `packages/ssh-agent-web/app/globals.css` |
| xterm palette 与运行时更新 | `packages/ssh-agent-web/features/terminal/model/terminal-theme.ts`、`packages/ssh-agent-web/features/terminal/components/terminal-panel.tsx` |
| 状态与 Terminal 配色测试 | `packages/ssh-agent-web/tests/theme-state.test.tsx`、`packages/ssh-agent-web/tests/terminal-theme.test.ts` |
