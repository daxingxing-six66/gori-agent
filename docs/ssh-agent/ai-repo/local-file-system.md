# 本地文件系统代码路由

适用于前端浏览整个本机文件系统或 Session 本地工作目录、选择可直接传给 Tool 的绝对文件路径，以及本地路径访问边界。

## 当前边界

- `GET /api/sessions/:sessionId/local-files` 列出当前 Session 有效工作目录的直接子项；`path` 查询参数用于逐级进入目录，不递归返回整棵目录树。
- `GET /api/local-files` 是独立的系统目录接口，以 `/` 为根目录，不查询 Session，也不受 `workDir` 限制，主要供前端展示整个本机目录结构。
- Session 接口的有效根目录为 `session.workDir ?? server localCwd`，系统接口的根目录固定为 `/`。两者都返回规范化的 `rootPath`、`currentPath`，以及每个文件或目录的绝对 `path` 和相对 `relativePath`。
- `path` 未提供或为空时使用根目录；非空时必须是绝对路径，并且规范化路径与真实文件系统路径都必须位于有效根目录内。
- 请求路径不允许包含符号链接。目录列表只返回普通文件和目录，不返回符号链接、socket、FIFO、设备等特殊文件。
- 返回的绝对文件路径可直接作为本地文件 Tool 的参数，但 Tool 仍必须在执行时重新验证 Session 边界和文件类型，不能信任前端输入。
- 该领域只访问 SSH Agent 服务所在主机的本地文件系统，不使用 Workspace SSH 目标、`defaultCwd`、SFTP 或 FileTransfer。
- Session Attachment 使用独立的后端管理目录 `attachments/sessions/{sessionId}`，不受 `workDir` 浏览边界影响，也不会通过本地文件列表接口暴露；相关行为由 [attachments.md](./attachments.md) 路由。
- 本地文件领域错误在 HTTP 出口通过稳定 code 映射为请求 Locale 对应的静态文案；路径仍作为动态值原样返回，底层文件系统异常不会透传浏览器。
- Chat 输入框使用统一 Composer Menu：`@` 在合法文本位置同时检索“工具”和“文件和文件夹”，查询词同时过滤两组；没有匹配工具时不渲染空工具分组，工具与文件均无匹配时显示统一空状态。消息开头的 `/` 只展示匹配工具，不调用文件接口。已有 Session 的文件组调用 Session 作用域接口，新 Session 创建前调用系统接口。空查询通过独立箭头逐级浏览目录；已有 Session 输入查询词后，前端以接口返回的有效 `workDir` 为根，复用目录列表接口进行有并发和数量上限的递归扫描，并在新查询到来时取消旧扫描。扫描跳过 `.git`、`node_modules`、构建产物和本地缓存等高成本目录，但这些目录自身仍可作为名称匹配结果展示。该能力不依赖后端递归搜索接口；新 Session 创建前仍只筛选当前目录结果。
- 选中的文件或目录以不可编辑的行内 Token 展示，但发送时仍序列化为消息正文中的 `<file ... />` 或 `<folder ... />` 自闭合标签；历史用户消息执行相同解析和渲染，不新增 Reference 实体。
- 新 Session 输入区和 Session 编辑弹窗都通过同一个系统目录选择器设置 `workDir`，不接受手填；目录选择器从当前目录或 `/` 逐级浏览，只展示目录，并可清空为系统默认目录。新 Session 在首次消息创建 Session 时一并提交所选绝对路径。

## HTTP 契约

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
