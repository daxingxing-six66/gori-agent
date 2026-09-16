# Java 开发者的 TypeScript 项目入门

## 从启动过程理解

`node scripts/start.mjs --setup` 先让 npm 按锁文件安装依赖，再编译后端和打包前端，最后启动两个进程。浏览器访问前端，前端通过 HTTP/SSE 请求后端，后端访问 SQLite、SSH 和模型供应商。

Node.js 是 JavaScript 的服务端运行环境，可以粗略类比 JVM。TypeScript 在 JavaScript 上增加类型检查；类型通常不会保留到最终运行文件中。类型检查不能代替 HTTP 输入校验，这就是后端仍然需要 request-validation.ts 的原因。

## 文件怎么看

| 名称 | 类比或解释 | 是否提交 |
| --- | --- | --- |
| package.json | 类似 pom.xml，声明依赖和命令 | 是 |
| package-lock.json | 精确记录直接和间接依赖及完整性摘要 | 是 |
| node_modules | npm 安装出的依赖目录 | 否 |
| tsconfig.json | 类型检查和编译配置 | 是 |
| .ts | TypeScript 代码 | 是 |
| .tsx | 可以写 JSX 的 TypeScript，通常用于 React UI | 是 |
| .mjs | 明确使用 ES module 的 JavaScript 脚本 | 是 |
| .d.ts | 类型声明，类似只包含 API 签名的接口描述 | 手写的提交，dist 中生成的不单独提交 |
| dist | 编译和打包结果，近似 target | 源码仓库不提交 |
| *.tsbuildinfo | 增量编译缓存 | 否 |
| .env.example | 配置变量示例，不能有真实秘密 | 是 |
| .env.local | 个人环境配置 | 否 |

## npm 命令

`npm ci` 严格按照现有锁文件安装，适用于别人克隆仓库和 CI；package.json 与锁文件不一致会失败。`npm install` 用于主动修改或解析依赖。`--ignore-scripts` 禁止依赖安装阶段执行生命周期脚本，不代表任何第三方包都不再有风险。

`npm run check` 中的 check 不是 npm 固有能力，而是本仓库 package.json 定义的命令。build、dev、start 也要看各个仓库的 scripts，不能假设所有项目含义一致。

workspace 类似 Maven 多模块：本项目保留五个包，npm 会把包之间的本地依赖连接起来。所以不能直接删掉 agent 目录而期望 SSH Agent 仍从本地加载它。

`private: true` 只禁止误发布 npm 包，不会让 GitHub 仓库变成私有，也不妨碍开源。

## 前端与后端

React 用组件组织界面，TSX 中的 JSX 描述组件结构。Vite/Vinext 负责开发服务和构建。Tailwind CSS 提供样式工具。SQLite 是嵌入式数据库，因此本机启动不需要额外安装 MySQL。

开发服务便于自动刷新；生产构建先生成可运行输出。支持源码启动不等于已提供桌面安装包。

`NEXT_PUBLIC_` 开头的环境变量可能进入浏览器代码，只能放公开配置，例如 API 地址，不能放模型 API Key、SSH 密码或加密密钥。

GitHub Pages 只托管介绍页等静态文件，不会替你启动 Node.js 后端，也不能直接连接 SSH。
