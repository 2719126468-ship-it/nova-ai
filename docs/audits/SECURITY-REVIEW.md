# NOVA 安全与隐私审查

- 审查日期：2026-11-06
- 原始审查基线：`main @ 69bec32e1fbb8bfc2a6bf233737e2db414332634`
- 实施复核基线：`main @ 10a42e14de946e99554395b60c8a2b75b0e02546`
- 范围：当前跟踪源码、环境配置样例、认证、权限、路由、安全中间件、数据库访问与 CI。
- 结论：**适合受控开发测试；不足以据此宣称已完成公开生产安全审计。**

## 1. 已观察到的正向控制

| 控制 | 代码证据 | 判断 |
|---|---|---|
| API 密钥服务端保存 | Provider 从服务端环境/AI_PROVIDERS_JSON 私密配置解析 Key；Models/Health 仅返回 provider/model 元数据 | 正向；多 Provider 集成测试断言两个 Key 均不出现在响应中 |
| 环境文件忽略 | .gitignore 忽略 .env 和 .env.*，保留 .env.example | 正向；尚未执行全 Git 历史 secret scan |
| 密码哈希 | bcryptjs cost 12，密码字段不返回 publicUser | 正向 |
| Session Token | 32 bytes 随机值；数据库存 SHA-256 hash | 正向 |
| Cookie 属性 | HttpOnly；生产环境 Secure；SameSite Strict；Path=/api | 正向 |
| 管理权限 | requireAdmin 在服务端验证 role | 正向 |
| 资源归属 | Projects 与 Conversations SQL 查询都带 user_id 条件 | 正向；缺双账号自动化验证 |
| SQL 注入基础防护 | 数据读写主要使用 better-sqlite3 参数化语句 | 正向 |
| 请求来源校验 | CORS 精确匹配 WEB_ORIGIN；变更请求检查 Origin（若提供）及 NOVA-Web 请求头 | 有基础防护，但不应把自定义请求头视作秘密或独立认证 |
| 请求体限制 | Express JSON body 1 MB；单条 chat content 20,000 字符 | 正向，但仍缺上下文/Token 预算 |

## 2. 上线前风险

| ID | 风险 | 等级 | 当前依据 | 建议修复/验收 |
|---|---|---|---|---|
| SEC-01 | AI 资源缺少 per-user 配额与并发限制 | 高 | 当前是 API 通用 300 次/15 分钟、登录/注册 20 次/15 分钟，默认内存 Store；没有 AI 专属成本限制 | 增加用户+IP 双维限流、AI 并发、输入与上下文预算；429 行为自动化测试 |
| SEC-02 | 模型“可用/连接”状态可能误导 | 中 | /api/models 在 env 字段齐全时返回 available:true；没有上游健康验证 | 将 configured、enabled、health/status 分开；未探测状态显示 unknown/configured |
| SEC-03 | Provider 错误与耗时不可观测 | 中 | 当前只有通用错误响应与服务端 console；无结构化 requestId/usage_logs | 增加最小化日志、requestId、provider/model、错误类别和耗时；不记录 API Key/不必要提示词 |
| SEC-04 | 无数据库迁移和恢复演练 | 高（公开生产前） | db.js 直接 CREATE TABLE；没有版本化迁移/恢复步骤执行证据 | migrations、定期备份、恢复演练、升级测试 |
| SEC-05 | CSP 被关闭 | 中 | Helmet 使用 contentSecurityPolicy:false | 在生产构建确认资源来源后增加 CSP；避免为方便而永久关闭 |
| SEC-06 | 缺少账户删除/数据导出 | 中（隐私发布前） | auth 路由无账户删除/导出接口 | 明确数据保留政策，提供账户数据导出和可验证删除流程 |
| SEC-07 | 第三方模型数据告知不足 | 高（连接外部模型并公开前） | 当前 Chat UI 有一般性错误/核验提示，但缺少清晰告知提示词/文件将发送到第三方模型服务 | 在首个模型调用前说明目的、第三方处理、保留/训练条款链接和用户控制方式 |
| SEC-08 | CSRF 方案仅为来源和请求头校验 | 中 | Origin 缺失时仍允许继续；X-Requested-With 是浏览器请求特征，不是秘密 token | 同源部署优先；生产浏览器请求要求受信任 Origin；评估 CSRF Token/双重 Cookie；增加跨站测试 |
| SEC-09 | Session 过期记录未见清理任务 | 低/中 | 每次认证会检查 expires_at，但没有定期清理过期 sessions 的代码 | 登录时轻量清理或维护任务；确认索引和清理性能 |
| SEC-10 | 管理员操作缺少审计轨迹 | 中 | 管理员可更改用户角色，但没有记录操作者、目标、时间和前后值的审计表 | 增加 admin_audit_logs；禁止记录秘密与不必要内容 |
| SEC-11 | 缺少强制安全配置检查和部署验证 | 中 | assertConfig 检查 Session Secret 与 Port；没有反向代理、TLS 和多实例实测 | 上线清单明确 HTTPS、可信代理、Cookie、持久卷、备份与限流 Store |

## 3. 当前仓库检查

- 当前 main 跟踪树包含 `.env.example`，未见实际 `.env`、SQLite 数据库或日志文件。
- `.gitignore` 排除了 `.env`、数据库文件、日志、node_modules 和构建产物。
- 这只能说明当前跟踪树的观察结果，**不等同于已对全部 Git 历史、所有工作流产物和外部部署环境完成 secret scan**。
- 当前没有文件上传接口，因此尚不存在上传解析攻击面；实现上传前必须补齐白名单、文件签名、大小/数量限制、隔离存储、恶意文件处理和保留期。
- 不应把用户提示词、上传文件或模型密钥写入普通应用日志。

## 4. 发布门槛

公开接入真实第三方模型之前，至少完成 SEC-01、SEC-02、SEC-07，并验证模型密钥仅存在服务器端。

开放注册并保存私人内容之前，完成双用户越权测试、账户数据删除/导出策略、会话撤销与备份恢复演练。

面向公网大规模开放之前，完成生产 CSP、可靠的共享限流/并发控制、监控告警和独立安全测试。SQLite 单实例可以用于早期低流量部署，但不能默认支持多实例并发写入和跨实例限流。

## 5. 审查限制

本文件是基于源码的静态审查，不是渗透测试。未执行公网扫描、模糊测试、压力测试、依赖漏洞深度审查或完整历史密钥扫描。所有“正向”只表示代码中观察到相应控制，不构成安全认证。


## 6. 2026-11-06 实施更新

以下是代码层面的进展，不替代独立安全测试：

| 原风险 | 当前状态 | 证据 / 剩余边界 |
|---|---|---|
| SEC-01 AI 配额与并发 | **部分缓解** | 对已认证用户的 legacy 与 SSE 消息端点统一限制为每分钟 6 次；同一进程内同一用户最多一个活动生成，冲突返回 409。并发测试已验证流式任务执行中，旧版 JSON 接口也会被同一锁拦截；每用户频率限制集成测试已通过 CI。双账号项目/对话越权测试、上游 401/429/503/空流/超时分类测试均通过。限流与锁使用进程内存，仍需在多实例部署前接入共享存储；上下文 Token 预算、IP+用户组合策略仍待补齐；已增加 AI_MAX_CONTEXT_CHARS 字符级消息内容预算，超限输入返回 413，但这不是 Token 计数或模型真实上下文窗口。 |
| SEC-02 模型状态误导 | **已修复接口语义** | `/api/v1/models` 分开返回 configured/enabled/selectable/status；仅配置未探测时 health 为 unknown、状态为 configured_unverified，不再显示为已连接。尚无主动健康探测。 |
| SEC-04 数据库迁移 | **已实现基础迁移** | 增加 schema_migrations，启动时执行版本化迁移；消息增加 complete/streaming/failed/cancelled 和 error_code，迁移可重复运行。尚未做备份恢复演练与生产旧库恢复演练。 |
| Zod 高危依赖 | **已修复** | Zod 由 3.25.76 升至 4.6.7；认证和研究验证错误格式改用 z.flattenError；最新 CI 的 npm ci 审计为 0 vulnerabilities。 |
| 消息断连与取消 | **已实现并通过集成测试** | 真实 HTTP 客户端中止 SSE 后，CI 验证上游连接关闭、部分内容持久化且消息状态为 cancelled；Provider 超时也已覆盖。仍需在目标手机浏览器做真实设备回归。 |

公开发布前仍必须处理 SEC-07（第三方模型数据告知），并完成 SEC-08 CSRF/Origin 严格策略、双用户隔离测试、备份恢复演练及部署环境验证。不能因 CI 通过就宣称通过完整安全审计。


项目-会话关联安全复核：关联、列表与解除接口均以当前会话用户 ID 过滤项目和对话；不能通过提交其他账户的 projectId 或 conversationId 建立关系。CI 双账号测试覆盖读取他人项目关联、把他人对话加入自有项目、把自有对话加入他人项目，均返回 404。关系表外键启用级联清理。此结论仅限已覆盖的 API 路径，不代表完整渗透测试。


模型注册表安全复核（2026-11-06）：多 Provider 原始配置（baseUrl、apiKey）仅保留在服务端私有注册表；公开 Models API 只返回 provider id/name/configuration state/model metadata，不返回 API Key 或 baseUrl。CI 的多 Provider 集成测试使用两个独立的私密 Key，验证 Models 和 Health 响应均不包含 Key，且请求会使用对应 Provider 的 Authorization header 与 upstream model ID。配置文件只应写入服务器环境，不要提交真实 AI_PROVIDERS_JSON 到仓库。尚未进行完整 Git 历史密钥扫描或生产部署验证。


按需 Provider 连接检查已新增：仅允许已登录用户使用，每用户每分钟最多 5 次；服务端使用对应私密 Key 读取 Provider `/models`，只在模型 ID 得到目录确认时标记 healthy；不支持该端点或不能确认时保持 unknown。此检查不生成模型回答、不发送用户提示词、不持久化长期健康状态。真实部署仍需验证上游各家 `/models` 兼容性和反向代理超时行为。
