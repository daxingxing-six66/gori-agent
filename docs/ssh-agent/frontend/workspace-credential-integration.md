# Workspace 所有 Credential 前端联调文档

> 状态：MVP v3
>
> Server origin：`http://127.0.0.1:3001`
>
> API base URL：`http://127.0.0.1:3001/api`

## 1. 业务修改背景

旧模型把 Credential 作为全局资源，由 Workspace 通过 `credentialId` 引用。前端创建 Workspace 前需要先拉取全部 Credential，这会暴露无关服务器的凭证元数据，也容易把某台服务器的登录配置错误复用到另一台服务器。

新模型把 Credential 收入 Workspace 的所有权边界：

```text
Workspace 1 ──── 1..N Credential
Workspace ────── 1 activeCredential
Credential ───── 1 Workspace
```

必须遵守以下约束：

1. Credential 只能属于一个 Workspace，不能跨 Workspace 复用或移动。
2. Workspace 创建时必须同时创建并激活第一个 Credential，整个操作由后端事务保证原子性。
3. 已有 Workspace 可以新增多个 Credential；新增项默认不激活，不会影响当前连接身份。
4. 切换活动 Credential 是独立操作，通过 Workspace revision 做乐观并发控制。
5. 当前活动 Credential 不能直接删除，必须先显式切换到其他 Credential。
6. 删除 Workspace 时，后端级联删除其 Credential、加密 Secret、Host Trust 和 Guard；仍有 Session 时继续拒绝删除 Workspace。
7. Credential 的 `password`、`privateKey` 和 `passphrase` 只写。前端不得将它们写入日志、持久化状态、错误追踪或 analytics，创建提交完成后应立即清空；可选连接测试后保留内存草稿供重试或创建，关闭弹窗时释放。

推荐前端流程：

```text
创建 Workspace
  └─ 同一请求提交首个 Credential
       └─ 成功响应同时返回 Workspace 与 activeCredential

管理 Credential
  ├─ 拉取当前 Workspace 的 Credential 列表
  ├─ 新增 Credential（默认不激活）
  ├─ 用户显式切换 activeCredential
  └─ 删除非活动 Credential
```

这是 breaking change。以下全局接口已经移除，前端不能再调用：

```text
GET    /api/credentials
POST   /api/credentials
GET    /api/credentials/:credentialId
DELETE /api/credentials/:credentialId
GET    /api/workspaces/:workspaceId/credential
```

SQLite schema v1 的业务数据不会自动迁移或删除。开发环境使用旧数据库启动时，后端会提示需要重建；开发者应先备份，再显式删除旧数据库文件及对应 WAL/SHM 文件后重启。

Workspace 创建时不再接收主机密钥算法、指纹或确认时间，成功响应中的 `host.hostKey` 为 `null`。第一次 Agent Tool 调用时，后端自动执行 TOFU（Trust On First Use）：临时握手获取服务器算法和公钥，计算 SHA-256 指纹，持久化后再使用活动 Credential 建立认证连接。前端不参与确认，也不存在 `scanId`。

一个 Workspace 最多拥有一条 Host Trust。后续重建 SSH Connection 时必须严格匹配已保存的算法和指纹；不一致会产生 `host_key_mismatch`，后端不会自动覆盖。切换活动 Credential 只淘汰旧认证 Connection，不删除 Host Trust。自动 TOFU 只能固定第一次观察到的服务器身份，不能证明首次连接没有遭遇中间人攻击。

## 2. 接口定义、请求体与响应体

### 2.1 通用约定与领域对象

- JSON 字段使用 `camelCase`，时间为 Unix epoch milliseconds。
- ID 是后端生成的不透明字符串，前端不能解析或自行构造。
- 创建返回 `201`，查询、切换或编辑返回 `200`，删除返回 `204` 且没有响应体。
- `expectedRevision` 是前端最后一次读取到的 revision。revision 过期返回 `409 revision_conflict`，前端必须重新拉取，不能自动覆盖。
- 所有响应包含 `Cache-Control: no-store`。
- Workspace 和 Credential ID 都必须来自当前接口响应；跨 Workspace 使用 Credential ID 返回 `404 not_found`。

Workspace：

```ts
interface Workspace {
  id: string;
  displayName: string;
  environment: "production" | "staging" | "development" | "other";
  host: {
    hostname: string;
    port: number;
    hostKey: null | {
      algorithm: string;
      fingerprint: `SHA256:${string}`;
      verifiedAt: number;
    };
  };
  activeCredentialId: string;
  defaultCwd: string;
  connection: {
    connectTimeoutMs: number;
    keepaliveIntervalMs: number;
    keepaliveMaxCount: number;
  };
  revision: number;
  createdAt: number;
  updatedAt: number;
}
```

Credential 安全读模型：

```ts
type Credential =
  | {
      id: string;
      workspaceId: string;
      displayName: string;
      type: "private_key";
      remoteUser: string;
      publicKeyFingerprint?: string;
      hasPassphrase: boolean;
      authVersion: number;
      revision: number;
      createdAt: number;
      updatedAt: number;
    }
  | {
      id: string;
      workspaceId: string;
      displayName: string;
      type: "password";
      remoteUser: string;
      authVersion: number;
      revision: number;
      createdAt: number;
      updatedAt: number;
    };
```

通用错误响应：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Workspace was modified by another request",
    "field": "expectedRevision"
  }
}
```

`field` 只在错误可以定位到请求字段时出现。

| HTTP | code | 前端行为 |
|---|---|---|
| 400 | `validation_error` | 展示字段错误，不重试 |
| 404 | `not_found` | 资源不存在或 Credential 不属于路径中的 Workspace，刷新当前 Workspace 数据 |
| 409 | `revision_conflict` | 重新拉取 Workspace/Credential，提示内容已变化 |
| 409 | `active_credential_in_use` | 提示先切换活动 Credential，再执行删除 |
| 409 | `workspace_has_sessions` | 提示先删除 Workspace 下的 Session |
| 500 | `secret_store_failed` | 展示通用失败信息，不能展示或记录请求中的秘密 |

### 2.2 原子创建 Workspace 与首个 Credential

```http
POST /api/workspaces
Content-Type: application/json
```

私钥认证请求体：

```json
{
  "displayName": "Production Web",
  "environment": "production",
  "host": {
    "hostname": "10.0.0.10",
    "port": 22
  },
  "credential": {
    "displayName": "Production root",
    "remoteUser": "root",
    "type": "private_key",
    "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
    "passphrase": "optional"
  },
  "defaultCwd": "/srv/app",
  "connection": {
    "connectTimeoutMs": 10000
  }
}
```

密码认证时，`credential` 改为：

```json
{
  "displayName": "Production root",
  "remoteUser": "root",
  "type": "password",
  "password": "write-only"
}
```

`connection` 可省略或只提交部分字段，缺省值为 `10000 / 15000 / 3`。私钥 `passphrase` 可省略；两种认证材料不能同时提交。

成功响应：`201 Created`

```json
{
  "workspace": {
    "id": "workspace_01",
    "displayName": "Production Web",
    "environment": "production",
    "host": {
      "hostname": "10.0.0.10",
      "port": 22,
      "hostKey": null
    },
    "activeCredentialId": "credential_01",
    "defaultCwd": "/srv/app",
    "connection": {
      "connectTimeoutMs": 10000,
      "keepaliveIntervalMs": 15000,
      "keepaliveMaxCount": 3
    },
    "revision": 1,
    "createdAt": 1787539200000,
    "updatedAt": 1787539200000
  },
  "activeCredential": {
    "id": "credential_01",
    "workspaceId": "workspace_01",
    "displayName": "Production root",
    "type": "private_key",
    "remoteUser": "root",
    "hasPassphrase": true,
    "authVersion": 1,
    "revision": 1,
    "createdAt": 1787539200000,
    "updatedAt": 1787539200000
  }
}
```

失败时 Workspace、Credential、Secret 和默认 Guard 均不会保留。旧请求字段 `credentialId`，以及前端提交的 `host.hostKey`，均返回 `400 validation_error`。

创建接口不连接 SSH 服务器。第一次 Tool 调用自动 TOFU 成功后，后续 Tree 查询中的 `host.hostKey` 会变为后端生成的算法、SHA-256 指纹和 `verifiedAt`；该运行时变化不增加 Workspace revision。

### 2.3 获取 Workspace 的全部 Credential

```http
GET /api/workspaces/:workspaceId/credentials
```

请求体：无。

成功响应：`200 OK`

```json
{
  "workspaceId": "workspace_01",
  "activeCredentialId": "credential_01",
  "workspaceRevision": 3,
  "credentials": [
    {
      "id": "credential_02",
      "workspaceId": "workspace_01",
      "displayName": "Backup login",
      "type": "password",
      "remoteUser": "deploy",
      "authVersion": 1,
      "revision": 1,
      "createdAt": 1787539300000,
      "updatedAt": 1787539300000
    },
    {
      "id": "credential_01",
      "workspaceId": "workspace_01",
      "displayName": "Production root",
      "type": "private_key",
      "remoteUser": "root",
      "hasPassphrase": true,
      "authVersion": 1,
      "revision": 1,
      "createdAt": 1787539200000,
      "updatedAt": 1787539200000
    }
  ]
}
```

`credentials` 按 `displayName, id` 排序。前端通过顶层 `activeCredentialId` 判断活动项，Credential 对象本身没有 `isActive` 字段。

### 2.4 向 Workspace 新增 Credential

```http
POST /api/workspaces/:workspaceId/credentials
Content-Type: application/json
```

请求体沿用 Credential 创建字段：

```json
{
  "displayName": "Backup login",
  "remoteUser": "deploy",
  "type": "password",
  "password": "write-only"
}
```

成功响应：`201 Created`

```json
{
  "id": "credential_02",
  "workspaceId": "workspace_01",
  "displayName": "Backup login",
  "type": "password",
  "remoteUser": "deploy",
  "authVersion": 1,
  "revision": 1,
  "createdAt": 1787539300000,
  "updatedAt": 1787539300000
}
```

新 Credential 默认不激活，Workspace revision 不变。需要使用第 2.7 节接口显式切换。

### 2.5 获取指定 Credential

```http
GET /api/workspaces/:workspaceId/credentials/:credentialId
```

请求体：无。成功返回 `200 Credential`。当 Credential 不属于路径中的 Workspace 时返回 `404 not_found`，不会返回其真实归属信息。

### 2.6 获取当前活动 Credential

```http
GET /api/workspaces/:workspaceId/active-credential
```

请求体：无。

成功响应：`200 OK`

```json
{
  "workspaceId": "workspace_01",
  "workspaceRevision": 3,
  "credential": {
    "id": "credential_01",
    "workspaceId": "workspace_01",
    "displayName": "Production root",
    "type": "private_key",
    "remoteUser": "root",
    "hasPassphrase": true,
    "authVersion": 1,
    "revision": 1,
    "createdAt": 1787539200000,
    "updatedAt": 1787539200000
  }
}
```

### 2.7 切换当前活动 Credential

```http
PUT /api/workspaces/:workspaceId/active-credential
Content-Type: application/json
```

请求体：

```json
{
  "credentialId": "credential_02",
  "expectedRevision": 3
}
```

成功响应：`200 OK`

```json
{
  "workspace": {
    "id": "workspace_01",
    "displayName": "Production Web",
    "environment": "production",
    "host": {
      "hostname": "10.0.0.10",
      "port": 22,
      "hostKey": {
        "algorithm": "ssh-ed25519",
        "fingerprint": "SHA256:abc...",
        "verifiedAt": 1787539200000
      }
    },
    "activeCredentialId": "credential_02",
    "defaultCwd": "/srv/app",
    "connection": {
      "connectTimeoutMs": 10000,
      "keepaliveIntervalMs": 15000,
      "keepaliveMaxCount": 3
    },
    "revision": 4,
    "createdAt": 1787539200000,
    "updatedAt": 1787539400000
  },
  "activeCredential": {
    "id": "credential_02",
    "workspaceId": "workspace_01",
    "displayName": "Backup login",
    "type": "password",
    "remoteUser": "deploy",
    "authVersion": 1,
    "revision": 1,
    "createdAt": 1787539300000,
    "updatedAt": 1787539300000
  }
}
```

切换到已经活动的 Credential 是幂等操作：仍校验 `expectedRevision`，成功后返回当前资源，但不增加 Workspace revision。

切换活动 Credential 会关闭该 Workspace 的旧认证 Connection，但不会清除或修改 `host.hostKey`。下一次 Tool 调用使用新 Credential 建立 Connection 时，仍验证同一份 Host Trust。

### 2.8 删除非活动 Credential

```http
DELETE /api/workspaces/:workspaceId/credentials/:credentialId?expectedRevision=1
```

请求体：无。成功响应为 `204 No Content`。

- `expectedRevision` 使用目标 Credential 的 revision，不是 Workspace revision。
- 删除活动 Credential 返回 `409 active_credential_in_use`。
- Credential 不属于该 Workspace 时返回 `404 not_found`。
- 删除成功后，对应加密 Secret 同步删除。

### 2.9 Workspace + Session Tree 的字段变化

```http
GET /api/workspace-session-tree
```

Workspace 节点不再返回 `credentialId`，改为 `activeCredentialId`：

```json
{
  "workspaces": [
    {
      "workspace": {
        "id": "workspace_01",
        "displayName": "Production Web",
        "activeCredentialId": "credential_02",
        "revision": 4
      },
      "sessions": []
    }
  ]
}
```

示例省略了 Workspace 的其他未变化字段。Tree 不内嵌 Credential 列表；打开 Credential 管理界面时再调用第 2.3 节接口。首次 Tool 调用前 `workspace.host.hostKey` 为 `null`，自动 TOFU 成功后返回可信算法、指纹和后端时间。

### 2.10 已移除接口的响应

旧的全局 Credential 和单数 Workspace Credential 路由不再匹配，统一返回 `404`：

```json
{
  "error": {
    "code": "not_found",
    "message": "API endpoint not found"
  }
}
```


### 2.11 创建前测试连接

```http
POST /api/workspaces/test-connection
Content-Type: application/json
Accept-Language: zh-CN
```

```json
{
  "host": { "hostname": "127.0.0.1", "port": 22 },
  "credential": { "displayName": "SSH", "remoteUser": "deploy", "type": "password", "password": "write-only" },
  "connection": { "connectTimeoutMs": 10000, "keepaliveIntervalMs": 15000, "keepaliveMaxCount": 3 }
}
```

`credential` 也接受第 2.2 节的私钥结构。`connection` 可省略或只提供部分字段，默认值与创建接口一致；测试超时必须是 `1..2147483647` 毫秒的整数。顶层不接收工作区名称、环境、目录、ID 或 Host Key。

认证成功返回 `200 { "success": true }`，不执行命令、不保存凭据或主机信任、不创建工作区。成功与失败均关闭临时连接；前端取消请求及服务关闭也会释放连接。首次正式连接仍按既有 TOFU 流程处理。

参数错误为 `400 validation_error`；认证失败、私钥无效为 `401 authentication_failed/invalid_private_key`；连接拒绝、DNS 失败、网络不可达、超时和传输丢失为 `502`，分别使用 `connection_refused/dns_lookup_failed/network_unreachable/connection_timeout/transport_lost`。错误沿用 `{ error: { code, message, errorId, ... } }`，静态原因按请求语言返回，不包含秘密或底层原始异常。

测试连接是可选操作，不是创建的前置条件。测试按钮不提交创建表单；加载期间禁用重复测试和创建。修改连接信息、打开凭据配置或关闭弹窗时取消测试并清除旧结果，修改名称/环境/目录不清除结果。测试后保留凭据草稿，创建提交完成后仍清空秘密。

## 编辑工作区

`PATCH /api/workspaces/:workspaceId` 接收 `{ displayName: string, defaultCwd?: string, expectedRevision: number }`，成功返回更新后的 Workspace，revision 加一。省略 `defaultCwd` 保留原值；传入值必须非空且不超过 4096 字符。其他连接字段仍不允许修改，版本冲突返回 409。前端通过系统目录选择器提供目录，保存后刷新资源树；仅后续新 Session 继承该目录，不回填旧 Session。
