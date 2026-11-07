# NOVA AI — Research、Documents、安全与移动端源码审查

- 审查日期：2026-11-07
- 对照基线：`main @ 98c2ec67342028fc98316aaf5f89d1fcc5c0cc48`
- 实施分支：`feat/research-search-workspace`
- 范围：Research 外部搜索与来源整理、Documents 编辑和保存链路、认证/授权/会话/API Key/数据隔离、Android 小屏源码适配。
- 验收策略：本阶段执行源码检查、自动化 API 测试和生产构建；Android 真机测试统一延后。

## 1. Research

### 基线发现

主分支原有 `/research` 只读取已发布的 `articles`，页面搜索与分类筛选只针对本地文章列表。它是编辑内容 CMS，不是互联网搜索，原有实现没有实时外部检索、检索来源 URL 或来源引用。

### 本分支实现

- 新增认证后的 `POST /api/v1/research/search`。
- 搜索 Provider 支持 SearXNG 和 Brave Search；当服务器没有配置可用 Provider 时，返回明确的 `RESEARCH_SEARCH_NOT_CONFIGURED`，不生成假结果。
- SearXNG 通过服务端配置的基础 URL 请求 `/search?format=json`；Brave 通过固定官方 API endpoint 请求，认证头只在服务端设置。
- 每个请求最多返回 10 条结果；每个用户每分钟最多 8 次搜索。
- 搜索请求需要有效登录会话；响应设置 `Cache-Control: no-store`。
- 搜索超时、网络错误、上游 401/403、429、5xx、无效 JSON 和超大响应均有独立的可读错误分类。
- 来源 URL 仅接受 HTTP/HTTPS，过滤带账号密码的 URL、重复 URL 和无标题项目。响应包含来源标题、URL、域名、摘要、页面日期、检索引擎和 Provider。
- Research 页面保留原有精选文章视图，新增网络研究视图。用户可以选取来源、写研究笔记，并将带检索时间、摘要、来源链接和引用索引的 Markdown 报告保存到自己的 Documents。
- 搜索结果只作为“检索资料/摘要”展示；页面明确提示摘要并非事实核验，不自动生成没有来源支撑的结论。

### 服务端配置

SearXNG 适合不使用商业搜索 API Key 的自托管方式。服务器需设置 `RESEARCH_SEARCH_PROVIDER=searxng`、`RESEARCH_SEARCH_URL=https://<your-searxng-instance>`，并确保该 SearXNG 实例启用了 JSON 输出格式。

替代方式是设置 `RESEARCH_SEARCH_PROVIDER=brave` 和服务器端 `BRAVE_SEARCH_API_KEY`。也可省略 Provider 名称，让服务端根据已配置的 SearXNG URL 或 Brave Key 自动选择。任何搜索密钥都不进入前端、浏览器存储或公开响应。

当前仓库 CI 使用本地测试 HTTP 服务模拟 SearXNG 响应结构，并 stub Brave API 响应以验证服务端认证头和数据脱敏；这证明适配器协议与安全边界，不代表真实部署已连通外部搜索。实际联网验收仍需提供真实 SearXNG 地址或 Brave Key。

## 2. Documents

### 已检查的现有能力

- `server/src/routes/documents.js` 所有 CRUD/list 接口都要求登录；读、改、删 SQL 按 `user_id` 限定。
- 创建/更新项目关联前，会再次确认项目属于当前用户。
- 更新必须提供 `expectedVersion`；版本过期返回 409 `DOCUMENT_VERSION_CONFLICT`，写入 SQL 也包含版本条件。
- 列表支持标题关键词、项目筛选、分页和 `Cache-Control: no-store`。
- Chat 完整回答保存复用 Documents API，不增加新表或绕过项目归属验证。
- 编辑器 850 ms 防抖自动保存；冲突时保留本地 buffer，可读取最新版本或另存为副本。
- 文档内容通过账户导出包含在用户私有数据中；账户删除按现有数据库外键生命周期处理。

### 本次发现和修复

- Documents 列表刷新按钮原先调用未定义的 `load()`，点击会产生运行时错误。已改成共享的文档加载请求函数，并统一处理 loading/error。
- 文档编辑初始化原先对正文与项目列表使用 `Promise.all`；项目列表短暂失败会阻断正文编辑。现在正文加载成功时仍可打开文档，项目列表失败只显示单独提示。
- 编辑器有未保存内容时刷新/关闭网页前现在会显示浏览器离开提醒。
- 版本冲突时，读取最新版本会先确认本地内容将被替换；自动保存未完成或有脏数据时禁用删除按钮。

### 剩余能力边界

- 当前 `version` 是乐观并发版本号，不是完整的文档历史快照/回滚系统。
- 目前列表最多读取 100 篇文档，前端按标题过滤；更大规模资料库的服务端分页 UI 可后续单独完善。
- 浏览器 `beforeunload` 主要保护刷新、关闭标签和离开页面；它不是所有 SPA 路由切换场景的完整导航阻止器。
- Android 真机上键盘弹出、自动保存时切换页面、离线恢复与冲突操作仍待设备验收。

## 3. 安全源码检查

### 已观察到的正向控制

| 范围 | 观察结果 |
|---|---|
| 密码 | 注册密码使用 bcryptjs cost 12；`publicUser` 不返回密码哈希。 |
| 会话 | 随机 Session Token 只以 SHA-256 hash 存储；Cookie 为 HttpOnly、生产环境 Secure、SameSite Strict、Path=/api，并有过期时间。 |
| 授权 | `requireAuth` 在服务端加载有效会话；`requireAdmin` 在服务端验证角色。Provider 管理接口仍由 `requireAuth, requireAdmin` 保护。 |
| Provider Key | 数据库 Provider Key 使用 AES-256-GCM 加密存储；公开 Models/Health 响应只返回必要的模型元数据，不返回明文或密文 Key。 |
| Documents | 每个读写查询都以当前用户 ID 限定；项目关联也验证 owner；版本冲突通过条件更新避免覆盖。 |
| Projects / Conversations | 路由级认证和 SQL owner 过滤同时存在；项目-会话关联同时核对项目和会话所有者。 |
| Project Context | 项目指令和文件列表/下载/删除按 owner 限定；文件有类型、UTF-8、大小/数量配额和上下文显式 opt-in。 |
| Research | 已发布文章可公开读取；文章创建/编辑/删除仍需要管理员权限。新增网络搜索接口仅允许已登录用户。 |
| 请求来源 | CORS 使用配置的精确 WEB_ORIGIN；变更请求还要求 `X-Requested-With: NOVA-Web`。 |
| 新搜索出站请求 | 只从服务端环境读取 Provider URL/Key；禁止跟随 HTTP redirect；设置超时和响应字节上限；返回前移除非 HTTP(S) URL。 |

### 仍然存在的安全风险（不因本次审查而视为解决）

1. `server/src/middleware/security.js` 在请求缺少 Origin 时仍允许继续，只校验自定义请求头。自定义头不是秘密；SameSite Strict Cookie 和 CORS 提供额外保护，但公开生产部署前仍应评估严格 Origin/CSRF Token 策略。
2. `server/src/app.js` 当前关闭 Helmet CSP（`contentSecurityPolicy: false`）。需要在生产资源来源清单明确后再配置 CSP。
3. 会话过期记录尚无周期清理；管理员角色/Provider 等敏感操作尚无统一审计日志。
4. API 限流当前主要使用进程内存 Store，多实例部署前必须改为共享限流/并发存储；不能直接启用 IP 限流而不先明确可信反向代理拓扑。
5. 尚未演练 SQLite 备份恢复、生产部署和日志告警；尚未进行公网渗透测试、模糊测试、压力测试或完整 Git 历史密钥扫描。
6. 第三方模型提示词/项目资料处理告知仍是公开发布门槛；本次 Research 搜索的来源提示不替代模型数据处理隐私告知。

本轮新增 Research 搜索按用户限流 8 次/分钟。搜索接口只保存用户主动选择后提交到 Documents 的报告；服务端不新增搜索历史表、不记录查询正文、不写 API Key 日志。

## 4. Android 小屏源码适配

### 已检查模块

- Research：原有文章列表在 760 px 以下改为单列；网络搜索表单在小屏改为纵向排列；来源卡片变为单列；选择与保存操作保留明显点击区域。
- Documents：600 px 以下文档卡片改为单列；工具栏改为适配窄屏的网格；编辑器顶部操作、项目选择、编辑/预览切换和冲突恢复改为适配窄屏；本次将关键操作区提升至至少 44 px。
- Chat：模型状态提示在 760 px 以下改为纵向；文档弹窗有最大高度和内部滚动；新增 dvh 最大高度回退与 overscroll 限制；手机端发送按钮和弹窗主操作提升点击区域。
- Project Context：已有 850/600 px 断点；文件列表、项目指令和上传控件有移动端样式。
- Admin / Provider：已有 900/560 px 断点，移动端管理布局切换为单列/可滚动控制区。

### 未验证内容

源码审查不能证明不同 Android WebView/Chrome 版本上的实际键盘避让、滚动惯性、固定/粘性元素层叠、文件选择器、下载权限和触摸精度。以上仍保留在最后的 Android 真机验收清单中。

## 5. 验收限制

- CI API 测试和生产构建通过，仅证明自动化覆盖范围内的结果。
- 真实第三方搜索是否可用，依赖部署者配置真实 SearXNG 或 Brave Search。
- 仍需 Android 真机、浏览器 E2E、备份恢复和独立安全测试。
- 本报告为静态源码审查与测试记录，不是安全认证、渗透测试报告或生产运行证明。
