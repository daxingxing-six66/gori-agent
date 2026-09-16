# Chat 模型思考等级与 Session 模型偏好联调代办

> 状态：后端契约与前端实现已完成，等待本地 HTTP Server 启动后进行真实联调验收。
>
> 范围：模型目录的思考等级、Session 最近模型偏好、Chat Run 创建参数和前端模型选择器。

## 1. 已确认的交互决策

- 思考等级属于具体模型能力，不按 Provider 写死。
- Session 记录最近一次成功创建 Chat Run 时实际使用的模型和思考等级。
- 页面初始化时从 Session 元数据恢复模型，不从消息分页响应推导。
- 创建 Chat Run 成功后，前端直接使用 Run 响应更新当前选择，不重新查询模型偏好。
- Active Run 存在时，以 Active Run 的模型信息覆盖 Session 偏好。
- Provider Credential、API Key、Endpoint 和模型名称不进入 Session 偏好。

## 2. 后端代办

### 2.1 模型目录返回可用思考等级

接口：

```http
GET /api/llm/providers/:providerId/models
```

每个模型增加：

```ts
type ThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

interface LlmModelDefinition {
  // 现有字段
  reasoning: boolean;
  supportedThinkingLevels: ThinkingLevel[];
}
```

数据必须来自 `pi-ai` 的 `getSupportedThinkingLevels(model)`，前端不根据 Provider ID 或模型 ID猜测能力。

约束：

- 非推理模型返回 `["off"]`。
- `supportedThinkingLevels` 至少包含一个值。
- 数组顺序使用 `off → minimal → low → medium → high → xhigh → max`。
- `xhigh` 和 `max` 只在模型真实支持时返回。
- `reasoning` 暂时保留，前端使用 `supportedThinkingLevels` 判断选择项。

示例：

```json
{
  "id": "deepseek-v4-flash",
  "providerId": "deepseek",
  "name": "DeepSeek V4 Flash",
  "reasoning": true,
  "supportedThinkingLevels": ["off", "minimal", "low", "medium", "high"]
}
```

### 2.2 Session 返回最近模型选择

Session 详情响应增加：

```ts
interface ChatModelSelection {
  providerId: string;
  modelId: string;
  thinkingLevel: ThinkingLevel;
}

type SessionDetails = Session & {
  chatModelSelection: ChatModelSelection | null;
};
```

由以下接口返回：

```http
GET /api/sessions/:sessionId
```

新建且尚未创建 Chat Run 的 Session 返回：

```json
{"chatModelSelection": null}
```

`chatModelSelection` 从该 Session 最近的 `chat_runs` 记录投影，不单独写入 Session，不出现在 Workspace Session Tree，也不增加 Session 管理 revision。

### 2.3 创建 Run 时记录选择

现有请求继续使用：

```http
POST /api/sessions/:sessionId/chat/runs
```

```json
{
  "requestId": "request-1",
  "providerId": "deepseek",
  "modelId": "deepseek-v4-flash",
  "thinkingLevel": "medium",
  "message": "检查服务状态"
}
```

后端处理顺序：

1. 查找 Provider 和 Model。
2. 使用模型真实 `supportedThinkingLevels` 校验 `thinkingLevel`。
3. 插入 Chat Run。
4. 返回 Chat Run；Session 详情后续从最新 Run 投影该选择。

Run 中保存并返回的 `thinkingLevel` 必须与实际传给模型的等级一致。不能让 Run 显示 `max`，实际调用却被静默降级为 `high`。

当等级不再受模型支持时，返回结构化错误：

```json
{
  "error": {
    "code": "chat_thinking_level_unsupported",
    "message": "Thinking level is not supported by the selected model"
  }
}
```

幂等请求命中已有 Run 时，直接返回已有 Run。

## 3. 前端实现

### 3.1 类型与初始化

- 为 `LlmModel` 增加 `supportedThinkingLevels`。
- 增加 `SessionDetails.chatModelSelection`。
- Chat 页面模型恢复优先级：

```text
Active Run
  → Session chatModelSelection
  → 未选择
```

- 根据 `providerId + modelId` 从真实模型目录恢复完整 `LlmModel`。
- 保存的 Provider 未配置、模型已下线或模型目录加载失败时，不伪造模型对象；清空选择并提示重新选择。

### 3.2 思考等级选择器

- 模型只有 `["off"]` 时不展示等级选择器，发送固定 `off`。
- 模型包含多个等级时，在输入框操作区展示低权重选择项。
- 中文显示：
  - `off`：关闭
  - `minimal`：最小
  - `low`：低
  - `medium`：中
  - `high`：高
  - `xhigh`：极高
  - `max`：最大
- 切换模型后，如果当前等级不受新模型支持，回退到 `off`；若新模型不支持 `off`，使用 `supportedThinkingLevels[0]`。
- Active Run 期间模型和思考等级均不可修改。

### 3.3 发送与本地状态

- 普通 Chat 和首次消息创建 Session 的流程都发送用户选择的 `thinkingLevel`，删除固定的 `"off"`。
- 创建 Run 成功后，直接使用响应中的 `providerId`、`modelId` 和 `thinkingLevel` 更新本地状态。
- 每次发送后不重新请求 Session、消息列表或偏好接口。
- 收到 `chat_thinking_level_unsupported` 时刷新该 Provider 的模型目录，保留消息草稿并要求用户重新确认等级。

## 4. 不在本次范围

- Workspace 级或用户全局默认模型。
- Provider 自定义 Endpoint。
- 保存模型名称、上下文窗口或模型目录快照。
- 将模型偏好放入消息分页响应。
- 前端使用 Local Storage 或 Session Storage 持久化模型偏好。

## 5. 联调验收

- [x] 非推理模型只返回 `supportedThinkingLevels: ["off"]`。
- [x] 推理模型返回后端计算的真实等级集合。
- [x] 新 Session 的 `chatModelSelection` 为 `null`。
- [x] 首次创建 Run 后可从最近 Run 投影 Provider、Model 和实际思考等级。
- [x] 刷新 Session 页面后按 Session Details 恢复模型和思考等级。
- [x] Active Run 恢复信息优先于 Session 最近选择。
- [x] 后续创建 Run 成功后，前端不发起额外偏好查询。
- [x] 模型下线或 Credential 删除后，前端不会继续使用失效选择。
- [x] 不支持的思考等级返回结构化错误，不静默使用其他等级。
- [x] 最近选择投影不会导致 Session 管理 revision 变化。
- [ ] 使用真实 DeepSeek Credential 完成浏览器联调。

## 6. 实施顺序

1. 后端扩展模型目录 `supportedThinkingLevels`。
2. 后端通过 Session Details 返回最近 Run 的模型选择。
3. 后端在创建 Run 时校验等级并更新偏好。
4. 后端补充接口测试和迁移测试。
5. 前端同步类型并实现偏好恢复。
6. 前端增加思考等级选择器并移除固定 `off`。
7. 使用 DeepSeek Credential 完成刷新、切换模型和等级错误联调。
