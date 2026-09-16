# SSH Agent Workspace 管理接口联调文档

> 状态：MVP v1
>
> 范围：Workspace、Session、Credential、Guard 静态管理
>
> Base path：`/api`

> 本文中的 Workspace/Credential 创建、查询、删除和关联契约已经被
> [Workspace 所有 Credential 前端联调文档](./frontend/workspace-credential-integration.md) 替代，不得继续用于前端实现。
> Session、Guard、Server 和通用传输约定在本文中继续有效。

## 1. 通用约定

### 1.1 服务器地址

本地开发环境：

| 项目 | 地址 |
|---|---|
| Server origin | `http://127.0.0.1:3001` |
| API base URL | `http://127.0.0.1:3001/api` |
| 健康检查 | `http://127.0.0.1:3001/healthz` |

例如，资源树接口的完整地址是：

```text
http://127.0.0.1:3001/api/workspace-session-tree
```

- 后端监听地址和端口分别由 `SSH_AGENT_HOST`、`SSH_AGENT_PORT` 配置，默认值为 `127.0.0.1:3001`。
- 前端应在统一 API client 中配置 Server origin，然后相对该地址请求 `/api/*`，不能在组件中散落服务器地址。
- `localhost` 和 `127.0.0.1` 是不同 Origin。跨 Origin 开发时，前端页面的完整 Origin 必须包含在后端 `SSH_AGENT_CORS_ORIGINS` allowlist 中。
- 部署环境推荐通过反向代理让页面与 `/api` 同源；此时前端使用相对路径 `/api`，外层代理负责 HTTPS、身份认证和访问控制。
- URL 示例中的 `:workspaceId`、`:sessionId`、`:credentialId` 是路径参数，占位符本身不能直接发送。

健康检查没有请求体：

```http
GET /healthz
```

成功响应为 `200 OK`：

```json
{
  "status": "ok"
}
```

### 1.2 JSON、ID 与并发控制

- JSON 字段统一为 `camelCase`，时间为 Unix epoch milliseconds。
- 服务端资源 ID 是不透明字符串，由后端生成；前端不能解析或自行构造。
- 前端可以为未保存的 UI 草稿生成本地 `clientKey`，但不能把它作为领域 ID 提交。Guard 新增规则的 ID 规则见第 7 节。
- `revision` 是乐观锁版本。编辑请求在 body 中传 `expectedRevision`；删除请求在 query 中传 `expectedRevision`。
- 创建返回 `201`，查询或编辑返回 `200`，删除返回 `204` 且无响应体。
- 所有响应携带 `Cache-Control: no-store`。
- `password`、`privateKey`、`passphrase` 是只写字段，任何读接口都不会返回。
- 当前 HTTP handler 不处理登录鉴权、CORS 和 CSRF，由承载它的 Server 层统一负责。

### 1.3 错误响应

错误响应：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Workspace was modified by another request",
    "field": "displayName"
  }
}
```

`field` 只在错误能定位到输入字段时出现。

| HTTP | code | 前端行为 |
|---|---|---|
| 400 | `validation_error` | 展示字段错误，不重试 |
| 403 | `origin_not_allowed` | 检查 Server CORS allowlist，不发送业务请求 |
| 404 | `not_found` | 刷新资源树并关闭失效详情页 |
| 409 | `revision_conflict` | 重新拉取数据，提示内容已变化 |
| 409 | `credential_in_use` | 提示先删除或迁移关联 Workspace |
| 409 | `workspace_has_sessions` | 提示先删除关联 Session |
| 413 | `payload_too_large` | 缩小请求体；Credential 私钥不能超过 Server 上限 |
| 500 | `secret_store_failed` / `internal_error` | 展示通用错误，不展示请求中的秘密 |

## 2. 领域对象

### Workspace

```ts
type WorkspaceEnvironment = "production" | "staging" | "development" | "other";

interface Workspace {
  id: string;
  displayName: string;
  environment: WorkspaceEnvironment;
  host: {
    hostname: string;
    port: number;
    hostKey: { algorithm: string; fingerprint: string; verifiedAt: number };
  };
  credentialId: string;
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

`host`、`credentialId`、`environment`、`defaultCwd`、`connection` 创建后不能通过普通编辑接口修改。MVP 编辑只允许 `displayName`。

### Session

```ts
interface Session {
  id: string;
  workspaceId: string;
  displayName: string;
  terminalContextCursor: number;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
```

`workspaceId` 创建后不可改变。要切换服务器必须创建新 Session。`terminalContextCursor` 由后端维护，前端只读。

### Credential

```ts
type Credential =
  | {
      id: string;
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
      displayName: string;
      type: "password";
      remoteUser: string;
      authVersion: number;
      revision: number;
      createdAt: number;
      updatedAt: number;
    };
```

这是安全读模型，不包含认证材料。`authVersion` 将作为 SSH Connection Pool key 的组成部分。

### Guard

Guard 是独立实体，与 Workspace 一对一绑定并持久化。创建 Workspace 时，后端自动创建 `enabled: false`、`rules: []` 的默认 Guard。

```ts
interface Guard {
  id: string;
  workspaceId: string;
  enabled: boolean;
  rules: Array<{
    id: string;
    displayName: string;
    pattern: string;
    match: "contains" | "starts_with" | "regex";
    reason?: string;
    enabled: boolean;
  }>;
  revision: number;
  createdAt: number;
  updatedAt: number;
}
```

Guard 只作用于 AI command operation；用户 PTY 不经过 Guard。命令执行层必须在建立 SSH exec channel 之前检查 Guard。

## 3. Workspace + Session Tree

### `GET /api/workspace-session-tree`

左侧导航的全量静态资源树。MVP 不分页。Workspace 按 `displayName, id` 排序，Session 按 `createdAt, id` 排序。

请求体：无。

成功响应：`200 OK`

```json
{
  "workspaces": [
    {
      "workspace": {
        "id": "ws_01",
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
        "credentialId": "cred_01",
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
      "sessions": [
        {
          "id": "session_01",
          "workspaceId": "ws_01",
          "displayName": "Nginx incident",
          "terminalContextCursor": 0,
          "revision": 1,
          "createdAt": 1787539300000,
          "updatedAt": 1787539300000
        }
      ]
    }
  ]
}
```

首次加载、创建或删除 Workspace/Session 后重新拉取。重命名可先使用响应局部更新，再后台刷新。

## 4. Credential 接口

### `POST /api/credentials`

创建 Credential。`type` 决定请求中的认证材料字段，不能同时提交两种认证材料。

私钥认证请求体：

```json
{
  "displayName": "Production deploy key",
  "remoteUser": "deploy",
  "type": "private_key",
  "privateKey": "-----BEGIN OPENSSH PRIVATE KEY-----\n...",
  "passphrase": "optional"
}
```

`passphrase` 可省略。密码认证请求体：

```json
{
  "displayName": "Staging password",
  "remoteUser": "ubuntu",
  "type": "password",
  "password": "write-only"
}
```

成功响应：`201 Created`。私钥 Credential 示例：

```json
{
  "id": "cred_01",
  "displayName": "Production deploy key",
  "type": "private_key",
  "remoteUser": "deploy",
  "hasPassphrase": true,
  "authVersion": 1,
  "revision": 1,
  "createdAt": 1787539200000,
  "updatedAt": 1787539200000
}
```

密码 Credential 的响应结构相同，但 `type` 为 `password`，且没有 `hasPassphrase`。响应永远不包含 `password`、`privateKey` 或 `passphrase`。

前端不得把请求对象写入日志、持久化状态、错误追踪或 analytics；提交完成后立即清空秘密字段。

### `GET /api/credentials`

供 Workspace 创建向导选择已有 Credential。

请求体：无。

成功响应：`200 OK`

```json
{
  "credentials": [
    {
      "id": "cred_01",
      "displayName": "Production deploy key",
      "type": "private_key",
      "remoteUser": "deploy",
      "hasPassphrase": true,
      "authVersion": 1,
      "revision": 1,
      "createdAt": 1787539200000,
      "updatedAt": 1787539200000
    }
  ]
}
```

### `GET /api/credentials/:credentialId`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `credentialId` | `string` | Credential ID |

请求体：无。

成功响应：`200 OK`

```json
{
  "id": "cred_01",
  "displayName": "Production deploy key",
  "type": "private_key",
  "remoteUser": "deploy",
  "hasPassphrase": true,
  "authVersion": 1,
  "revision": 1,
  "createdAt": 1787539200000,
  "updatedAt": 1787539200000
}
```

### `GET /api/workspaces/:workspaceId/credential`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `workspaceId` | `string` | Workspace ID |

请求体：无。

成功响应：`200 OK`

```json
{
  "workspaceId": "ws_01",
  "credential": {
    "id": "cred_01",
    "displayName": "Production deploy key",
    "type": "private_key",
    "remoteUser": "deploy",
    "hasPassphrase": true,
    "authVersion": 1,
    "revision": 1,
    "createdAt": 1787539200000,
    "updatedAt": 1787539200000
  }
}
```

### `DELETE /api/credentials/:credentialId?expectedRevision=1`

路径和 query 参数：

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `credentialId` | path | `string` | Credential ID |
| `expectedRevision` | query | `positive integer` | 前端最后读取到的 revision |

请求体：无。

成功响应：`204 No Content`，无响应体。

被 Workspace 引用时返回 `409 credential_in_use`；revision 过期时返回 `409 revision_conflict`。

## 5. Workspace 接口

### `POST /api/workspaces`

调用前必须已有 Credential。`connection` 可省略或只传部分字段，缺省值为 `10000 / 15000 / 3`。

请求体：

```json
{
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
  "credentialId": "cred_01",
  "defaultCwd": "/srv/app",
  "connection": { "connectTimeoutMs": 10000 }
}
```

成功响应：`201 Created`。后端同时创建默认 Guard。

```json
{
  "id": "ws_01",
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
  "credentialId": "cred_01",
  "defaultCwd": "/srv/app",
  "connection": {
    "connectTimeoutMs": 10000,
    "keepaliveIntervalMs": 15000,
    "keepaliveMaxCount": 3
  },
  "revision": 1,
  "createdAt": 1787539200000,
  "updatedAt": 1787539200000
}
```

创建向导是一个前端流程，但当前由顺序请求组成：

1. 选择已有 Credential，或调用 `POST /api/credentials` 新建。
2. 使用 `credentialId` 调用 `POST /api/workspaces`。
3. 如需 Guard 规则，再调用 Guard PATCH。
4. 第二步失败时，新 Credential 保留，可复用或由用户删除；前端不要自动删除。

### `PATCH /api/workspaces/:workspaceId`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `workspaceId` | `string` | Workspace ID |

请求体：

```json
{
  "displayName": "Production Web 01",
  "expectedRevision": 1
}
```

只允许这两个字段。传入其他字段返回 `400 validation_error`，不会静默忽略。

成功响应：`200 OK`

```json
{
  "id": "ws_01",
  "displayName": "Production Web 01",
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
  "credentialId": "cred_01",
  "defaultCwd": "/srv/app",
  "connection": {
    "connectTimeoutMs": 10000,
    "keepaliveIntervalMs": 15000,
    "keepaliveMaxCount": 3
  },
  "revision": 2,
  "createdAt": 1787539200000,
  "updatedAt": 1787539400000
}
```

### `DELETE /api/workspaces/:workspaceId?expectedRevision=1`

路径和 query 参数：

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `workspaceId` | path | `string` | Workspace ID |
| `expectedRevision` | query | `positive integer` | 前端最后读取到的 revision |

请求体：无。

成功响应：`204 No Content`，无响应体。SQLite 同时级联删除 Guard，但保留 Credential。

仍有 Session 时返回 `409 workspace_has_sessions`；revision 过期时返回 `409 revision_conflict`。

## 6. Session 接口

### `POST /api/workspaces/:workspaceId/sessions`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `workspaceId` | `string` | Session 所属的 Workspace ID |

请求体：

```json
{ "displayName": "Investigate high CPU" }
```

成功响应：`201 Created`

```json
{
  "id": "session_01",
  "workspaceId": "ws_01",
  "displayName": "Investigate high CPU",
  "terminalContextCursor": 0,
  "revision": 1,
  "createdAt": 1787539300000,
  "updatedAt": 1787539300000
}
```

### `GET /api/sessions/:sessionId`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | Session ID |

请求体：无。

成功响应：`200 OK`

```json
{
  "id": "session_01",
  "workspaceId": "ws_01",
  "displayName": "Investigate high CPU",
  "terminalContextCursor": 0,
  "revision": 1,
  "createdAt": 1787539300000,
  "updatedAt": 1787539300000
}
```

### `PATCH /api/sessions/:sessionId`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `sessionId` | `string` | Session ID |

请求体：

```json
{
  "displayName": "Investigate API high CPU",
  "expectedRevision": 1
}
```

只允许这两个字段。传入 `workspaceId`、`terminalContextCursor` 或其他字段返回 `400 validation_error`。

成功响应：`200 OK`

```json
{
  "id": "session_01",
  "workspaceId": "ws_01",
  "displayName": "Investigate API high CPU",
  "terminalContextCursor": 0,
  "revision": 2,
  "createdAt": 1787539300000,
  "updatedAt": 1787539400000
}
```

### `DELETE /api/sessions/:sessionId?expectedRevision=1`

路径和 query 参数：

| 参数 | 位置 | 类型 | 说明 |
|---|---|---|---|
| `sessionId` | path | `string` | Session ID |
| `expectedRevision` | query | `positive integer` | 前端最后读取到的 revision |

请求体：无。

成功响应：`204 No Content`，无响应体。revision 过期时返回 `409 revision_conflict`。

## 7. Guard 接口

### `GET /api/workspaces/:workspaceId/guard`

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `workspaceId` | `string` | Workspace ID |

请求体：无。

成功响应：`200 OK`

```json
{
  "id": "guard_01",
  "workspaceId": "ws_01",
  "enabled": true,
  "rules": [
    {
      "id": "rule_01",
      "displayName": "禁止删除根目录",
      "pattern": "rm -rf /",
      "match": "contains",
      "reason": "Destructive command",
      "enabled": true
    }
  ],
  "revision": 2,
  "createdAt": 1787539200000,
  "updatedAt": 1787539400000
}
```

### `PATCH /api/workspaces/:workspaceId/guard`

Guard 配置使用整体替换，避免规则数组的局部更新产生顺序和并发歧义。

路径参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `workspaceId` | `string` | Workspace ID |

请求体类型：

```ts
interface UpdateGuardRuleInput {
  /** 已保存规则必须传；新增规则必须省略。 */
  id?: string;
  displayName: string;
  pattern: string;
  match: "contains" | "starts_with" | "regex";
  reason?: string;
  enabled: boolean;
}

interface UpdateGuardInput {
  enabled: boolean;
  rules: UpdateGuardRuleInput[];
  expectedRevision: number;
}
```

以下示例修改已有的 `rule_01`，同时新增一条不带 `id` 的规则：

```json
{
  "enabled": true,
  "rules": [
    {
      "id": "rule_01",
      "displayName": "禁止删除根目录",
      "pattern": "rm -rf /",
      "match": "contains",
      "reason": "Destructive command",
      "enabled": true
    },
    {
      "displayName": "禁止关机",
      "pattern": "shutdown",
      "match": "starts_with",
      "reason": "Server availability",
      "enabled": true
    }
  ],
  "expectedRevision": 2
}
```

成功响应：`200 OK`。后端为新增规则生成正式 ID，并返回 revision 已递增的完整 Guard：

```json
{
  "id": "guard_01",
  "workspaceId": "ws_01",
  "enabled": true,
  "rules": [
    {
      "id": "rule_01",
      "displayName": "禁止删除根目录",
      "pattern": "rm -rf /",
      "match": "contains",
      "reason": "Destructive command",
      "enabled": true
    },
    {
      "id": "rule_02",
      "displayName": "禁止关机",
      "pattern": "shutdown",
      "match": "starts_with",
      "reason": "Server availability",
      "enabled": true
    }
  ],
  "revision": 3,
  "createdAt": 1787539200000,
  "updatedAt": 1787539500000
}
```

整体替换规则：

1. 新增规则必须省略 `id`，由后端生成正式 ID。
2. 修改已有规则必须回传最近一次 GET/PATCH 响应中的 `id`。
3. 请求中带 `id` 的规则必须属于当前 Guard；未知 ID 返回 `400 validation_error`，后端不能把它当作新增规则。
4. 同一请求中的已有规则 ID 不能重复，否则返回 `400 validation_error`。
5. 当前 Guard 中已有、但没有出现在请求 `rules` 数组中的规则会被删除。
6. `rules` 的响应顺序与请求顺序一致；前端应以成功响应整体替换本地已保存状态。
7. `match: "regex"` 时，`pattern` 必须是有效 JavaScript 正则表达式。
8. `expectedRevision` 与服务端当前 revision 不一致时，返回 `409 revision_conflict`，整个更新不生效。

前端可以为未保存草稿生成本地 key，但该 key 不能提交为规则 ID：

```ts
interface GuardRuleDraft {
  clientKey: string; // 仅用于前端列表和未保存草稿
  id?: string; // 仅保存后端返回的正式规则 ID
  displayName: string;
  pattern: string;
  match: "contains" | "starts_with" | "regex";
  reason?: string;
  enabled: boolean;
}
```

## 8. 前端工程规范

按领域组织代码，不按页面堆放请求：

```text
features/
  workspace/{api,model,components}/
  session/{api,model,components}/
  credential/{api,model,components}/
  guard/{api,model,components}/
shared/{api,errors}/
```

- 组件不能直接拼 URL；每个领域通过自己的 API client 暴露操作。
- 服务端 DTO 与表单状态分离。Credential secret 不能合并进可持久化的 Credential 读模型。
- mutation 成功后，以响应中的 `revision` 覆盖本地 revision。
- `revision_conflict` 不能自动覆盖服务端内容，应重新获取并提示用户。
- 删除 Workspace 前可根据 tree 禁用按钮并提示先删除 Session；后端仍会校验。
- Guard 编辑器维护草稿并整体提交；服务端成功前不要替换当前生效配置。
- API client 统一解析非 2xx 为结构化错误，UI 组件只处理领域错误码。

## 9. 本批次不包含

- Host key 探测/确认和测试连接接口。
- Credential 编辑与认证材料轮换接口。
- Workspace 的 Host、Credential、默认目录或连接参数变更。
- Agent Message、Operation、PTY、SFTP、Connection Pool 和实时事件接口。
- 登录鉴权、权限模型和多租户隔离。

这些能力应继续放在对应领域中，不能通过扩大 Workspace 普通 PATCH 的字段范围实现。
