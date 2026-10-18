# Composer 本地文件检索

适用于已有 Session 的 `@` 文件名/目录检索、匹配排序、候选索引复用、取消和性能预算。普通目录浏览与文件读取的边界见 [local-file-system.md](./local-file-system.md)。不读取文件正文，不调用模型、SSH 或 SFTP。

## 架构与取舍

原实现由浏览器逐目录调用列表 API，最多扫描 800 个目录、收集到 80 个匹配就停止，之后才排序；深层文件可能未访问，较好的匹配也可能被早期弱匹配挤掉。新实现分为后端候选收集、可复用索引、全局评分与有限结果投影，浏览器每个防抖后的查询只发送一个请求。

- 参考 [VS Code FileWalker](https://github.com/microsoft/vscode/blob/main/src/vs/workbench/services/search/node/fileSearch.ts) 将候选收集与评分拆开，参考其 [fuzzyScorer](https://github.com/microsoft/vscode/blob/main/src/vs/base/common/fuzzyScorer.ts) 的文件名/路径优先级；参考 [fzf 算法说明](https://github.com/junegunn/fzf/blob/master/src/algo/algo.go) 的连续匹配和间隔惩罚。当前评分为独立实现，不复制上述源码，不引入全文搜索或编辑距离矩阵。
- 使用 Node 异步 `opendir`、64 条缓冲和 Dirent 类型，不为每个候选 stat；只复核准备返回的少量候选。索引预先计算 Unicode NFKC、大小写、无扩展名、单词首字母和边界等信息。扫描及评分每 256 项让出事件循环，避免整树同步排序/评分占住后端。
- 不依赖用户机器安装 `rg`，也不引入需要额外分发的原生二进制。采用精确版本 `ignore` 解析 `.gitignore`/`.ignore`，不自行实现 glob 语法。默认剪去依赖、构建产物及缓存目录；项目否定规则可以覆盖默认忽略。递归遍历不跟随符号链接，自动收集始终跳过 VCS 内部目录。
- 不为整个仓库创建常驻递归 watcher，避免大型依赖树消耗监听资源；候选索引有效期为构建完成后 10 秒，过期在下次查询时重建，也可手动刷新。新增/改名可能在有效期内尚未进入索引；已删除或改为符号链接的返回候选即时剔除。这个刷新窗口是明确取舍，不是实时索引承诺。

## 缓存、并发与边界

- 索引归 `DefaultLocalFileSystemService` 所有；缓存键为规范目录与 `includeIgnored`，同目录不同 Session 可共享收集任务，响应路径仍相对各自当前工作目录。每次请求先查 Session 的 `workDir ?? localCwd` 并验证根目录，修改 Session 目录不会复用旧根。
- 同键并发冷查询共享一个构建；单个请求取消只结束自身等待。最后一个消费者离开后保留 500ms 交接窗口供下一次防抖查询复用，仍无人接手则中止构建并移除部分索引。最多两个构建同时工作，其他已接受请求可取消地等待；最多四个缓存键，按 LRU 淘汰。四个键全部仍有活跃构建消费者时，新键请求返回 503，不扩张缓存或取消他人的构建。
- 每次构建最多检查 100,000 条目录项、访问/排队 25,000 个目录、累计 8,000,000 个相对路径字符；每个异步边界检查 5 秒软时间预算。异步文件系统调用本身不提供硬中断期限。达到预算、子目录无法读取或忽略文件无法安全读取时返回 `incomplete=true`，不能显示成确认不存在。
- `.gitignore`/`.ignore` 每文件最多读取 64 KiB，只读普通、无符号链接文件；项目根以外的祖先/全局 Git ignore、`.rgignore`、Git 已跟踪文件例外不参与当前规则。包含忽略文件模式绕过默认与项目忽略，仍保持 VCS 自动剪枝、Session 根与资源预算。
- 查询含存在的准确目录前缀时，仅为该子目录收集候选，输出仍相对 Session 根；显式目录也允许定位被默认忽略的目录，不先遍历无关模块。不存在的目录前缀作为路径片段匹配。词法越界与符号链接目录拒绝，不通过放宽工作目录补召回。

## 匹配与响应

```http
GET /api/sessions/:sessionId/local-files/search?query={encodedQuery}&includeIgnored=true&refresh=true
```

`includeIgnored/refresh` 可省略，显式只接受 `true/false`；query 最多 512 字符，不含 NUL。空查询返回空结果，不启动递归索引。成功 `200`，响应为 `{ entries: LocalFileEntry[], truncated: boolean, incomplete: boolean }`，使用 `Cache-Control: no-store`。异常沿用公开错误/Locale 结构。

- 普通查询按文件名完全相同、无扩展名相同、前缀、连续片段、单词缩写、去分隔符、边界起始的非连续匹配、父路径片段依次排序。非连续匹配不借用扩展名补字符；短查询使用字面/缩写匹配，减少弱结果。路径查询优先完整路径、后缀与连续路径，再用非连续匹配。支持大小写忽略、中文、组合 Unicode 和 Windows 路径分隔符。
- 每次对当前完整候选集评分，以有限有序队列保留最好的候选，再复核真实路径、普通类型及元数据，返回最多 80 项；不会收集到 80 项就停止遍历。`truncated` 表示有额外匹配（也可能含复核时已失效的缓存候选），`incomplete` 独立表达收集不完整。
- 浏览器 `use-local-file-search.ts` 独立持有 180ms 防抖、Query/Session/忽略模式身份、取消和过期响应保护。切换查询立即清除旧候选，迟到响应即使忽略 Abort 也不能覆盖当前结果。菜单显示全部返回的最多 80 项，可滚动及键盘选择；结果超限、收集不完整各有提示，并提供“包含忽略文件”和“刷新文件列表”。
- 空 `@` 保留目录浏览，新 Session 创建前仍使用系统目录列表而不递归整个系统。目录浏览也延迟 180ms，快速输入文件名可取消未发出的列表请求；最多渲染 80 项并提示输入检索更多，不在加载时选择旧目录候选。原 `/` 工具、图片粘贴、IME 组合及 file/folder Token 提交流程保持原入口。

## 入口与验证

| 职责 | 源码 |
|---|---|
| 当前 Session 根、HTTP 契约 | `packages/ssh-agent/src/application/services/local-file-system-service.ts`、`packages/ssh-agent/src/domain/local-file-system.ts`、`packages/ssh-agent/src/api/http-handler.ts` |
| 有界索引、缓存、合并等待与取消 | `packages/ssh-agent/src/application/services/local-file-search-index.ts` |
| 名称准备和独立匹配规则 | `packages/ssh-agent/src/application/services/local-file-search-ranking.ts` |
| 前端请求与生命周期 | `packages/ssh-agent-web/features/chat/api/local-files-api.ts`、`runtime/use-local-file-search.ts` |
| 菜单装配、空/部分状态 | `packages/ssh-agent-web/features/chat/components/chat-token-editor.tsx`、`model/chat-composer-menu.ts` |
| 后端定向回归 | `packages/ssh-agent/test/local-file-search.test.ts`、`local-file-system-api.test.ts` |
| 前端请求、竞态、触发器与国际化 | `packages/ssh-agent-web/tests/local-file-search-runtime.test.ts`、`chat-composer.test.ts`、`chat-composer-menu.test.ts`、`chat-token-editor.test.ts`、`i18n-state.test.tsx` |

测试使用临时目录、隔离 SQLite 和模拟 HTTP。真实会话工作目录只读重放已经确认目标 Java 文件在完整名称与缩写查询中排名第一；另用 20,001 文件临时树验证冷/热查询和事件循环延迟。性能数字取决于本机缓存、目录结构和磁盘，不代表跨平台浏览器或真实 SSH 验收；没有对会话数据库写入或调用模型。
