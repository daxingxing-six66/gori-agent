# Tool 流式更新协议

本文定义 Chat Run SSE 中 `tool_execution_update` 的前端协议。目标是让 Tool 保留通用的 `AgentToolResult.content/details`，同时避免把原始 Tool 领域数据直接暴露给浏览器。

## 事件边界

Agent Runtime 内部事件保持不变：

```ts
interface AgentToolResult<TDetails> {
  content: Array<TextContent | ImageContent>;
  details: TDetails;
}
```

Tool 可以在 `details` 中保留自己的状态，并通过保留字段 `details.update` 声明标准传输提示：

```ts
onUpdate({
  content: [{ type: "text", text: "Uploading: 512/1024 bytes" }],
  details: {
    status: "uploading",
    sourceFilePath: "/private/source.bin",
    update: {
      type: "progress",
      detail: {
        current: 512,
        total: 1024,
        unit: "bytes",
        message: "Uploading source.bin"
      }
    }
  }
});
```

`content`、`details.status` 和 `sourceFilePath` 仍只属于后端内部。SSE 转换层校验并重建 `details.update`，不会透传原始 `partialResult`。

## SSE Envelope

```text
event: tool_execution_update
data: {"type":"tool_execution_update","toolCallId":"call-1","toolName":"sftp_upload","update":{"type":"progress","detail":{"current":512,"total":1024,"unit":"bytes","message":"Uploading source.bin"}}}
```

TypeScript 契约：

```ts
interface ToolExecutionUpdateEventData {
  type: "tool_execution_update";
  toolCallId: string;
  toolName: string;
  update: ToolUpdate;
}

type ToolUpdate =
  | {
      type: "text";
      detail: {
        content: string;
        mode: "replace";
      };
    }
  | {
      type: "progress";
      detail: {
        current: number;
        total: number;
        unit: "bytes" | "items";
        message?: string;
      };
    }
  | {
      type: "status";
      detail: {
        status: "preparing" | "waiting_for_approval" | "running";
        message: string;
      };
    };
```

与旧协议相比，`tool_execution_update.data` 不再包含：

```text
args
partialResult
partialResult.content
partialResult.details
```

Tool 参数只在 `tool_execution_start.data.args` 中发送一次。权威终态仍由 `tool_execution_end.data.result` 提供，最终 `AgentToolResult` 协议没有变化。

## 更新类型

### text

```json
{
  "type": "text",
  "detail": {
    "content": "current complete command output",
    "mode": "replace"
  }
}
```

`mode="replace"` 表示 `content` 是当前完整快照。前端必须覆盖同一 `toolCallId` 的旧文本，不能追加。当前 Bash 使用该语义。

Tool 未声明合法的 `details.update` 时，后端会把 `content` 中所有文本块以换行连接，降级为 `text/replace`。空内容和仅图片内容不会产生 SSE update。

### progress

```json
{
  "type": "progress",
  "detail": {
    "current": 524288,
    "total": 1048576,
    "unit": "bytes",
    "message": "Uploading release.tar"
  }
}
```

约束：

- `current`、`total` 必须是有限的非负数字。
- `current <= total`。
- `unit` 当前只允许 `bytes` 或 `items`。
- 百分比由前端根据 `current / total` 计算；后端不发送重复的 `progressPercent`。
- `total=0` 表示空任务已经完成，前端应显示 100%。

### status

```json
{
  "type": "status",
  "detail": {
    "status": "waiting_for_approval",
    "message": "Waiting for overwrite approval"
  }
}
```

状态含义：

| status | 含义 |
|---|---|
| `preparing` | 校验输入、解析路径或执行其他准备工作 |
| `waiting_for_approval` | Tool 已暂停并等待人工审批 |
| `running` | 没有可量化进度的执行阶段 |

`completed`、`failed` 和 `cancelled` 不通过 status update 表示；前端必须以 `tool_execution_end` 为最终状态。

## SFTP 事件示例

`sftp_upload` 和 `sftp_download` 使用同一事件时序。两者的 `progress.detail.unit` 都是 `bytes`，区别只在 `message` 使用 `Uploading` 或 `Downloading`。

目标不存在时：

```text
tool_execution_start
tool_execution_update  status/preparing
tool_execution_update  progress 0/total bytes
tool_execution_update  progress current/total bytes
tool_execution_update  progress total/total bytes
tool_execution_end
```

需要覆盖审批时：

```text
tool_execution_start
tool_execution_update  status/preparing
tool_execution_update  status/waiting_for_approval
approval.requested
approval.resolved
tool_execution_update  progress 0/total bytes
tool_execution_update  progress total/total bytes
tool_execution_end
```

覆盖目标的结构化文件信息不属于通用 Tool update，也不会发送给前端。`approval.requested` 中的通用 `ToolApproval.description` 会直接说明本地或远程文件已存在以及继续执行将覆盖该文件；前端展示该字段即可，不应读取原始 `partialResult.details` 或按 `toolName` 自行拼接审批文案。

## 前端归约建议

前端按 `toolCallId` 保存最新 update：

```ts
tools[event.toolCallId] = {
  ...tools[event.toolCallId],
  latestUpdate: event.update
};
```

- `text`：用 `detail.content` 覆盖当前输出。
- `progress`：使用 `current`、`total` 和 `unit` 渲染进度；`message` 只作为辅助文案。
- `status`：显示阶段文案；`waiting_for_approval` 的按钮和最终审批状态仍由 Approval 事件驱动。
- 未识别的 `update.type` 应安全忽略，不能关闭 SSE。
- SSE 的 `id` 和 `Last-Event-ID` 负责顺序与重放，不需要在 update 中增加序号。

后端实现入口：

- `packages/ssh-agent/src/application/tool-update-protocol.ts`
- `packages/ssh-agent/src/application/services/chat-service.ts`
- `packages/ssh-agent/src/application/tools/sftp-upload-tool.ts`
- `packages/ssh-agent/src/application/tools/sftp-download-tool.ts`
