# NOVA AI 开发路线图

当前产品目标与优先级以 [正式产品基线](PRODUCT-BASELINE.md) 为准。当前唯一主线是 V0.1 核心对话系统；不并行扩张为大量静态模块。

## 0.1 — 核心对话系统（当前阶段）

### 已经具备的基础
- [x] React 产品前端、独立页面、响应式布局与主题切换
- [x] 注册、登录、注销、HttpOnly 服务端会话
- [x] SQLite 用户、会话、项目、对话、消息和研究文章表
- [x] Projects 基础 CRUD
- [x] Conversations 列表、读取、创建、删除和消息持久化
- [x] OpenAI-compatible Provider 的非流式基础调用
- [x] Markdown/GFM 消息展示
- [x] 基础管理员角色、用户管理和 Research CMS
- [x] 基础安全中间件和 GitHub Actions CI

### V0.1 尚未完成（P0）
- [ ] Provider 接口升级为流式/非流式统一适配，支持错误归一化和取消
- [ ] SSE 增量输出、停止生成、客户端断连后取消上游
- [ ] 服务端 Model/Provider Registry，多模型列表、能力和真实状态
- [ ] Chat 模型选择、代码高亮、复制、编辑、重试和重新生成
- [ ] 会话重命名；项目与会话关联
- [ ] 按模型上下文窗口预算管理历史
- [ ] AI 专属并发、每用户限流、资源配额和用量日志
- [ ] 数据库 migrations
- [ ] 双用户隔离、Provider 错误、流式取消、管理员和限流回归测试
- [ ] 移动端端到端测试、账户导出/删除和隐私告知

完成定义见 [V0.1 Backlog](audits/V0.1-BACKLOG.md)。

## 0.2 — AI 工作空间

- [ ] Projects 深化：项目内会话、项目指令和项目内容组织
- [ ] Documents：Markdown 文档创建、编辑、自动保存、重命名、删除和导出
- [ ] 对话结果生成文档
- [ ] 严格受限的文件上传与解析

## 0.3 — Research 与 Provider 扩展

- [ ] 接入真实搜索服务并管理来源
- [ ] 研究计划、来源引用、结构化报告、保存和导出
- [ ] 多 Provider 与模型能力扩展
- [ ] 模型健康状态和失败统计

## 1.0 — 稳定公开版本

- [ ] HTTPS、持久化部署、备份和恢复演练
- [ ] 生产日志、错误监控、告警和依赖审查
- [ ] PostgreSQL/共享限流存储（仅在多实例或容量需要时）
- [ ] 完整隐私流程、安全审计、端到端与压力测试

## 审计资料

- [正式产品基线](PRODUCT-BASELINE.md)
- [V0.1 实现审计](audits/NOVA-V0.1-IMPLEMENTATION-AUDIT.md)
- [技术债清单](audits/TECH-DEBT.md)
- [安全与隐私审查](audits/SECURITY-REVIEW.md)
- [开发任务清单](audits/V0.1-BACKLOG.md)


## 2026-11-06 实施进度

V0.1 已进入可验证的流式聊天阶段：版本化 API、SQLite 消息状态迁移、单 Provider SSE、停止生成、会话重命名、复制消息及模型状态语义已落地。已加入并通过 CI 的每用户频率限制、跨 legacy/SSE 单用户并发保护、双账号项目/对话隔离和 Provider 错误分类测试。当前主线继续只聚焦 Chat；接下来优先补齐 Provider 故障/取消测试、上下文预算、跨用户隔离与编辑/重试/重新生成。V0.1 尚未达到公开生产发布标准。


上下文策略进度：已实现 `AI_MAX_CONTEXT_CHARS` 字符预算，按最近完整轮次保留历史，并在当前消息超限时于调用 Provider 前返回 413；Provider Token 计数与模型上下文窗口仍未验证。


移动端性能进展：路由页面已通过 React.lazy 按需加载，CI 构建的入口 JS 为 276.17 kB（gzip 88.45 kB），共享库 163.12 kB（gzip 48.91 kB），Vite 不再报告超过 500 kB 的 chunk。尚未完成真实 Android 浏览器端到端回归。


Projects delivery update (2026-11-06): project-conversation migration v2, owner-scoped link/list/unlink APIs, Studio association management, and direct opening of a selected conversation in Chat are implemented. CI verifies cross-account rejection and passes 23 API tests. Project instructions, richer project context, and Documents remain later work.
