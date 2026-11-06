# NOVA V0.1 实现审计

- 审计日期：2026-11-06
- 仓库：`2719126468-ship-it/nova-ai`
- 审计分支：`main`
- 审计基线提交：`69bec32e1fbb8bfc2a6bf233737e2db414332634`
- 方法：检查 GitHub 当前跟踪文件、页面/路由/数据库/Provider/认证/安全中间件/测试和 Actions 结果。
- CI 记录：[NOVA CI run 42225022235](https://github.com/2719126468-ship-it/nova-ai/actions/runs/42225022235)

## 1. 总体结论

当前项目已经是有真实后端与持久化的全栈基础版，不是纯静态模板。注册/登录、HttpOnly 会话、用户资料、项目 CRUD、对话列表/读取/删除、非流式模型请求、Research CMS 和管理员角色控制都有代码实现。

但**当前不能标记为 V0.1 完成**。核心差距集中在 Chat 产品闭环：没有 SSE 流式输出、停止生成、模型切换、重命名、编辑/重新生成/重试、代码高亮与复制；模型目录也尚非真正的 Provider/Model Registry。当前 AI 调用是一次性 JSON 请求，只有在整个上游回复完成后才写入消息并返回。

## 2. CI 与可复现性证据

基线 CI run 42225022235 为成功，执行步骤包含：

- `npm ci`：通过。
- `npm test`：通过，Node test runner 报告 5/5 tests passed。
- `npm run build`：通过；Vite 8.3.6 构建成功。

构建有一个非阻断警告：主 JavaScript bundle 约 501.15 kB（gzip 约 155.61 kB），超过 Vite 默认 500 kB chunk 提示阈值。需要后续按页面拆分动态加载，不能把此警告误报成构建失败。

当前 5 项测试覆盖健康检查、注册 Cookie、用户自身项目 CRUD、缺少自定义请求头的拦截，以及未配置 AI Provider 时返回 503。尚未覆盖跨用户隔离、真实 Provider、SSE、取消、错误分支、管理员权限和限流。

## 3. PRD 对照表

状态定义：**已实现** = 源码中存在完整的基础行为；**部分实现** = 有基础路径但缺关键验收能力；**未实现** = 当前仓库没有相应实现；**未验证** = 有代码但缺足够自动化/设备证据。

### 模块 A — AI Chat（P0）

| 需求 | 状态 | 代码证据与说明 |
|---|---|---|
| 新建对话 | 已实现 | Chat 页面调用 `POST /api/conversations`。 |
| 对话列表与打开 | 已实现 | `GET /api/conversations`、`GET /api/conversations/:id`，按当前用户查询。 |
| 多轮上下文 | 部分实现 | 服务端取最近 30 条消息并附加当前输入；没有 Token/contextLimit 预算与摘要裁剪。 |
| 消息持久化 | 部分实现 | Provider 成功后事务性写入 user/assistant；上游失败时本轮 user 消息不会存档。 |
| 流式输出 | 未实现 | Provider 使用 `fetch` 后等待 JSON 完整返回；无 SSE/ReadableStream。 |
| 停止生成 | 未实现 | 没有客户端 AbortController、停止接口或服务端请求取消注册表。 |
| 会话重命名 | 未实现 | conversations 路由没有 PATCH/PUT 元数据接口。 |
| 删除会话 | 已实现 | `DELETE /api/conversations/:id`，SQL 同时校验 user_id。 |
| 复制回复 | 未实现 | 消息 UI 无复制动作。 |
| 编辑用户消息 | 未实现 | 没有消息更新/分支重建接口。 |
| 重新生成/重试 | 未实现 | 无重新生成接口；失败后用户需重新提交。 |
| Markdown/GFM | 已实现 | 使用 react-markdown 与 remark-gfm。 |
| 代码高亮/复制 | 未实现 | 未发现高亮插件或代码块复制行为。 |
| 模型选择 | 未实现 | Chat 顶栏目前展示固定的“NOVA Intelligence”，没有选模控件。 |
| 错误提示/保留草稿 | 部分实现 | 页面显示错误且仅成功后清空 draft；无针对限流、额度不足、模型失效的细分操作。 |

### 模块 B — Models（P0）

**部分实现。** `GET /api/models` 仅根据 `AI_BASE_URL`、`AI_API_KEY`、`AI_MODEL` 环境变量返回 0 或 1 个模型。当前没有 providers/models 持久化表、Provider Registry、多模型列表或管理员启停配置。接口将“环境变量齐全”映射为 `available: true`，但没有探测上游，因此不等于真实健康/可用；前端的 CONNECTED 文案容易让用户误解。

### 模块 C — Projects（P0 基础版）

**部分实现。** 项目创建、读取、编辑、删除和所有权校验已经完成；但数据库没有 `project_conversations` 关联表，项目无法关联和查看其对话，因此 PRD 的项目工作区验收未完成。

### 模块 D — Documents（P1）

**未实现。** 目前只有 Studio 项目内容字段，没有独立 documents 实体、自动保存、版本、导出或 AI 对话转文档流程。

### 模块 E — Research（P1）

**部分实现。** 有文章列表、分类/搜索（本地列表过滤）、文章详情和管理员 CMS；没有联网搜索 Provider、来源管理、研究计划、真实来源引用或报告生成工作流。数据库初始化会插入示例文章；README/页面已提示演示内容，正式发布前仍须审核。

### 模块 F — Account & Settings（P0）

**部分实现，基础账户链路已实现。** 注册、登录、退出、当前用户、资料修改、密码修改均有后端路由。密码修改会删除该用户全部 session 并清 Cookie。未发现账号删除、个人数据导出、邮箱验证或密码找回。主题状态有前端实现，但持久化方式需单独核对用户预期（当前由客户端 ThemeContext 管理）。

### 模块 G — Admin（P0 基础管理）

**部分实现。** 有管理员中间件、概览统计、用户列表、角色修改、Research CMS；没有模型/Provider 管理、真实健康探测、调用用量统计、错误事件面板、用户禁用/封禁和管理员审计日志。

### 非功能要求

| 要求 | 状态 | 说明 |
|---|---|---|
| 服务端用户数据隔离 | 部分实现 | Projects/Conversations 查询包含 user_id；但目前缺少双用户越权回归测试。 |
| 密钥不进入前端 | 已实现（按当前代码） | Provider 在服务端读取环境变量；health/models 不返回 API Key。仍需对 Git 历史做独立 secret scan。 |
| 基础请求限流 | 部分实现 | API 300 次/15 分钟，登录/注册 20 次/15 分钟；默认内存 Store，非用户维度，也无 AI 并发/配额限制。 |
| 超时 | 已实现 | Provider 有 AbortController timeout。 |
| 客户端取消上游请求 | 未实现 | 没有客户端取消到上游的传播。 |
| 上下文/Token 预算 | 未实现 | 只取最近 30 条消息，没有按模型上下文窗口计算。 |
| 数据库迁移 | 未实现 | db.js 启动时直接 CREATE TABLE IF NOT EXISTS，无 migration 版本表/脚本。 |
| 用量日志 | 未实现 | 没有 usage_logs 表，也没有按上游响应记录 usage。 |
| 文件上传 | 未实现 | 当前无上传路由，属于 P1；启用前需安全约束。 |
| 移动端体验 | 部分实现/未验证 | 有响应式 CSS；尚无 Playwright 真机尺寸/交互回归。 |
| 部署与恢复 | 未验证 | 文档说明 SQLite 持久化与备份原则，但仓库没有部署、备份恢复或实际生产证据。 |

## 4. 关键结论

1. 当前最核心的差距不是“再增加页面”，而是将现有非流式 Chat 提升为有取消、状态、模型选择和完整消息操作的工作区。
2. Models 页面目前显示的是配置状态，不是真实健康状态；应修正文案和 API 字段语义。
3. Projects 还没有与 Conversations 关联，距离 PRD 的“将对话归入项目”有明确数据模型缺口。
4. 当前路径使用 `/api`，而正式 PRD 要求 `/api/v1`。应在正式发布前完成版本化，并考虑兼容过渡。
5. 当前 CI 绿色只代表这 5 项 API 测试和 Vite 构建通过，不代表 V0.1 或生产安全验收通过。

## 5. 本次审计范围限制

本审计是基于当前 GitHub main 分支源码及已显示 CI 记录的静态代码审查。没有对真实模型密钥进行端到端调用，没有进行公网渗透测试、负载测试、真机操作或完整 Git 历史 secret scan。因此相关项目均标为未验证，而不是宣称通过。


## 2026-11-06 增量复核

本节更新优先级高于上文基于早期审计 SHA 的历史快照。当前 main 已实现并通过 CI 的增量：

- Chat：SSE 流式输出、停止/断连取消、会话重命名/删除、复制、编辑用户消息、末轮回答重新生成、失败回答重试。
- Model/Provider：服务端 AI_PROVIDERS_JSON 多 OpenAI-compatible Provider 注册；每家可登记多个模型、启用状态与能力；AI_DEFAULT_MODEL 可指定默认；Chat 选择器只显示 selectable 模型，所选 ID 在服务端映射上游 URL、API Key 和上游 model ID。旧 AI_BASE_URL/AI_API_KEY/AI_MODEL 保持兼容。
- 密钥保护：公开 Models/Health 接口只返回 Provider/Model 元数据，不返回 API Key 或 baseUrl。CI 集成测试验证两家不同 Provider 各自路由成功且密钥不出现在响应中。
- Projects：project_conversations v2 迁移、归属校验 API、Studio 关联/移除及从项目直接打开指定对话。
- Context：AI_MAX_CONTEXT_CHARS 字符预算（不是 Token 计量）。
- 性能：React.lazy 路由拆包，构建主入口约 277 kB、gzip 约 89 kB，不再触发 500 kB chunk 警告。
- 依赖：Zod 升级至 4.6.7；最新验证 CI 的 npm ci 审计为 0 vulnerabilities。

最近一轮已完成的 CI 为 24/24 API tests、Vite production build success。仍未满足 V0.1 完成/公开发布的项目包括：主动 Provider 健康探测、管理员 Provider/Model 配置 UI、准确 usage 日志和管理员统计、403/畸形流等故障覆盖、精确 Token/contextLimit 预算、回答版本历史/撤销、账户数据导出/删除、第三方模型数据告知、严格 CSRF/Origin 策略、真机/Playwright E2E、备份恢复演练。OAuth/浏览器登录型 Provider（例如需要网页登录态的模型平台）不是当前 OpenAI-compatible JSON 注册表已经支持的能力，仍需独立适配。


## 账户数据生命周期增量（2026-11-06）

账户 API 已增加 GET /api/v1/auth/export 与 DELETE /api/v1/auth/me。导出包含当前用户资料、项目、项目关联、对话、消息和本人创建的 Research 文章；不会包含 password_hash、session token/hash 或 Provider API Key，并设置 Cache-Control: no-store。删除账户要求当前密码与邮箱二次确认，成功后清除会话 cookie；SQLite 外键级联移除个人项目、对话、消息、项目关联和登录会话。已发布 Research 文章作为站点内容保留，author_id 在删除后设为 NULL。

该能力已添加集成测试：导出内容范围和凭据排除；错误密码/邮箱不得删除；成功删除后级联行均清零且 CMS 作者关联解除。备份副本的保留窗口、恢复后删除同步和用户删除 SLA 仍需部署前制定。
