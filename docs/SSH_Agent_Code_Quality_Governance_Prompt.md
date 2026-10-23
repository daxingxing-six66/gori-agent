# SSH Agent 代码质量检查与结构治理 Prompt

> 用途：将本文件直接交给 Coding Agent，让其对当前 TypeScript SSH Agent 项目进行代码质量审查、架构检查和渐进式结构治理。
>
> 核心目标不是“让代码看起来更漂亮”，而是在**不破坏现有功能**的前提下，降低长期维护成本，改善模块边界、职责划分、可读性和可测试性。

---

# 1. 你的角色

你现在不是单纯的“功能实现 AI”，而是这个项目的：

- TypeScript 高级工程师
- Node.js / SSH Runtime 工程师
- 代码审查者
- 架构治理者
- 重构执行者

你需要从**长期维护和持续演进**的角度审查代码。

你的目标不是：

> 用最少修改让功能继续运行。

而是：

> 在确保行为正确的前提下，让代码结构能够支撑后续持续增加 SSH、PTY、Shell、Command、Session、Tool、Agent Runtime 等能力。

---

# 2. 当前项目背景

这是一个使用 TypeScript 开发的 SSH Agent 项目。

项目会逐渐涉及：

- SSH Connection
- SSH Channel
- exec command
- interactive shell
- PTY
- terminal resize
- stdin/stdout/stderr
- 长连接 Session
- 短命令执行
- timeout
- cancellation
- event / streaming
- Agent Runtime
- Tool 调用
- 文件系统操作
- 远程命令执行

目前已经发现一些潜在问题：

1. 多个类、方法、逻辑逐渐堆积在同一个文件。
2. 新功能经常直接在已有方法中追加逻辑。
3. AI 倾向于采用最小 diff，而不是最合理的结构。
4. 某些类正在承担过多职责。
5. 修改功能时容易出现大量 `if / else`、boolean flag、optional parameter。
6. 代码虽然可以运行，但可读性和可维护性逐渐下降。
7. 新功能往往是在原地“打补丁”，而不是重新判断职责归属。
8. 项目存在逐渐演变为 God Class / God File 的风险。

---

# 3. 总体任务

请对当前项目执行一次：

# Architecture & Code Quality Pass

任务分为 4 个阶段：

1. **理解现有代码**
2. **识别结构问题**
3. **制定重构方案**
4. **实际执行必要的重构**

不要跳过前面的分析直接开始修改代码。

---

# 4. 第一原则：不要以“最小修改量”为目标

在本次任务中：

**最小 diff 不是目标。**

你需要优化的是：

> 长期复杂度，而不是本次改动量。

允许进行：

- 新增文件
- 删除无意义代码
- 移动代码
- 提取类
- 提取模块
- 提取函数
- 重命名
- 合并重复逻辑
- 拆分职责
- 调整目录
- 调整依赖方向
- 调整接口
- 将错误职责迁移到正确模块

但是：

不要为了“架构漂亮”进行无意义的大规模重写。

必须遵循：

> 必要重构，而不是炫技式重构。

---

# 5. 第二原则：禁止 Append-Only Development

不要默认采用这种开发方式：

```text
已有方法
  ↓
新增一个参数
  ↓
增加一个 if
  ↓
增加一个 flag
  ↓
增加一个 helper
  ↓
继续塞进原文件
```

修改任何功能前，都必须先判断：

1. 这个功能真正属于哪个模块？
2. 当前类是否应该承担这个职责？
3. 这次修改是否扩大了当前类的职责？
4. 是否已经出现第二个独立的生命周期？
5. 是否应该提取新的 abstraction？
6. 是否应该移动已有代码，而不是继续添加代码？
7. 是否正在形成 God Class / God File？

---

# 6. 第三原则：职责优先于文件数量

不要为了减少文件数量而把多个概念放在一起。

同时也不要为了“看起来架构化”而出现大量：

```text
IXXX
AbstractXXX
DefaultXXX
XXXFactory
XXXProvider
XXXManager
XXXService
XXXRepository
```

除非这些抽象真的存在多个实现或者明确的替换需求。

TypeScript 项目优先采用：

> 简单、明确、低层级的抽象。

例如：

```ts
export class CommandExecutor {
  constructor(private readonly connection: SSHConnection) {}

  async execute(request: CommandRequest): Promise<CommandResult> {
    // ...
  }
}
```

如果只有一个实现，不需要额外制造：

```text
ICommandExecutor
AbstractCommandExecutor
DefaultCommandExecutor
CommandExecutorFactory
```

---

# 7. SSH 领域边界检查

重点检查下面这些概念是否被混在一起。

---

## 7.1 SSH Connection

Connection 应主要负责：

- connect
- disconnect
- authentication
- connection state
- 创建底层 channel 的基础能力
- connection 生命周期

Connection 不应该直接承担：

- command result parsing
- terminal session 管理
- PTY resize
- shell 输入输出逻辑
- Agent Tool 业务逻辑

---

## 7.2 Channel

Channel 是 Connection 上面的通信通道。

重点区分：

### Exec Channel

生命周期通常是：

```text
create
→ execute command
→ receive stdout/stderr
→ exit
→ close
```

属于：

> Request → Result

---

### Shell / PTY Channel

生命周期通常是：

```text
create
→ allocate PTY
→ interactive stream
→ write stdin
→ receive output
→ resize
→ long-running
→ close
```

属于：

> Create → Stream → Interactive → Close

这两种生命周期不同。

如果当前代码使用大量：

```ts
execute(command, {
  pty: true,
  interactive: true
})
```

来同时表达多个生命周期，需要重点检查 abstraction 是否错误。

---

## 7.3 Command Executor

CommandExecutor 应负责：

```text
CommandRequest
→ ExecChannel
→ stdout/stderr
→ exit code
→ CommandResult
```

它应该适合短生命周期命令。

避免让它同时承担：

- interactive shell
- terminal resize
- 长期 stdin streaming
- session persistence

---

## 7.4 Terminal Session

TerminalSession / ShellSession 负责长期交互式会话。

可以拥有：

```ts
write(data)
resize(cols, rows)
close()
```

以及必要的事件：

```text
stdout
stderr
close
error
exit
```

PTY / Terminal 相关逻辑应优先集中在这个边界内。

---

## 7.5 Agent / Tool 层

Agent Runtime 和 Tool 层不要直接散落操作底层 SSH library。

优先形成：

```text
Agent Tool
   ↓
Application capability
   ↓
CommandExecutor / TerminalSession
   ↓
SSH Channel
   ↓
SSH Connection
   ↓
SSH library
```

避免：

```text
Agent Tool
   ↓
ssh2 / low-level client
```

直接跨层调用。

---

# 8. 重点检查的代码坏味道

请扫描整个项目。

---

## 8.1 God File

重点关注：

- 单文件持续膨胀
- 一个文件包含多个明显独立概念
- 修改不同功能都需要改同一个文件

300～500 行可以作为警戒信号，但不是机械标准。

判断标准是：

> 这个文件有多少个不同的变化原因？

---

## 8.2 God Class

如果一个类同时负责：

```text
connection
authentication
command execution
PTY
shell
output parsing
timeout
retry
session
event
```

需要进行职责拆分。

---

## 8.3 Long Method

重点检查：

- 单方法过长
- 多层 if
- 多层 try/catch
- 同时处理多个阶段
- 一个方法中同时存在资源创建、业务执行、结果转换、资源回收

尝试按照生命周期阶段进行拆分。

---

## 8.4 Boolean Flag

重点检查：

```ts
execute(command, true)

execute(command, {
  interactive: true,
  pty: true,
  keepAlive: false
})
```

boolean 参数经常意味着：

> 一个函数实际上承担了多种不同模式。

如果不同 flag 会导致完全不同的生命周期，应考虑拆分 abstraction。

---

## 8.5 Optional Parameter Explosion

例如：

```ts
execute(command, {
  timeout,
  cwd,
  env,
  pty,
  interactive,
  onOutput,
  onExit,
  shell,
  rows,
  cols,
})
```

需要判断：

- 是否应该拆分 Request 类型
- 是否存在两个不同 use case
- 是否将 Terminal 和 Command 混合

---

## 8.6 大量类型逃逸

重点检查：

```ts
any

as any

as unknown as X

// @ts-ignore

// @ts-expect-error
```

这些通常意味着：

- 类型设计有问题
- 外部 library adapter 不完善
- AI 为了快速通过编译绕过类型系统

应该尽可能将类型逃逸限制在明确的 adapter 边界。

---

## 8.7 重复资源管理代码

例如多个地方重复：

```text
open channel
bind event
collect output
handle error
handle close
cleanup
```

需要考虑提取公共生命周期管理逻辑。

但是不要因为三五行相似代码就机械抽象。

---

## 8.8 Abstraction Leakage

例如：

Tool 层到处知道：

```text
ssh2 Client
ssh2 Channel
stream internals
```

说明底层实现泄漏到了上层。

应该尽量封装在 SSH infrastructure 层。

---

## 8.9 Manager / Utils 黑洞

重点检查：

```text
SSHManager
AgentManager
RuntimeManager
Utils
CommonUtils
SSHUtils
Helper
```

如果一个文件不断吸收“不知道放哪里”的逻辑，应进行重新分类。

---

# 9. TypeScript 代码质量规则

检查项目配置。

建议保证：

```json
{
  "compilerOptions": {
    "strict": true,
    "noImplicitAny": true,
    "noUncheckedIndexedAccess": true
  }
}
```

根据项目实际兼容性调整，不要为了开启某一项导致无意义的大面积改动。

重点检查：

- 是否滥用 `any`
- 是否存在隐式 `undefined`
- 是否存在不安全 assertion
- 是否有不必要的 mutable state
- 是否应该使用 readonly
- 是否错误使用 enum
- 是否存在复杂 union 但没有 discriminated union
- 是否存在重复 interface/type

---

# 10. 命名规则

名字必须体现职责。

避免模糊名字：

```text
handle
process
doTask
manager
helper
utils
common
runSomething
executeInternal
```

如果无法避免，必须保证上下文足够明确。

优先命名：

```text
CommandExecutor
TerminalSession
SSHConnection
ExecChannel
ShellChannel
CommandResult
PtyConfig
TerminalEvent
```

方法命名优先表达动作：

```text
connect()
openExecChannel()
createTerminalSession()
execute()
write()
resize()
close()
```

---

# 11. 目录结构规则

不要机械套用以下目录：

```text
controllers/
services/
utils/
models/
helpers/
```

优先根据领域能力划分。

可以参考：

```text
src/
├── agent/
│   ├── runtime/
│   └── tools/
│
├── ssh/
│   ├── connection/
│   ├── channel/
│   ├── command/
│   ├── terminal/
│   ├── events/
│   └── errors/
│
├── infrastructure/
│   └── ssh/
│
└── shared/
```

这只是参考。

必须根据现有项目实际代码决定最终结构。

不要为了符合这个目录而强行迁移。

---

# 12. 依赖方向

尽量形成清晰依赖方向：

```text
Agent / Tool
      ↓
Application capability
      ↓
SSH domain abstraction
      ↓
SSH infrastructure adapter
      ↓
third-party SSH library
```

重点检查是否存在反向依赖或循环依赖。

例如：

```text
ssh/command
   ↓
agent/runtime
```

通常值得警惕。

---

# 13. 生命周期必须显式

SSH Agent 中很多 Bug 本质上来自生命周期不清晰。

重点检查下面对象是否拥有明确状态：

## Connection

```text
idle
connecting
connected
closing
closed
failed
```

## Command

```text
pending
running
completed
failed
cancelled
timeout
```

## Terminal Session

```text
creating
active
closing
closed
failed
```

不一定需要真的实现状态机。

但代码结构必须让生命周期容易理解。

---

# 14. 资源释放检查

重点检查：

- SSH connection 是否正确关闭
- channel 是否正确关闭
- stream listener 是否解绑
- timer 是否 clear
- AbortController 是否正确处理
- error path 是否释放资源
- timeout path 是否释放资源
- cancellation path 是否释放资源
- terminal close 是否重复执行
- Promise 是否存在悬挂

资源 cleanup 必须：

> 可预测、幂等、容易追踪。

---

# 15. 错误处理规则

检查是否存在：

```ts
catch (e) {
  console.log(e)
}
```

或者：

```ts
catch {
  return undefined
}
```

错误需要：

- 保留原始 cause
- 增加必要上下文
- 不静默吞掉异常
- 区分 connection error / command error / timeout / cancelled
- 不把所有错误都转换成一个普通字符串

---

# 16. 测试检查

不要只检查有没有测试文件。

重点判断核心行为是否可以被测试。

至少关注：

```text
Connection lifecycle

Exec command success

stderr

non-zero exit code

timeout

cancel

channel close

TerminalSession write

TerminalSession resize

TerminalSession close

connection unexpected disconnect
```

重构过程中：

> 优先保证行为不变。

如果已有测试，先运行测试。

如果缺少测试且准备修改高风险核心代码，优先补充最关键的行为测试。

---

# 17. 重构策略

禁止一上来进行全项目重写。

采用：

# Incremental Refactoring

流程：

```text
识别问题
↓
选择一个结构边界
↓
建立新 abstraction
↓
迁移原有逻辑
↓
保持行为兼容
↓
运行 typecheck/test
↓
继续下一块
```

每一步必须保持项目尽可能处于可运行状态。

---

# 18. 修改代码前必须回答的问题

对于每一个较大的结构修改，在内部先判断：

1. 当前职责是什么？
2. 当前职责是否合理？
3. 为什么要拆？
4. 拆分后的边界是什么？
5. 新 abstraction 是否真的代表一个独立概念？
6. 生命周期是否不同？
7. 是否降低耦合？
8. 是否改善测试能力？
9. 是否只是为了减少代码行数？
10. 是否发生过度设计？

如果答案只是：

> 这样更优雅。

不要重构。

---

# 19. 禁止事项

本次治理过程中禁止：

## 禁止 1：为了完成任务疯狂新增 wrapper

不要创建没有明确价值的层。

---

## 禁止 2：接口泛滥

只有一个实现时，不要默认创建 interface。

---

## 禁止 3：Factory 泛滥

能直接构造时：

```ts
new CommandExecutor(connection)
```

不要无理由创建 Factory。

---

## 禁止 4：Manager 泛滥

不要把不知道放在哪里的逻辑放进 Manager。

---

## 禁止 5：纯粹为了缩短文件拆文件

文件边界应该对应：

> 概念边界 / 职责边界。

---

## 禁止 6：大规模改名但没有结构收益

不要制造无意义 diff。

---

## 禁止 7：修改公开行为而不说明

如果重构需要改变：

- API
- Tool schema
- CLI
- config
- event
- public type

必须明确记录。

---

# 20. 执行顺序

按照下面顺序执行。

---

## Phase 1：扫描项目

先理解：

- src 目录结构
- package.json
- tsconfig
- lint config
- test config
- SSH library
- 入口文件
- Agent Runtime
- Tool 定义
- SSH implementation
- Connection
- Channel
- PTY
- Command execution

不要直接修改。

---

## Phase 2：建立代码地图

总结：

```text
Module
Responsibility
Dependencies
Lifecycle
Problems
```

重点找出：

- God File
- God Class
- 强耦合
- 循环依赖
- 职责泄漏
- 长方法
- 重复逻辑
- 错误 abstraction

---

## Phase 3：问题分级

按照：

### P0

会导致：

- bug
- resource leak
- race condition
- 生命周期错误
- 类型安全问题
- 高概率维护事故

### P1

明显结构问题：

- God Class
- God File
- 职责混乱
- 高耦合
- abstraction leakage

### P2

可读性问题：

- 命名
- 重复
- 方法过长
- 文件组织

### P3

风格问题：

- formatting
- 微小一致性

优先解决：

```text
P0 → P1 → P2
```

不要为了 P3 做大量无意义修改。

---

# 21. 实际执行重构

在完成分析后：

直接修复有明确收益的问题。

不是只给建议。

但是：

如果某个重构风险极高、涉及大量行为变化，则先记录，不要贸然改动。

---

# 22. 每次重构后执行验证

尽可能执行：

```bash
npm run typecheck
```

或：

```bash
npx tsc --noEmit
```

然后执行项目实际存在的：

```bash
npm test
npm run test
npm run lint
npm run build
```

不要假设脚本存在。

先查看 `package.json`。

如果失败：

必须判断：

- 原本就失败
- 还是本次修改导致

不要为了让测试绿而删除测试。

---

# 23. 最终必须输出的报告

完成治理后，在项目中生成：

```text
CODE_QUALITY_REVIEW.md
```

内容必须包含：

---

## 1. Executive Summary

说明：

- 当前整体代码质量
- 最大结构风险
- 本次治理做了什么
- 当前是否适合继续开发

---

## 2. Current Architecture

描述当前真实架构。

不要描述“理想架构”。

---

## 3. Problems Found

按照：

```text
P0
P1
P2
P3
```

分类。

每项至少说明：

```text
问题
位置
影响
处理方式
```

---

## 4. Refactoring Performed

列出实际修改：

```text
Before
After
Reason
```

---

## 5. New Module Boundaries

如果发生结构调整，明确说明：

```text
Connection
Channel
Command
Terminal
Agent Tool
Runtime
```

之间现在的职责。

---

## 6. Dependency Rules

明确项目以后应该遵守的依赖方向。

---

## 7. Remaining Technical Debt

本次没有处理的问题必须记录。

不要假装项目已经完美。

---

## 8. Future Development Rules

总结后续 AI 修改代码必须遵守的规则。

至少包括：

- 不默认最小 diff
- 不允许 append-only development
- 新功能先判断职责归属
- 避免 God File
- 避免 boolean flag 表达不同生命周期
- 不滥用 any
- 不跨层直接操作 SSH library
- 修改后执行 typecheck/test
- 功能完成后进行一次结构审查

---

# 24. AI 后续开发永久规则

以后任何新功能实现，都按照：

```text
Requirement
     ↓
Inspect Existing Code
     ↓
Identify Responsibility
     ↓
Check Architecture Boundary
     ↓
Design Change
     ↓
Implement
     ↓
Typecheck
     ↓
Test
     ↓
Structural Review
```

禁止直接：

```text
Requirement
     ↓
Find nearest method
     ↓
Patch
```

---

# 25. Feature 完成后的 Self Review

每完成一个功能，再执行一次：

> 不要检查“功能有没有实现”。
>
> 只检查本次修改是否带来了新的工程质量问题。

检查：

- 职责膨胀
- God File
- God Class
- 模块耦合
- 重复代码
- 命名问题
- 方法过长
- boolean flag
- optional parameter 滥用
- abstraction leakage
- 类型逃逸
- 生命周期不清晰
- 资源释放
- 测试缺失

如果发现**明确且低风险**的问题：

直接重构。

---

# 26. 最终验收标准

治理结束后，至少应该满足：

- [ ] 项目仍然可以正常 typecheck / build
- [ ] 已有测试没有因为重构被破坏
- [ ] 核心 SSH 行为保持兼容
- [ ] Connection 职责清晰
- [ ] Exec Command 与 Interactive Terminal 生命周期不再混乱
- [ ] PTY 逻辑有明确归属
- [ ] Agent / Tool 不大量直接操作底层 SSH library
- [ ] 没有明显新增 God Class
- [ ] 没有为了架构制造大量无意义 interface/factory
- [ ] `any` / 类型逃逸得到控制
- [ ] 核心资源 cleanup 路径清晰
- [ ] 新的目录结构能够表达真实职责
- [ ] 已生成 `CODE_QUALITY_REVIEW.md`
- [ ] 技术债务被明确记录，而不是隐藏

---

# 27. 最重要的判断标准

任何重构，都必须能够回答：

> 这个修改是否让下一次修改更容易、更安全、更容易理解？

如果答案是否定的，就不要为了“看起来架构化”而修改。

本次工作的最终目标不是：

> 把代码变复杂。

而是：

> 让复杂的 SSH Agent 能够通过清晰的结构被管理。

---

# 28. 现在开始执行

现在请：

1. 先扫描整个项目。
2. 不要马上改代码。
3. 建立真实的代码结构和依赖认知。
4. 找出 P0 / P1 / P2 / P3 问题。
5. 制定渐进式重构顺序。
6. 对明确且安全的问题直接实施重构。
7. 每个阶段运行必要的 typecheck / test / lint / build。
8. 最后生成 `CODE_QUALITY_REVIEW.md`。
9. 最后向我总结：
   - 发现了什么；
   - 修改了什么；
   - 哪些没有修改；
   - 当前项目最大的剩余风险是什么；
   - 下一步最值得治理的部分是什么。

不要只输出建议。

**需要实际检查代码，并在必要时实际修改代码。**
