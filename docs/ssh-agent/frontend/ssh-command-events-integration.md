# SSH 命令 Tool 联调契约

## 业务背景

Agent 使用 `remote_server_call` 执行 Linux 命令。后端创建 Tool 时绑定 Session，再由 Session 解析 Workspace、Host Trust 和活动 Credential；模型与前端都不提交连接信息。

SSH 命令内部仍会经历排队、Guard、目标解析、Connection/Channel 获取和远端执行，但这些阶段只用于后端调度、持久化和审计，不进入 Tool `onUpdate`，也不作为前端状态协议。

## 前端事件

前端只消费 Pi Agent 已有的 Tool 生命周期：

```ts
type RemoteServerCallLifecycleEvent =
  | {
      type: "tool_execution_start";
      toolCallId: string;
      toolName: "remote_server_call";
      args: {
        command: string;
        cwd?: string;
        timeoutMs?: number;
      };
    }
  | {
      type: "tool_execution_end";
      toolCallId: string;
      toolName: "remote_server_call";
      result: RemoteServerCallResult;
      isError: boolean;
    };
```

UI 行为：

| 事件 | 展示 |
|---|---|
| `tool_execution_start` | 远程命令正在执行 |
| `tool_execution_end` 且 `isError=false` | 执行成功并展示最终输出 |
| `tool_execution_end` 且 `isError=true` | 执行失败并按 `details.failure` 展示原因 |

不应等待或处理 `tool_execution_update`。SSH Tool 不发送内部状态、stdout/stderr chunk 或 exit 中间事件。

## 最终结果

```ts
interface RemoteServerCallDetails {
  operationId: string;
  status:
    | "completed"
    | "failed"
    | "cancelled"
    | "blocked"
    | "uncertain";
  failure?: SshFailure;
  exitCode?: number;
  exitSignal?: string;
  outputTruncated: boolean;
}

interface RemoteServerCallResult {
  content: Array<{ type: "text"; text: string }>;
  details: RemoteServerCallDetails;
  terminate?: boolean;
}

interface SshFailure {
  code: string;
  category: string;
  phase: string;
  message: string;
  retryable: boolean;
  operationId?: string;
  sessionId?: string;
  workspaceId?: string;
  safeDetails?: Record<string, string | number | boolean>;
}
```

成功示例：

```json
{
  "type": "tool_execution_end",
  "toolCallId": "tool_01",
  "toolName": "remote_server_call",
  "isError": false,
  "result": {
    "content": [{ "type": "text", "text": "nginx is active\n" }],
    "details": {
      "operationId": "operation_01",
      "status": "completed",
      "exitCode": 0,
      "outputTruncated": false
    }
  }
}
```

失败示例：

```json
{
  "type": "tool_execution_end",
  "toolCallId": "tool_02",
  "toolName": "remote_server_call",
  "isError": true,
  "result": {
    "content": [
      {
        "type": "text",
        "text": "SSH authentication failed\nError code: authentication_failed\nCategory: authentication\nPhase: authenticate\nRetryable: false"
      }
    ],
    "details": {
      "operationId": "operation_02",
      "status": "failed",
      "failure": {
        "code": "authentication_failed",
        "category": "authentication",
        "phase": "authenticate",
        "message": "SSH authentication failed",
        "retryable": false,
        "operationId": "operation_02",
        "sessionId": "session_01",
        "workspaceId": "workspace_01"
      },
      "outputTruncated": false
    }
  }
}
```

## LLM 可见信息

LLM 只接收最终 Tool Result，不接收 SSH 内部状态。失败 `content` 保留准确的错误码、类别、阶段和 `retryable`，不能把认证失败、主机指纹不匹配等错误压缩成笼统的连接失败。

远端输出最多返回最后 64 KiB。超过持久化限制时，成功结果会注明早期输出已截断；失败结果在错误信息后附加可用的远端输出尾部。

## 约束

- `details.failure` 是稳定、安全的 SSH 失败，不是原始 ssh2 Error。
- `retryable=true` 只描述错误性质，不授权 UI 或 Agent 自动重放命令。
- `uncertain` 表示命令可能已经在远端执行，不得自动重放非幂等命令。
- `guard_blocked` 的结果带有 `terminate=true`，当前 Agent Run 会被终止。
- 内部 Operation 状态和事件继续写入 SQLite，但不属于前端联调协议。
