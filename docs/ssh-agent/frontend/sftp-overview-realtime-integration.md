# SFTP 与 Overview 实时联调契约

## 业务背景

SFTP 文件管理和服务器监控是 Workspace 级基础能力。它们直接解析 Workspace 的活动 Credential 和 Host Trust，并通过 Connection Pool 获取独立 Channel；不进入 Agent Tool、Session FIFO、Guard 或 LLM。文件内容只在浏览器、HTTP 流和 SFTP Channel 之间流动，不写入 SQLite，也不会发送给模型。

数据流：

```text
Frontend -> Workspace HTTP API -> Target Resolver -> Connection Pool -> SFTP/exec Channel -> Linux
Frontend <- Workspace SSE <- Event Hub <- Transfer Service / Metrics Collector / Connection Pool
```

每个 Workspace 最多一个 Metrics Collector。同一 Workspace 的多个 SSE 订阅共享采样结果；最后一个 monitoring 订阅离开 30 秒后释放 Collector。

## 公共 Schema

```ts
interface SftpDirectoryEntry {
  name: string;
  path: string;
  type: "file" | "directory" | "symlink" | "other";
  size: number;
  modifiedAt: number;       // Unix ms
  permissions: number;      // Unix mode，例如 0644 为 420
}

type TransferStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "uncertain";

interface FileTransfer {
  id: string;
  workspaceId: string;
  direction: "upload" | "download";
  remotePath: string;
  fileName: string;
  totalBytes: number;
  bytesTransferred: number;
  overwrite: boolean;
  status: TransferStatus;
  target: SshTargetSnapshot; // 不含 Secret
  failure?: { code: string; message: string; retryable: boolean };
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  updatedAt: number;
}

interface ApiErrorBody {
  error: {
    code: string;
    message: string;
    field?: string;
    details?: Record<string, unknown>;
  };
}
```

Transfer 只持久化六个业务状态。Channel 排队、字节传输和 rename 是 Service 内部阶段，不进入 HTTP、SQLite 或 SSE：

```text
pending -> running -> completed
   |          |----> failed
   |          |----> cancelled  (rename 发出前)
   |          `----> uncertain  (rename 发出后结果未确认)
   |----> cancelled
   `----> failed
```

`completed`、`failed`、`cancelled`、`uncertain` 是终态。服务启动时遗留的 `pending/running` 会转为 `failed`，failure code 为 `transfer_interrupted`。第一版不续传、不自动清理历史。

## SFTP HTTP API

### 查询目录

```http
GET /api/workspaces/{workspaceId}/sftp/entries?path=/opt/api/current
```

`path` 可省略，省略时使用 `workspace.defaultCwd`；提供时必须是绝对目录。条目按目录优先、名称升序返回。

```ts
interface ListDirectoryResponse {
  workspaceId: string;
  path: string; // realpath 后的路径
  entries: SftpDirectoryEntry[];
}
```

```json
{
  "workspaceId": "ws-1",
  "path": "/opt/api/current",
  "entries": [
    { "name": "config", "path": "/opt/api/current/config", "type": "directory", "size": 4096, "modifiedAt": 1787623200000, "permissions": 493 },
    { "name": "server.log", "path": "/opt/api/current/server.log", "type": "file", "size": 9017753, "modifiedAt": 1787623320000, "permissions": 420 }
  ]
}
```

### 创建上传 Transfer

```http
POST /api/workspaces/{workspaceId}/sftp/transfers
Content-Type: application/json

{ "direction": "upload", "remotePath": "/opt/api/current/release.tar.gz", "totalBytes": 34393292, "overwrite": false }
```

成功返回 `201 FileTransfer`，初始为 `pending` 和 `bytesTransferred: 0`。`overwrite` 默认 `false`。

同名冲突返回：

```http
HTTP/1.1 409 Conflict
```

```json
{
  "error": {
    "code": "file_already_exists",
    "message": "A file already exists at the remote path",
    "details": {
      "entry": { "name": "release.tar.gz", "path": "/opt/api/current/release.tar.gz", "type": "file", "size": 34393292, "modifiedAt": 1787623200000, "permissions": 420 }
    }
  }
}
```

前端展示名称、大小和修改时间。用户确认后创建一个新的 `overwrite:true` Transfer，不复用冲突请求。覆盖只允许 OpenSSH `posix-rename` 原子替换；服务器不支持时返回 `atomic_overwrite_unsupported`，不会先删除旧文件。

### 创建下载 Transfer

```http
POST /api/workspaces/{workspaceId}/sftp/transfers
Content-Type: application/json

{ "direction": "download", "remotePath": "/opt/api/current/server.log" }
```

后端通过 `lstat` 填充文件名和大小。只允许普通文件；目录返回 `cannot_download_directory`，符号链接或其他类型返回 `unsupported_file_type`。成功返回 `201 FileTransfer`。

### Transfer 列表

```http
GET /api/workspaces/{workspaceId}/sftp/transfers?limit=50
```

```ts
interface ListTransfersResponse { transfers: FileTransfer[] }
```

按 `createdAt` 倒序；默认 50，范围 1 到 100。

### 上传内容

```http
PUT /api/workspaces/{workspaceId}/sftp/transfers/{transferId}/content
Content-Type: application/octet-stream
Content-Length: 34393292

<raw bytes>
```

只接受属于当前 Workspace、方向为 upload、状态为 pending 的 Transfer。实际流字节数和 `Content-Length` 都必须等于创建时的 `totalBytes`，否则状态为 `failed` 并返回 `transfer_size_mismatch`。成功原子提交后返回最终 `FileTransfer`。

上传使用 XHR：`xhr.upload.onprogress` 表示浏览器发送到后端的进度；SSE `bytesTransferred` 表示远端 SFTP 已确认写入字节数，是权威进度。两者应分别标识，不能合并为一个含义。

### 下载内容

```http
GET /api/workspaces/{workspaceId}/sftp/transfers/{transferId}/content
```

```http
HTTP/1.1 200 OK
Content-Type: application/octet-stream
Content-Length: 9017753
Content-Disposition: attachment; filename*=UTF-8''server.log

<streamed bytes>
```

浏览器断开会取消读取 Channel，Transfer 进入 `cancelled`。完整写入 HTTP Response 后进入 `completed`。

### 取消

```http
POST /api/workspaces/{workspaceId}/sftp/transfers/{transferId}/cancel
```

返回当前 `FileTransfer`。pending 或 rename 前 running 进入 `cancelled`；rename 已发出但结果未确认时进入 `uncertain`；终态重复取消幂等。

### 删除

```http
DELETE /api/workspaces/{workspaceId}/sftp/file?path=/opt/api/current/server.log
```

成功返回 `204`。普通文件和符号链接允许删除；删除符号链接不跟随目标。目录返回 `cannot_delete_directory`，不存在返回 `file_not_found`。

文件类型与操作：

| 类型 | 进入 | 下载 | 删除 |
|---|---:|---:|---:|
| directory | 是 | 否 | 否 |
| file | 否 | 是 | 是 |
| symlink | 否 | 否 | 是 |
| other | 否 | 否 | 否 |

## Workspace SSE

```http
GET /api/workspaces/{workspaceId}/events?topics=monitoring,connection,transfers
Accept: text/event-stream
```

```text
id: 42
event: transfer.updated
data: {"id":"transfer-1","status":"running","bytesTransferred":1048576}

```

```ts
type WorkspaceEvent =
  | { type: "stream.ready"; data: { workspaceId: string; connectedAt: number } }
  | { type: "monitor.snapshot"; data: RemoteMetricsSnapshot }
  | { type: "monitor.error"; data: { sampledAt: number; code: string; message: string } }
  | { type: "connection.snapshot"; data: ConnectionPoolSnapshot }
  | { type: "transfer.updated"; data: FileTransfer };

interface ConnectionPoolSnapshot {
  workspaceId: string;
  state: "idle" | "connecting" | "connected" | "reconnecting" | "failed";
  activeChannels: number;
  waitingChannels: number;
  generation: number;
  connectedAt?: number;
  lastError?: { code: string; message: string };
}
```

topic 规则：Overview 使用 `monitoring,connection,transfers`；SFTP 页面使用 `connection,transfers`，不会启动 Collector。后端每 15 秒发送 comment heartbeat。事件不持久化，`Last-Event-ID` 只在当前进程内用于去重，不保证重放。重连收到 `stream.ready` 后，前端重新查询 Transfer 列表恢复历史终态；监控和连接使用后续最新快照。

## Overview 监控 Schema

```ts
interface RemoteMetricsSnapshot {
  workspaceId: string;
  sampledAt: number;
  cpu: { usagePercent: number; cores: number; loadAverage: [number, number, number] };
  memory: { usedBytes: number; totalBytes: number; usagePercent: number };
  filesystems: Array<{ device: string; mountPoint: string; usedBytes: number; totalBytes: number; usagePercent: number }>;
  uptimeSeconds: number;
  processes: Array<{
    pid: number;
    parentPid: number;
    user: string;
    state: string;
    cpuPercent: number;
    memoryPercent: number;
    residentBytes: number;
    elapsedSeconds: number;
    command: string;
  }>;
}
```

CPU、内存、load、uptime 和磁盘每 2 秒采样；进程每 3 秒采样，按 CPU 降序最多 20 条。探测命令由后端固定，不接受前端或 LLM 输入。单次失败发送 `monitor.error`，SSE 保持连接并继续下一轮。

```json
{
  "workspaceId": "ws-1",
  "sampledAt": 1787623400000,
  "cpu": { "usagePercent": 24.3, "cores": 4, "loadAverage": [0.82, 0.7, 0.6] },
  "memory": { "usedBytes": 5261334938, "totalBytes": 8589934592, "usagePercent": 61.25 },
  "filesystems": [{ "device": "/dev/vda1", "mountPoint": "/", "usedBytes": 62706522522, "totalBytes": 85899345920, "usagePercent": 73 }],
  "uptimeSeconds": 1680,
  "processes": [{ "pid": 2481, "parentPid": 1, "user": "api", "state": "S", "cpuPercent": 12.5, "memoryPercent": 4.2, "residentBytes": 104857600, "elapsedSeconds": 380, "command": "node server.js" }]
}
```

## 错误码与前端流程

文件相关错误至少包括：`file_already_exists`、`file_not_found`、`not_a_directory`、`cannot_download_directory`、`cannot_delete_directory`、`unsupported_file_type`、`atomic_overwrite_unsupported`、`transfer_not_found`、`transfer_direction_mismatch`、`transfer_invalid_state`、`transfer_size_mismatch`、`transfer_cancelled`、`transfer_interrupted`、`transfer_result_uncertain`、`sftp_permission_denied`、`sftp_operation_failed`。

- `failed + retryable:true`：前端允许创建新 Transfer 重试，不复用旧 Transfer。
- `cancelled`：允许重新创建；不暗示远端已有部分文件，因为上传临时文件会尽力清理。
- `uncertain`：禁止自动重试覆盖；先刷新目录并由用户确认远端结果。
- 删除成功、上传完成或下载完成后按需刷新当前目录。
- SSE 重连后重新查询最近 Transfer；不要依赖事件重放恢复状态。
