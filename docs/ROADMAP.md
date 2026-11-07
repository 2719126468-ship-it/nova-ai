# NOVA AI 开发路线图

- Updated: 2026-11-07
- 当前基线：`main`
- 详细任务状态以 [NOVA Development Tracker](DEVELOPMENT-TRACKER.md) 为准。
- 当前策略：先完成 V0.1 发布门槛与 V0.2 工作流闭环，再推进 V0.3 Research；不重建已工作的核心模块。

## V0.1 — 核心对话系统

**状态：核心实现已具备；设备、安全和公开发布验收仍未完成。**

已完成：
- [x] 注册、登录、注销、HttpOnly 服务端会话、个人资料与密码管理
- [x] 用户数据隔离、Projects CRUD、项目与对话关联
- [x] 多轮聊天、SSE 流式输出、停止生成、断连取消和错误归一化
- [x] 会话重命名/删除、消息编辑、重试/重新生成、回答版本历史与恢复
- [x] Markdown/GFM、代码高亮、代码块复制
- [x] 多 OpenAI-compatible Provider / Model registry、模型切换、管理员管理和密钥加密
- [x] 模型上下文预算、Token 来源标识、输出预留和历史裁剪
- [x] AI 用量记录、管理员统计、账户数据导出与账户删除
- [x] SQLite 版本迁移、关键 API 权限与 Provider 故障回归测试

发布验收仍待：
- [ ] Playwright 端到端和 Android 浏览器真机回归（包括 Mate 20 Pro）
- [ ] 生产 CSP、严格 CSRF/Origin 策略和第三方模型数据处理告知
- [ ] SQLite 备份/恢复演练、部署环境验证和日志/错误监控
- [ ] 管理员审计日志、完整依赖与历史密钥扫描
- [ ] 独立安全审查；CI 通过不等于完成渗透测试或生产安全认证

## V0.2 — AI 工作空间

**状态：Documents 与 Project Context 第一版已合并；继续完善跨模块工作流。**

已完成：
- [x] 项目内会话关联、项目指令和项目资料管理
- [x] 私有 Markdown Documents 文档库、项目关联、创建/编辑/预览
- [x] 850 ms 防抖自动保存、版本冲突恢复、Markdown 下载
- [x] TXT / Markdown / CSV / JSON 项目资料上传、下载和删除
- [x] 文件默认不加入上下文，用户显式启用后才可用于项目对话
- [x] 项目资料按所有者隔离、内容长度限制和账户导出/删除
- [x] Chat 显示项目指令/文件上下文的载入、截断或省略状态

下一步：
- [x] Chat → Documents：从任意完整 AI 回答创建 Markdown 文档，可选择个人空间或项目，并直接打开继续编辑
- [x] 文档标题重命名（自动保存）与归档/恢复（`archived_at`，列表按进行中/已归档分组）
- [ ] 更丰富的编辑体验（格式工具栏、图片、协同与完整版本快照仍待规划）
- [ ] 真机验证文档自动保存、文件选择/上传、下载和项目上下文开关
- [x] Documents 刷新/冲突恢复改进已随 `feat/research-search-workspace` 进入 `main`

## V0.3 — Research 与 Provider 扩展

**进度：真实搜索适配与带引用的来源整理已实现于 Draft PR #16；等待审查与真实 Provider 配置验证。**

- [ ] 接入真实搜索 Provider，保留来源 URL、标题、时间和检索元数据（SearXNG/Brave 适配已实现；真实部署连接未验收）
- [ ] 研究计划、可验证引用、结构化报告、保存与 Markdown 导出（来源选择、笔记、综合分析输入、引用索引和 Markdown 保存已实现；由模型自动生成研究计划/正文仍待实现）
- [x] 明确区分检索事实、模型综合和未证实推测（Research 报告分为检索资料/我的综合分析/未证实推测三节）
- [ ] 原生 Anthropic API Adapter
- [ ] OAuth / 浏览器登录型 Provider 的独立会话与协议适配
- [ ] 可控模型自动发现、健康巡检和故障切换

Research 文章 CMS 与本地分类/筛选不等于已接入互联网搜索；必须使用已配置 Provider 的真实返回结果，未得到真实检索结果时不得声称已经搜索。CI 使用本地/Stub 响应只验证适配协议，不代表外部 Provider 已连通。

## V1.0 — 稳定公开版本

- [ ] HTTPS、可靠持久化部署、备份与恢复演练
- [ ] 生产监控、错误告警、日志脱敏和管理员审计
- [ ] 隐私政策、服务条款、第三方模型数据告知和账户数据处理流程
- [ ] 完整安全审查、端到端测试、压力测试和滥用处理
- [ ] 有多实例需求后再评估 PostgreSQL 与共享限流存储

## 审计与状态入口

- [正式产品基线](PRODUCT-BASELINE.md)
- [开发任务追踪](DEVELOPMENT-TRACKER.md)
- [V0.1 实现审计](audits/NOVA-V0.1-IMPLEMENTATION-AUDIT.md)
- [技术债清单](audits/TECH-DEBT.md)
- [安全与隐私审查](audits/SECURITY-REVIEW.md)
- [V0.1 Backlog](audits/V0.1-BACKLOG.md)

## 最近验收记录

- 2026-11-07：PR #13 merged，Project Context 和受控文本资料管理进入 `main`。
- 2026-11-07：Draft PR #16 添加 Research 搜索/引用工作流、Documents 小范围可靠性修复和源码安全/移动端审查记录；CI run #95 通过 38/38 API tests 与生产构建。PR #16 未合并，真实 Provider 和 Android 真机验收仍待完成。
- PR #13 CI run #86：33/33 API tests passed；production web build passed。
- 主分支合并后 CI 继续运行；不在该 run 完成前把 main 标记为已完成最终验证。
- 包版本保持 `0.1.0`，仅在对应版本的发布验收完成后升级。

## 2026-11-07 — B4-01 自动化验收完成

- 已启用 API 与文档级 CSP，生产环境强制受信任 Origin，过期 Session 定期清理。
- 迁移 v9 增加管理员审计日志；错误按稳定错误码聚合，管理员可在 Admin → 审计日志 / 错误监控查看。
- 新增 `db:backup` / `db:restore` / `db:verify`：在线备份、完整性校验、sha256 清单、回滚安全恢复。
- 新增 `npm run e2e`：17 项浏览器检查（注册、会话、Chat 未配置提示、项目创建、文档自动保存与刷新持久化、360px 布局、移动导航、Admin 三个面板），CI 增加 `browser-smoke` job。
- API 进程可直接托管 `client/dist` 并提供 SPA 深链回退，客户端默认同源请求。
- 仍未完成：独立渗透测试、完整 Git 历史密钥扫描、外部告警、Android 真机验收、第三方模型数据告知。详见 `docs/audits/B4-01-VERIFICATION.md`。
