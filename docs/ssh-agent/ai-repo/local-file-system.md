# 本地文件系统代码路由

适用于前端浏览整个本机文件系统或 Session 本地工作目录、选择可直接传给 Tool 的绝对文件路径，以及本地路径访问边界。

## 当前边界

- `GET /api/sessions/:sessionId/local-files` 列出当前 Session 有效工作目录的直接子项；`path` 查询参数用于逐级进入目录，不递归返回整棵目录树。
- `GET /api/sessions/:sessionId/local-files/content?path=...` 为独立阅读器读取根内 UTF-8 普通文件；支持相对有效工作目录的路径或根内绝对路径，最多 1 MiB，空文件合法，拒绝越界、符号链接、二进制与非法编码。读取磁盘当前版本并使用 no-store，不使用 Tool 的截断结果。该相对路径规则只适用于内容接口；目录列表仍要求绝对路径。实现与错误边界见 [file-reader.md](./file-reader.md)。
- `GET /api/local-files` 是独立的系统目录接口，以 `/` 为根目录，不查询 Session，也不受 `workDir` 限制，主要供前端展示整个本机目录结构。
- Session 接口的有效根目录为 `session.workDir ?? server localCwd`，系统接口的根目录固定为 `/`。两者都返回规范化的 `rootPath`、`currentPath`，以及每个文件或目录的绝对 `path` 和相对 `relativePath`。
- `path` 未提供或为空时使用根目录；非空时必须是绝对路径，并且规范化路径与真实文件系统路径都必须位于有效根目录内。
- 请求路径不允许包含符号链接。目录列表只返回普通文件和目录，不返回符号链接、socket、FIFO、设备等特殊文件。
- 返回的绝对文件路径可直接作为本地文件 Tool 的参数，但 Tool 仍必须在执行时重新验证 Session 边界和文件类型，不能信任前端输入。
- 该领域只访问 SSH Agent 服务所在主机的本地文件系统，不直接使用 Workspace SSH 目标、SFTP 或 FileTransfer；新 Session 创建时可从 Workspace `defaultCwd` 继承本地 `workDir`，浏览阶段只读取 Session 的有效目录。
- Session Attachment 使用独立的后端管理目录 `attachments/sessions/{sessionId}`，不受 `workDir` 浏览边界影响，也不会通过本地文件列表接口暴露；相关行为由 [attachments.md](./attachments.md) 路由。
- 本地文件领域错误在 HTTP 出口通过稳定 code 映射为请求 Locale 对应的静态文案；路径仍作为动态值原样返回，底层文件系统异常不会透传浏览器。
- Chat 输入框使用统一 Composer Menu：`@` 同时过滤工具与文件，`/` 只展示工具。空查询通过独立箭头逐级浏览目录；已有 Session 的非空查询改用 `GET /api/sessions/:id/local-files/search`，后端复用有界候选索引、应用忽略规则并全局评分，前端不再逐目录发 HTTP。支持文件名、路径、缩写和模糊匹配，提供包含忽略文件、刷新及不完整提示；新 Session 创建前仍只筛选系统目录的当前结果。缓存、资源预算、取消和精确响应契约见 [local-file-search.md](./local-file-search.md)。
- 选中的文件或目录以不可编辑的行内 Token 展示，但发送时仍序列化为消息正文中的 `<file ... />` 或 `<folder ... />` 自闭合标签；历史用户消息执行相同解析和渲染，不新增 Reference 实体。
- 新 Session 输入区和 Session 编辑弹窗都通过同一个系统目录选择器设置 `workDir`，不接受手填；目录选择器从当前目录或 `/` 逐级浏览，只展示目录，新 Session 自动显示 Workspace 默认目录，手选路径优先，清除手选后恢复工作区默认值；Session 编辑弹窗仍可清空为系统默认目录；本地选择器和远端多选器打开时暂时卸载表单展示，返回保留同一编辑草稿，不叠加两个弹窗。新 Session 在首次消息创建 Session 时一并提交显示的目录。

## HTTP 契约

本地媒体使用独立的 `/api/sessions/:id/media-preview` 元数据与 `/content` 流式接口，不进入 UTF-8 内容解码。两类预览仅共用普通文件打开边界；macOS 系统 `/tmp`、`/var`、`/etc` 别名先规范到 `/private/...` 再校验，普通符号链接和工作目录越界仍拒绝。目录浏览规则未改变。完整边界见 [media-preview.md](./media-preview.md)。

```http
GET /api/sessions/:sessionId/local-files
GET /api/sessions/:sessionId/local-files?path=/absolute/session/work/dir/uploads
GET /api/local-files
GET /api/local-files?path=/var/log
```

响应包含：

```ts
{
  rootPath: string;
  currentPath: string;
  relativePath: string;
  entries: Array<{
    name: string;
    path: string;
    relativePath: string;
    type: "file" | "directory";
    size: number;
    modifiedAt: number;
  }>;
}
```

## 代码位置

| 关注点 | 代码位置 |
|---|---|
| 领域契约和错误 | [local-file-system.ts](../../../packages/ssh-agent/src/domain/local-file-system.ts) |
| 系统与 Session 根目录解析、安全边界和目录读取 | [local-file-system-service.ts](../../../packages/ssh-agent/src/application/services/local-file-system-service.ts) |
| HTTP 路由和错误响应 | [http-handler.ts](../../../packages/ssh-agent/src/api/http-handler.ts) |
| Runtime 依赖装配 | [create-sqlite-management-backend.ts](../../../packages/ssh-agent/src/runtime/create-sqlite-management-backend.ts) |
| 后端回归测试 | [local-file-system-api.test.ts](../../../packages/ssh-agent/test/local-file-system-api.test.ts) |
| 前端 API Client、Composer Menu 触发与 Token 编辑器 | [local-files-api.ts](../../../packages/ssh-agent-web/features/chat/api/local-files-api.ts)、[chat-composer-menu.ts](../../../packages/ssh-agent-web/features/chat/model/chat-composer-menu.ts)、[chat-token-editor.tsx](../../../packages/ssh-agent-web/features/chat/components/chat-token-editor.tsx) |
| 标签解析、序列化与历史消息渲染 | [chat-composer.ts](../../../packages/ssh-agent-web/features/chat/model/chat-composer.ts)、[chat-reference.tsx](../../../packages/ssh-agent-web/features/chat/components/chat-reference.tsx)、[chat-message.tsx](../../../packages/ssh-agent-web/features/chat/components/chat-message.tsx) |
| Chat 与新 Session 接入 | [chat-console.tsx](../../../packages/ssh-agent-web/features/chat/components/chat-console.tsx)、[chat-composer-panel.tsx](../../../packages/ssh-agent-web/features/chat/components/chat-composer-panel.tsx)、[new-session-chat.tsx](../../../packages/ssh-agent-web/features/session/components/new-session-chat.tsx) |
| Session 工作目录选择与创建参数 | [new-session-chat.tsx](../../../packages/ssh-agent-web/features/session/components/new-session-chat.tsx)、[session-dialog.tsx](../../../packages/ssh-agent-web/features/session/components/session-dialog.tsx)、[local-directory-picker.tsx](../../../packages/ssh-agent-web/features/session/components/local-directory-picker.tsx)、[session-api.ts](../../../packages/ssh-agent-web/features/session/api/session-api.ts) |
| 前端回归测试 | [chat-composer-menu.test.ts](../../../packages/ssh-agent-web/tests/chat-composer-menu.test.ts)、[chat-composer.test.ts](../../../packages/ssh-agent-web/tests/chat-composer.test.ts)、[session-directory-picker.test.tsx](../../../packages/ssh-agent-web/tests/session-directory-picker.test.tsx) |

修改路径边界时必须同时覆盖词法逃逸、真实路径逃逸、符号链接、缺失路径、非目录路径和 Session 默认工作目录。

Session 标题后的只读信息卡片也复用 `localFilesApi.listSession()` 的 `rootPath`：显式 `workDir` 直接展示，历史 null 值在打开卡片时解析实际后端默认目录，不能用 Workspace 当前默认值替代。`use-session-work-dir.ts` 负责取消迟到请求、成功缓存及失败后重新打开重试；不新增后端接口或改变本地文件访问范围。回归见 `tests/session-work-dir.test.ts`。
