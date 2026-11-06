# NOVA 安全与隐私审查

- 审查日期：2026-11-06
- 基线：`main @ 69bec32e1fbb8bfc2a6bf233737e2db414332634`
- 范围：当前跟踪源码、环境配置样例、认证、权限、路由、安全中间件、数据库访问与 CI。
- 结论：**适合受控开发测试；不足以据此宣称已完成公开生产安全审计。**

## 1. 已观察到的正向控制

| 控制 | 代码证据 | 判断 |
|---|---|---|
| API 密钥服务端保存 | Provider 从服务端 config 读取 AI_API_KEY；前端 health/models 不读取密钥 | 正向 |
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
