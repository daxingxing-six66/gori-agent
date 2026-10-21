# 文件阅读器代码路由

适用于 Chat `read` / `write` 工具操作的本地文本文件、上传的文本附件、右侧独立阅读器标签、代码高亮与 Markdown 预览。阅读器只读，不参与 Agent、Terminal 或 Deploy 的执行生命周期。

## 入口与隔离

- 已成功完成且 `isError` 不为 true 的 `read` / `write` 工具行，将文件名显示为阅读器入口；兼容参数 `path` 与旧的 `file_path`。等待、运行、失败及待审批状态不提供此入口。点击文件名只调用 `onOpenFile(path)`，阻止原生 summary 展开；其他区域仍可展开完整参数与工具输出。
- `ChatTimeline` / `ChatMessageRow` 仅转交回调，`ChatConsole` 装配 `features/file-reader/` 与通用 `TaskTab`。阅读器不导入 Terminal、Deploy 或 TaskContainer，不复用其 API、状态、SSE、关闭流程或样式。通用容器无需新增文件类型分支。
- Composer 已上传的文档卡与用户历史消息中的文档卡共用 `onOpenAttachment`，经 ChatConsole 打开同一阅读器。`ReaderDocument.source` 明确区分 local 路径与 attachment ID；附件标签按 Session/附件 ID 去重，同名不同附件保持独立。入口拒绝跨 Session 元数据，读取接口再次校验真实归属。
- `use-file-reader-tabs.ts` 按 Session 与工作目录隔离标签。相对路径以已配置的工作目录组成词法身份，折叠 `.` / `..`；同路径重复打开定位原标签并重新读取，不新增标签。不同目录同名文件保持独立身份。关闭仅移除该阅读器；卸载中止读取，过期响应不回写。
- 多个文件可以并存，切换或收起保留页面 DOM 与滚动位置。阅读器复用通用容器的停靠、放大、Escape 和收起能力；最后一个任务关闭后恢复聊天布局。打开的文件列表不持久化，刷新或重新进入 Session 后从工具历史再次打开。

## 内容与展示

- 内容来自单独的本地文件接口，读取点击时的磁盘文件，不使用可能含 offset/limit 或截断提示的 Tool Result，也不将 write 成功提示当作文件内容。不保存工具调用时的文件历史版本；文件后续变化可再次点击文件名或使用重新读取按钮更新。
- 文档附件使用独立的附件 ID 读取接口，继续共用页面、Markdown、代码高亮、刷新和错误展示。内容请求按 Session、源类型、路径/ID 隔离；源改变时立即隐藏旧内容，取消旧请求并丢弃迟到响应。附件响应的 `path` 为文件名，不作为宿主机路径使用。
- `file-language.ts` 使用精确版本 Highlight.js 的 common 语言集合，并显式补充 Dockerfile、Gradle 与 properties；按扩展名或特殊文件名识别 SQL、YAML、JavaScript/JSX、TypeScript/TSX、Java、JSON、Python、Shell、Go、Rust、C/C++ 等。未知类型以转义纯文本显示。超过 200,000 字符的代码跳过高亮并显示提示，仍提供完整文本。
- `.md/.markdown/.mdown/.mdx` 默认直接渲染 Markdown 阅读预览，不提供源码切换；MDX 按 Markdown 处理，不执行 JSX。使用现有 ReactMarkdown + remark-gfm 支持标题、列表、表格、引用及代码块，高亮 fenced code。原始 HTML 跳过，危险 URL 不生成链接；外部 HTTP/HTTPS/mailto 链接安全打开，外部 HTTP/HTTPS 图片惰加载；相对链接及本地图片目前仅显示标签/替代文字。
- 代码只插入 Highlight.js 已转义的高亮结果；无法高亮时交由 React 转义。阅读器样式全部限定在独立局部 CSS，读取 Workbench/主题语义色。按钮、只读/预览说明、加载、空文件、重试与错误提示使用独立 `file-reader.ts` 中英文目录；路径及文件内容保持原文。

## HTTP 与文件边界

```http
GET /api/sessions/:sessionId/local-files/content?path={encodedPath}
```

成功返回 `200 { path, name, content, size, modifiedAt }`，其中 path 为绝对路径、size 为实际读取字节数、modifiedAt 为文件句柄 stat 的修改时间；使用 `Cache-Control: no-store`。只读取 SSH Agent 后端本机文件，不使用 SSH/SFTP。

- 有效根为当前 `session.workDir ?? localCwd`。接口接受根内绝对路径或相对该根的路径；现有目录列表接口仍只接受绝对路径。拒绝空白、NUL、词法越界、符号链接及非普通文件。
- 读取 helper 以 realpath 检查路径，打开句柄后复核普通文件及设备/inode；支持的系统使用 NOFOLLOW/NONBLOCK 防止末端符号链接或 FIFO 替换。最多读取 1 MiB + 1 字节，超过 1 MiB 返回 413，不返回伪装成完整文件的截断片段。
- 仅支持 UTF-8，空文件合法；非法编码及二进制控制字节返回 415。缺失文件、权限及其他文件系统错误沿用 LocalFileSystemError 和统一安全本地化出口；不透传底层异常。
- 工作目录外文件、符号链接、非文本或超限文件在阅读器中显示错误，不扩大现有 Session 文件浏览边界。此接口不会修改原 Agent 工具的执行或审批规则。

上传文档另走 `GET /api/sessions/:sessionId/attachments/:attachmentId/text`，不把附件存储目录加入本地文件浏览根，也不读取客户端 `storagePath`。返回相同文本展示结构，1 MiB 和 UTF-8 限制复用原 helper；详情见 [attachments.md](./attachments.md)。

## 入口与验证

| 职责 | 源码 |
|---|---|
| 文件类型、高亮、标签身份 | `packages/ssh-agent-web/features/file-reader/model/` |
| 独立标签、请求、取消与过期保护 | `packages/ssh-agent-web/features/file-reader/runtime/` |
| HTTP client | `packages/ssh-agent-web/features/file-reader/api/file-reader-api.ts` |
| 只读页面、Markdown、代码和局部样式 | `packages/ssh-agent-web/features/file-reader/components/` |
| 工具文件入口与 Session 装配 | `packages/ssh-agent-web/features/chat/components/chat-message.tsx`、`chat-timeline.tsx`、`chat-console.tsx` |
| Session 根解析与有界读取 | `packages/ssh-agent/src/application/services/local-file-system-service.ts`、`read-local-text-file.ts` |
| 返回契约、错误与 HTTP | `packages/ssh-agent/src/domain/local-file-system.ts`、`packages/ssh-agent/src/api/http-handler.ts`、`packages/ssh-agent/src/application/failure-policy.ts` |
| 前端回归 | `packages/ssh-agent-web/tests/file-reader.test.tsx`、`file-reader-runtime.test.tsx`、`file-reader-api.test.ts` |
| 后端回归 | `packages/ssh-agent/test/local-file-system-api.test.ts` |

定向测试使用真实 React/Markdown/Highlight.js 输出、确定性 Hook 驱动、临时目录和隔离 SQLite。浏览器使用实际 Reader/TaskContainer/工具行与模拟文件接口验证打开、多文件、重复定位、Markdown 与 SQL/YAML、明暗主题、空/错状态、关闭和放大/收起；不代表真实 SSH、付费模型或 Windows/Linux 实机验收。
