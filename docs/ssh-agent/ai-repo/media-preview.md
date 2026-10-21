# 多媒体文件预览

适用于 Chat 读取、写入、SFTP 上传/下载工具中的本地图片、音频和视频查看。它是独立的只读预览功能，不扩展模型多模态输入、附件上传格式或远端 SFTP 浏览器。

## 入口与模块边界

- 四类工具成功完成且未标记 `isError` 后，工具行提供 Eye 图标和“查看”。仅悬浮或键盘焦点进入该行时显示；点击阻止 summary 展开，点击其余区域仍展开工具详情，文件名与路径本身不再是查看按钮。上传、下载还必须有 `details.status=completed` 及有效的 `sourceFilePath` / `localPath`；不猜测下载目录中的文件名，不把远端路径送往本地接口。
- `tool-preview-file.ts` 只提取已确认本地路径。`ChatConsole` 依据扩展名将媒体交给 `features/media-preview/`，文本仍交给 `features/file-reader/`；后端媒体接口重新检查路径和类型，前端分类不是访问授权。
- 媒体自有标签、元数据请求、播放状态、错误与局部 CSS；不导入文本阅读器、Terminal、Deploy 或 TaskContainer。装配层把 `media:` 标签放入通用任务容器，容器没有媒体类型分支。路径词法身份仅复用无业务依赖的 `shared/files/local-path.ts`。
- 标签按 Session/工作目录隔离，同一规范路径再次打开定位已有标签并刷新；同名不同路径可并存。切换 Tab 保留页面及播放位置，隐藏或收起时暂停音视频，关闭移除该预览；刷新页面后从工具记录再次打开。

## 展示与格式

- 直接使用浏览器 `img` / `video controls` / `audio controls`。音视频不自动播放，使用 metadata 预加载；视频支持浏览器原生进度、音量与全屏控件。图片按容器等比显示，随通用 Tab 放大或收起。
- 图片入口覆盖 JPEG、PNG、WebP、GIF、AVIF、BMP、ICO、SVG；视频覆盖 MP4/M4V、WebM、MOV、OGV；音频覆盖 MP3、WAV、OGG/OGA/Opus、FLAC、M4A、AAC。浏览器能否解码取决于文件的实际编码和运行平台；失败显示明确提示，可重新加载，不转码、不抽帧、不安装 FFmpeg。
- 文件名、路径及 MIME 保留原文。界面使用独立 `media-preview.ts` 双语目录和主题语义变量；媒体内容不交给 Markdown 或 Highlight.js，不插入 HTML/iframe。
- 元数据请求按 Session、路径与修订号隔离，刷新先隐藏旧媒体；切换/卸载中止旧请求，忽略迟到结果。播放器只从受控 API URL 获取资源，不使用 `file://`、客户端提供的外部 URL 或全文件 Blob 缓冲。

## HTTP 与文件边界

```http
GET /api/sessions/:id/media-preview?path={encodedPath}
GET /api/sessions/:id/media-preview/content?path={encodedPath}
HEAD /api/sessions/:id/media-preview/content?path={encodedPath}
```

- 元数据返回 `{ path, name, kind, mimeType, size, modifiedAt }`；读取当前磁盘文件，不保存历史版本。文件须在当前 Session 有效工作目录内；相对路径按 `workDir ?? localCwd` 解析，缺失 Session、越界、目录、普通符号链接和特殊文件继续拒绝。
- 文本和媒体仅共用 `open-local-preview-file.ts` 的文件系统边界：词法根检查、lstat/realpath、NOFOLLOW/NONBLOCK、打开后普通文件及 inode/device 复核。macOS 只将系统 `/tmp`、`/var`、`/etc` 别名规范到 `/private/...` 后再检查，不把任意 realpath 差异视为允许；用户创建的链接仍拒绝。文本解码、1 MiB 上限和二进制拒绝独立保留。
- 媒体按扩展名白名单返回明确 MIME，并设置 `no-store`、`nosniff` 和 `default-src 'none'; sandbox`；不执行 SVG 或其他文件内的脚本，不提供任意文件通用内容出口。未知类型返回本地化 415。
- GET 支持单段 `bytes=start-end`、开放末尾和后缀范围，返回 206/Content-Range；非法、多段或越界范围返回 416，HEAD 返回完整元数据头但无正文。没有可验证版本的 If-Range 请求回退完整 200。无 Range 时流式 200，空文件返回空正文。
- 文件流使用 64 KiB 块与有界队列，取消、断开及流结束由原 Node HTTP/Readable 链路释放句柄；不继承文本的 1 MiB 或附件上传的 20 MiB 限制，也不把整个视频读入 Node/前端内存。

## 入口与验证

| 职责 | 源码 |
|---|---|
| 媒体类型及元数据 | `packages/ssh-agent/src/domain/media-preview.ts` |
| Session 解析及媒体访问 | `packages/ssh-agent/src/application/services/media-preview-service.ts` |
| 共享的普通文件打开及系统别名 | `packages/ssh-agent/src/application/services/open-local-preview-file.ts` |
| 元数据、流、HEAD/Range | `packages/ssh-agent/src/api/media-preview-routes.ts` |
| 工具入口与装配 | `packages/ssh-agent-web/features/chat/model/tool-preview-file.ts`、`components/chat-message.tsx`、`components/chat-console.tsx` |
| 独立预览模块 | `packages/ssh-agent-web/features/media-preview/` |
| 回归 | `packages/ssh-agent/test/media-preview-api.test.ts`、`packages/ssh-agent-web/tests/media-preview.test.tsx`、`media-preview-runtime.test.ts`、`file-reader-runtime.test.tsx` |

测试使用临时文件、隔离 SQLite 和模拟模型目录，无真实 SSH 或模型调用。浏览器使用实际工具行、TaskContainer、Reader/Media 页面及真实本地媒体流，验证 PNG、WAV、WebM、进度跳转、文本共存、同路径定位与悬浮查看；macOS 别名有实机回归。其他平台和所有编码组合不视为已经验证。

浏览器格式边界参考 [MDN media formats](https://developer.mozilla.org/en-US/docs/Web/Media/Guides/Formats)，分段读取参考 [MDN HTTP Range](https://developer.mozilla.org/en-US/docs/Web/HTTP/Guides/Range_requests)。
