# NOVA AI 开发路线图

- Updated: 2026-11-07
- 当前基线：`main`
- 详细任务状态以 [NOVA Development Tracker](DEVELOPMENT-TRACKER.md) 为准。
- 当前策略：先完成 V0.1 发布门槛与 V0.2 工作流闭环，不重建已工作的核心模块。

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
- [ ] 完善文档重命名、归档和更丰富的编辑体验
- [ ] 真机验证文档自动保存、文件选择/上传、下载和项目上下文开关

## V0.3 — Research 与 Provider 扩展

- [ ] 接入真实搜索 Provider，保留来源 URL、标题、时间和检索元数据
- [ ] 研究计划、可验证引用、结构化报告、保存与 Markdown 导出
- [ ] 明确区分检索事实、模型综合和未证实推测
- [ ] 原生 Anthropic API Adapter
- [ ] OAuth / 浏览器登录型 Provider 的独立会话与协议适配
- [ ] 可控模型自动发现、健康巡检和故障切换

Research 文章 CMS 与本地分类/筛选不等于已接入互联网搜索；未得到真实检索结果时不得声称已经搜索。

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
- PR #13 CI run #86：33/33 API tests passed；production web build passed。
- 主分支合并后 CI 继续运行；不在该 run 完成前把 main 标记为已完成最终验证。
- 包版本保持 `0.1.0`，仅在对应版本的发布验收完成后升级。
