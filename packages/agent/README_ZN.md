# @earendil-works/pi-agent-core

支持工具执行和事件流的有状态智能体。基于 `@earendil-works/pi-ai` 构建。

## 安装

```bash
npm install @earendil-works/pi-agent-core
```

### SQLite 会话后端

SQLite 会话后端和 `node:sqlite` 适配器位于独立的 `@earendil-works/pi-session-backend-sqlite-node` 包中，因此核心包默认不会引入运行时内置模块或原生 SQLite 依赖。该后端接受与运行时相关的 SQLite 工厂，以便未来将其他会话后端作为独立包发布。

## 快速开始

```typescript
import { Agent } from "@earendil-works/pi-agent-core";
import { createModels } from "@earendil-works/pi-ai";
import { anthropicProvider } from "@earendil-works/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-6");
if (!model) throw new Error("Model not found");

const agent = new Agent({
  initialState: {
    systemPrompt: "You are a helpful assistant.",
    model,
  },
  streamFn: models.streamSimple.bind(models),
});

agent.subscribe((event) => {
  if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
    // 仅输出新增的文本块
    process.stdout.write(event.assistantMessageEvent.delta);
  }
});

await agent.prompt("Hello!");
```

## 核心概念

### AgentMessage 与 LLM 消息

智能体使用 `AgentMessage`。这是一种灵活的类型，可以包含：

- 标准 LLM 消息（`user`、`assistant`、`toolResult`）
- 通过声明合并添加的应用专用自定义消息类型

LLM 只能理解 `user`、`assistant` 和 `toolResult`。`convertToLlm` 函数在每次调用 LLM 前过滤和转换消息，从而衔接这两种消息类型。

### 消息流

```
AgentMessage[] → transformContext() → AgentMessage[] → convertToLlm() → Message[] → LLM
                    （可选）                             （必需）
```

1. **transformContext**：裁剪旧消息、注入外部上下文
2. **convertToLlm**：过滤仅供 UI 使用的消息，将自定义类型转换为 LLM 格式

## 事件流

智能体会发出用于更新 UI 的事件。了解事件顺序有助于构建响应迅速的界面。

### prompt() 事件顺序

调用 `prompt("Hello")` 时：

```
prompt("Hello")
├─ agent_start
├─ turn_start
├─ message_start   { message: userMessage }      // 你的提示词
├─ message_end     { message: userMessage }
├─ message_start   { message: assistantMessage } // LLM 开始响应
├─ message_update  { message: partial... }       // 流式文本块
├─ message_update  { message: partial... }
├─ message_end     { message: assistantMessage } // 完整响应
├─ turn_end        { message, toolResults: [] }
└─ agent_end       { messages: [...] }
```

### 包含工具调用时

如果助手调用工具，循环会继续：

```
prompt("Read config.json")
├─ agent_start
├─ turn_start
├─ message_start/end  { userMessage }
├─ message_start      { assistantMessage with toolCall }
├─ message_update...
├─ message_end        { assistantMessage }
├─ tool_execution_start  { toolCallId, toolName, args }
├─ tool_execution_update { partialResult }           // 如果工具支持流式输出
├─ tool_execution_end    { toolCallId, result }
├─ message_start/end  { toolResultMessage }
├─ turn_end           { message, toolResults: [toolResult] }
│
├─ turn_start                                        // 下一轮
├─ message_start      { assistantMessage }           // LLM 响应工具结果
├─ message_update...
├─ message_end
├─ turn_end
└─ agent_end
```

工具执行模式可配置：

- `parallel`（默认）：依次对工具调用进行预检，并发执行获准的工具；每个工具完成最终处理后立即发出 `tool_execution_end`，然后按照助手消息中的原始顺序发出 toolResult 消息和 `turn_end.toolResults`
- `sequential`：逐个执行工具调用，与之前的行为一致

在并行模式下，工具完成事件遵循实际完成顺序，但持久化的 toolResult 消息仍遵循助手消息中的原始顺序。

可以通过智能体配置中的 `toolExecution` 设置全局模式，也可以通过 `AgentTool` 上的 `executionMode` 为单个工具设置模式。如果一批调用中的任何工具将 `executionMode` 设为 `"sequential"`，则无论全局配置如何，整批调用都会按顺序执行。

`beforeToolCall` 钩子在 `tool_execution_start` 发出且参数通过验证与解析后运行。它可以阻止执行，并在被阻止的结果上附加 `terminate: true`。`afterToolCall` 钩子在工具执行完成后、发出 `tool_execution_end` 和最终工具结果消息事件前运行。

工具、被 `beforeToolCall` 阻止的结果以及 `afterToolCall` 覆盖结果都可以返回 `terminate: true`，提示系统跳过自动的后续 LLM 调用。只有当该批次中所有最终工具结果都设置了 `terminate: true` 时，循环才会提前停止。包含不同设置的批次会照常继续。

`Agent` 类通过 `AgentOptions` 接受 `shouldStopAfterTurn`。底层循环调用方可以在 `AgentLoopConfig` 中设置同一个钩子：

```typescript
const stream = agentLoop(
  prompts,
  context,
  {
    model,
    convertToLlm,
    shouldStopAfterTurn: async ({ message, toolResults, context, newMessages }) => {
      return shouldCompactBeforeNextTurn(context.messages);
    },
  },
  undefined,
  models.streamSimple.bind(models),
);
```

`shouldStopAfterTurn` 在发出 `turn_end` 且助手响应和所有工具执行均正常完成后运行。如果返回 `true`，循环会发出 `agent_end` 并退出，不再轮询引导消息或后续消息队列，也不会开始另一次 LLM 调用。它不会中止提供方的数据流，不会取消正在运行的工具，也不会更改助手消息的停止原因。`AgentOptions` 回调还会通过第二个参数收到当前运行的 `AbortSignal`。

使用 `Agent` 类时，助手的 `message_end` 处理会被视为工具预检开始前的一道屏障。这意味着 `beforeToolCall` 看到的智能体状态已经包含请求该工具调用的助手消息。

### continue() 事件顺序

`continue()` 从现有上下文恢复执行，不添加新消息。可用于在发生错误后重试。

```typescript
// 发生错误后，从当前状态重试
await agent.continue();
```

上下文中的最后一条消息必须是 `user` 或 `toolResult`，不能是 `assistant`。

### 事件类型

| 事件 | 说明 |
|-------|------|
| `agent_start` | 智能体开始处理 |
| `agent_end` | 本次运行的最终事件。等待此事件的订阅者仍计入运行完成条件 |
| `turn_start` | 新一轮开始（一次 LLM 调用和相应工具执行） |
| `turn_end` | 本轮完成，包含助手消息和工具结果 |
| `message_start` | 任意消息开始（user、assistant、toolResult） |
| `message_update` | **仅限助手消息。**包含带增量内容的 `assistantMessageEvent` |
| `message_end` | 消息完成 |
| `tool_execution_start` | 工具开始执行 |
| `tool_execution_update` | 工具以流式方式报告进度 |
| `tool_execution_end` | 工具执行完成 |

`Agent.subscribe()` 监听器按照注册顺序等待执行。`agent_end` 表示循环不会再发出事件，但 `await agent.waitForIdle()` 和 `await agent.prompt(...)` 只有在所有需要等待的 `agent_end` 监听器完成后才会结束。

## Agent 选项

```typescript
const agent = new Agent({
  // 初始状态
  initialState: {
    systemPrompt: string,
    model: Model<any>,
    thinkingLevel: "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
    tools: AgentTool<any>[],
    messages: AgentMessage[],
  },

  // 将 AgentMessage[] 转换为 LLM Message[]（使用自定义消息类型时必需）
  convertToLlm: (messages) => messages.filter(...),

  // 在 convertToLlm 前转换上下文（用于裁剪、压缩）
  transformContext: async (messages, signal) => pruneOldMessages(messages),

  // 引导模式："one-at-a-time"（默认）或 "all"
  steeringMode: "one-at-a-time",

  // 后续消息模式："one-at-a-time"（默认）或 "all"
  followUpMode: "one-at-a-time",

  // 必需的流式函数
  streamFn: models.streamSimple.bind(models),

  // 用于提供方缓存的会话 ID
  sessionId: "session-123",

  // 动态解析 API 密钥（适用于会过期的 OAuth 令牌）
  getApiKey: async (provider) => refreshToken(),

  // 工具执行模式："parallel"（默认）或 "sequential"
  toolExecution: "parallel",

  // 在参数通过验证后预检每个工具调用。可以阻止执行。
  beforeToolCall: async ({ toolCall, args, context }) => {
    if (toolCall.name === "bash") {
      return { block: true, reason: "bash is disabled", terminate: true };
    }
  },

  // 在发出最终工具事件前对每个工具结果进行后处理。
  afterToolCall: async ({ toolCall, result, isError, context }) => {
    if (toolCall.name === "notify_done" && !isError) {
      return { terminate: true };
    }
    if (!isError) {
      return { details: { ...result.details, audited: true } };
    }
  },

  // 在已完成一轮后、轮询排队消息前正常停止。
  shouldStopAfterTurn: async ({ context }, signal) => {
    return shouldCompactBeforeNextTurn(context.messages, signal);
  },

  // 为基于 token 的提供方自定义思考预算
  thinkingBudgets: {
    minimal: 128,
    low: 512,
    medium: 1024,
    high: 2048,
  },
});
```

## Agent 状态

```typescript
interface AgentState {
  systemPrompt: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  tools: AgentTool<any>[];
  messages: AgentMessage[];
  readonly isStreaming: boolean;
  readonly streamingMessage?: AgentMessage;
  readonly pendingToolCalls: ReadonlySet<string>;
  readonly errorMessage?: string;
}
```

通过 `agent.state` 访问状态。

为 `agent.state.tools = [...]` 或 `agent.state.messages = [...]` 赋值时，系统会先复制顶层数组再保存。修改返回的数组会直接修改智能体的当前状态。

流式处理期间，`agent.state.streamingMessage` 包含当前尚未完成的助手消息。

`agent.state.isStreaming` 会一直保持 `true`，直到本次运行完全结束，包括所有需要等待的 `agent_end` 订阅者执行完毕。

## 方法

### 提示

```typescript
// 文本提示
await agent.prompt("Hello");

// 包含图片
await agent.prompt("What's in this image?", [
  { type: "image", data: base64Data, mimeType: "image/jpeg" }
]);

// 直接传入 AgentMessage
await agent.prompt({ role: "user", content: "Hello", timestamp: Date.now() });

// 从当前上下文继续（最后一条消息必须是 user 或 toolResult）
await agent.continue();
```

### 状态管理

```typescript
agent.state.systemPrompt = "New prompt";
agent.state.model = getModel("openai", "gpt-4o");
agent.state.thinkingLevel = "medium";
agent.state.tools = [myTool];
agent.toolExecution = "sequential";
agent.beforeToolCall = async ({ toolCall }) => undefined;
agent.afterToolCall = async ({ toolCall, result }) => undefined;
agent.shouldStopAfterTurn = async ({ context }) => shouldCompactBeforeNextTurn(context.messages);
agent.state.messages = newMessages; // 顶层数组会被复制
agent.state.messages.push(message);
agent.reset();
```

### 会话与思考预算

```typescript
agent.sessionId = "session-123";

agent.thinkingBudgets = {
  minimal: 128,
  low: 512,
  medium: 1024,
  high: 2048,
};
```

### 控制

```typescript
agent.abort();             // 取消当前操作
await agent.waitForIdle(); // 等待操作完成
```

### 事件

```typescript
const unsubscribe = agent.subscribe(async (event, signal) => {
  if (event.type === "agent_end") {
    // 本次运行的最终屏障任务
    await flushSessionState(signal);
  }
});
unsubscribe();
```

## 引导消息与后续消息

引导消息允许你在工具运行期间打断智能体。后续消息允许你在智能体原本即将停止时安排额外工作。

```typescript
agent.steeringMode = "one-at-a-time";
agent.followUpMode = "one-at-a-time";

// 智能体正在运行工具时
agent.steer({
  role: "user",
  content: "Stop! Do this instead.",
  timestamp: Date.now(),
});

// 智能体完成当前工作后
agent.followUp({
  role: "user",
  content: "Also summarize the result.",
  timestamp: Date.now(),
});

const steeringMode = agent.steeringMode;
const followUpMode = agent.followUpMode;

agent.clearSteeringQueue();
agent.clearFollowUpQueue();
agent.clearAllQueues();
```

使用 `clearSteeringQueue`、`clearFollowUpQueue` 或 `clearAllQueues` 可以丢弃排队的消息。

一轮完成后检测到引导消息时：

1. 当前助手消息中的所有工具调用均已完成
2. 注入引导消息
3. LLM 在下一轮中响应

只有在没有更多工具调用和引导消息时，系统才会检查后续消息。如果队列中有后续消息，系统会注入这些消息并运行新一轮。

## 自定义消息类型

通过声明合并扩展 `AgentMessage`：

```typescript
declare module "@earendil-works/pi-agent-core" {
  interface CustomAgentMessages {
    notification: { role: "notification"; text: string; timestamp: number };
  }
}

// 现在是有效的消息
const msg: AgentMessage = { role: "notification", text: "Info", timestamp: Date.now() };
```

在 `convertToLlm` 中处理自定义类型：

```typescript
const agent = new Agent({
  streamFn: models.streamSimple.bind(models),
  convertToLlm: (messages) => messages.flatMap(m => {
    if (m.role === "notification") return []; // 过滤掉
    return [m];
  }),
});
```

## 工具

使用 `AgentTool` 定义工具：

```typescript
import { Type } from "typebox";

const readFileTool: AgentTool = {
  name: "read_file",
  label: "Read File",  // 用于 UI 显示
  description: "Read a file's contents",
  parameters: Type.Object({
    path: Type.String({ description: "File path" }),
  }),
  // 覆盖此工具的执行模式（可选）。
  // "sequential" 会强制整批调用逐个运行。
  // "parallel" 允许与其他工具调用并发执行。
  // 如果省略，则使用全局 toolExecution 配置。
  executionMode: "sequential",
  execute: async (toolCallId, params, signal, onUpdate) => {
    const content = await fs.readFile(params.path, "utf-8");

    // 可选：以流式方式报告进度
    onUpdate?.({ content: [{ type: "text", text: "Reading..." }], details: {} });

    // 可选：在这里添加 `terminate: true`，可在批次中每个最终工具结果
    // 均设置了相同属性时，跳过自动的后续 LLM 调用。
    return {
      content: [{ type: "text", text: content }],
      details: { path: params.path, size: content.length },
    };
  },
};

agent.state.tools = [readFileTool];
```

### 错误处理

工具失败时应**抛出错误**。不要将错误消息作为内容返回。

```typescript
execute: async (toolCallId, params, signal, onUpdate) => {
  if (!fs.existsSync(params.path)) {
    throw new Error(`File not found: ${params.path}`);
  }
  // 仅在成功时返回内容
  return { content: [{ type: "text", text: "..." }] };
}
```

抛出的错误会被智能体捕获，并以 `isError: true` 的工具错误形式报告给 LLM。

从 `execute()`、被阻止的 `beforeToolCall` 或 `afterToolCall` 返回 `terminate: true`，可提示智能体在当前工具批次后停止。只有当该批次中的每个最终工具结果都要求终止时，此提示才会生效。该提示仅在运行时有效；发出的 `toolResult` 对话记录消息仍是标准的 LLM 工具结果。

## 代理用法

对于通过后端代理请求的浏览器应用：

```typescript
import { Agent, streamProxy } from "@earendil-works/pi-agent-core";

const agent = new Agent({
  streamFn: (model, context, options) =>
    streamProxy(model, context, {
      ...options,
      authToken: "...",
      proxyUrl: "https://your-server.com",
    }),
});
```

## 底层 API

不使用 Agent 类、直接进行控制：

```typescript
import { agentLoop, agentLoopContinue } from "@earendil-works/pi-agent-core";

const context: AgentContext = {
  systemPrompt: "You are helpful.",
  messages: [],
  tools: [],
};

const config: AgentLoopConfig = {
  model: getModel("openai", "gpt-4o"),
  convertToLlm: (msgs) => msgs.filter(m => ["user", "assistant", "toolResult"].includes(m.role)),
  toolExecution: "parallel",  // 如果设置了单个工具的 executionMode，则由后者覆盖
  beforeToolCall: async ({ toolCall, args, context }) => undefined,
  afterToolCall: async ({ toolCall, result, isError, context }) => undefined,
};

const userMessage = { role: "user", content: "Hello", timestamp: Date.now() };

const streamFn = models.streamSimple.bind(models);
for await (const event of agentLoop([userMessage], context, config, undefined, streamFn)) {
  console.log(event.type);
}

// 从现有上下文继续
for await (const event of agentLoopContinue(context, config, undefined, streamFn)) {
  console.log(event.type);
}
```

这些底层流仅用于观察。它们会保持事件顺序，但不会等待异步事件处理完成后再进入后续的生产阶段。如果需要将消息处理作为工具预检前的屏障，请使用 `Agent` 类，而不是直接使用 `agentLoop()` 或 `agentLoopContinue()`。

## 许可证

MIT
