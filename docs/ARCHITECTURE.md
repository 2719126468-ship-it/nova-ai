# NOVA 架构说明

## 运行边界

```text
Browser (React + Vite)
        │ REST / JSON + HttpOnly session cookie
        ▼
Express API
  ├── Auth & Sessions
  ├── Projects
  ├── Conversations & Messages
  ├── Research CMS
  ├── Admin / RBAC
  └── Provider Adapter ─────► OpenAI-compatible API (optional)
        │
        ▼
SQLite (users / sessions / projects / conversations / messages / articles)
```

## 原则

1. **模型服务与产品数据解耦。** Chat UI 只依赖 NOVA 自己的 API，不直接访问第三方模型供应商。
2. **密钥只在服务端。** 前端读取不到 `AI_API_KEY`。`/api/health` 与 `/api/models` 只返回是否配置和模型标识。
3. **身份与权限由服务端判断。** 前端路由保护是用户体验，真正权限检查在 Express middleware。
4. **用户数据按所有权隔离。** 项目、对话均在 SQL 查询中加入 `user_id` 条件。
5. **无模型时明确失败。** Provider 未配置返回结构化 503，不插入一条伪造 assistant 回复。

## 数据实体

- `users`: 账户资料、密码哈希与 `user/admin` 角色。
- `sessions`: 单个登录会话的 token hash 与过期时间。
- `projects`: 用户拥有的标题、描述与内容。
- `conversations`: 用户拥有的聊天线程。
- `messages`: 对话中的 user / assistant 消息。
- `articles`: Research CMS 文章、状态、作者与发布时间。

## 会话流程

注册或登录时生成 256-bit 随机 token。浏览器只收到 HttpOnly Cookie；数据库只保存 token 的 SHA-256 摘要。每次受保护请求从 Cookie 取 token，计算摘要后查询未过期会话。注销会删除对应会话记录并清除 Cookie。

## AI 请求流程

1. 客户端把消息发送到 `POST /api/conversations/:id/messages`。
2. 服务端验证用户会话，并确认对话归当前用户所有。
3. Provider adapter 检查 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL`。
4. 若未配置则返回 `503 AI_PROVIDER_NOT_CONFIGURED`，不写入本次消息。
5. 若已配置，服务端携带历史消息调用 OpenAI-compatible `/chat/completions`。
6. 成功后在一个 SQLite transaction 中写入 user 与 assistant 消息，并更新对话时间。

## 部署拓扑建议

生产环境建议将 Web 与 API 部署在同一主站点下，例如 `app.example.com` 与 `api.example.com`，使用 HTTPS，并将 `WEB_ORIGIN` 设置为实际 Web 来源。使用托管容器或持久化磁盘保存 `server/data/nova.sqlite`。高并发或多实例部署前，应将 SQLite 迁移到 PostgreSQL，并把登录限流存储迁移到 Redis 等共享存储。
