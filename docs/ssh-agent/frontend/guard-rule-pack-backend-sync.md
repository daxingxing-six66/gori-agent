# Guard 预设规则包后端同步契约

本文档定义 `packages/ssh-agent-web` 已预接的 Guard Rule Pack 接口。前端不会使用现有 Guard PATCH 模拟导入；以下接口完成前，导入弹窗保持只读并提示服务暂不可用。

## 1. 数据所有权

预设目录和规则来源均由后端维护。普通 Guard PATCH 继续只接受：

```ts
interface UpdateCommandGuardRuleInput {
  id?: string;
  displayName: string;
  pattern: string;
  match: "contains" | "starts_with" | "regex";
  reason?: string;
  enabled: boolean;
}
```

Guard Rule 响应增加只读字段：

```ts
interface CommandGuardRule {
  // 现有字段
  source: "builtin" | "user";
  originRuleId?: string;
  packId?: string;
  packVersion?: string;
  level: "critical" | "strict";
}
```

- 客户端不能在普通 PATCH 中提交或修改来源字段。
- 普通 PATCH 编辑已有预设规则时，后端必须从当前持久化规则保留来源字段。
- 普通 PATCH 新建规则时，后端写入 `source="user"`。
- 历史规则缺少来源字段时，读取后按用户规则返回；不得因升级导致已有 Guard 无法读取。
- `originRuleId` 在所有内置规则中全局唯一，是导入去重的唯一依据。名称、pattern 和 reason 都不能用于去重。

## 2. 首版规则包

首版目录包含以下稳定 ID：

| packId | 名称 | 推荐 | 内容边界 |
|---|---|---:|---|
| `linux-critical` | Linux 基础保护 | 是 | 关机、系统权限、关键系统文件和 Fork Bomb |
| `ssh-protection` | SSH 防失联 | 是 | 停止或卸载 SSH、删除 SSH 配置 |
| `disk-protection` | 磁盘数据保护 | 是 | mkfs、wipefs、blkdiscard 和 dd 覆盖块设备 |
| `network-protection` | 网络连接保护 | 否 | 关闭网络和清除网卡 IP 等确定性失联操作 |

首版只提供执行语义明确的 `critical` 规则。Docker、Kubernetes、Database 和需要转人工审批的 `strict` 规则不进入首版目录。

建议使用稳定规则 ID，例如 `linux.power.shutdown`、`ssh.systemctl-stop`、`disk.mkfs` 和 `network.ip-flush`。规则包升级只能新增或修正规则目录，不能自动覆盖已经复制到 Workspace 的规则。

## 3. 查询 Workspace 规则包状态

```http
GET /api/workspaces/:workspaceId/guard/rule-packs
```

成功响应：

```json
{
  "workspaceId": "workspace-1",
  "guardRevision": 3,
  "packs": [
    {
      "id": "linux-critical",
      "name": "Linux 基础保护",
      "description": "防止主机关机、系统权限损坏等基础高危操作",
      "version": "1.0.0",
      "ruleCount": 7,
      "importedRuleCount": 5,
      "availableRuleCount": 2,
      "recommended": true
    }
  ]
}
```

约束：

- `guardRevision` 必须与同一时刻 Guard 的 revision 一致。
- `importedRuleCount` 按当前 Guard 中存在的 `originRuleId` 计算，包括被用户修改或禁用的规则。
- `availableRuleCount = ruleCount - importedRuleCount`。
- 已删除的预设规则不再计为已导入，因此允许重新导入。
- Workspace 或 Guard 不存在时返回 `not_found`。

## 4. 原子导入

```http
POST /api/workspaces/:workspaceId/guard/rule-packs/import
Content-Type: application/json
```

请求：

```json
{
  "packIds": ["linux-critical", "ssh-protection"],
  "expectedRevision": 3
}
```

成功响应：

```json
{
  "guard": {
    "id": "guard-1",
    "workspaceId": "workspace-1",
    "enabled": true,
    "rules": [],
    "revision": 4,
    "createdAt": 0,
    "updatedAt": 0
  },
  "results": [
    {
      "packId": "linux-critical",
      "importedCount": 2,
      "skippedCount": 5
    }
  ]
}
```

导入必须在一个 Guard 更新中原子完成：

1. 校验 `expectedRevision`。
2. 校验 `packIds` 非空、无重复并且全部存在。
3. 按 `originRuleId` 跳过当前 Guard 已有规则。
4. 为缺失规则生成 Workspace Rule ID，并追加到现有规则末尾。
5. 写入 `source="builtin"`、`originRuleId`、`packId`、`packVersion` 和 `level`。
6. 至少存在一条规则时将 Guard 设为启用。
7. 返回完整 Guard 和每个请求包的统计。

不得覆盖已有来源规则的名称、pattern、reason 或 enabled。所有请求规则均已存在时返回当前 Guard 和全量 skipped 统计，不写数据库、不增加 revision。

## 5. 错误契约

继续使用现有结构化错误格式：

```json
{
  "error": {
    "code": "revision_conflict",
    "message": "Guard was modified by another request"
  }
}
```

- revision 过期：`revision_conflict`。
- 未知、重复或空 `packIds`：`validation_error`，field 指向 `packIds`。
- Workspace 或 Guard 不存在：`not_found`。
- 规则目录自身存在重复 origin、非法正则或空字段：属于后端配置错误，必须在启动或测试阶段失败，不能部分导入。

## 6. 本次不要求的能力

以下内容与规则包接口解耦，留作独立后端任务：

- Command Normalizer。
- 按 `;`、`&&`、`||` 或换行拆分 Shell Command。
- 完整 Bash AST。
- `strict` 规则转 Approval。
- 自动覆盖或升级 Workspace 已导入规则。
