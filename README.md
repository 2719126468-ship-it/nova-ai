# NOVA AI Platform

> 一个可运行、可扩展的全栈 AI 产品平台起点。包含产品官网、AI Chat、Research CMS、Studio 项目工作区、用户账户、模型配置、开发者文档与管理员控制台。

**当前版本：`0.1.0` · 开发基础版**

NOVA 不是静态展示模板。前端页面通过 REST API 读取和写入 SQLite 数据；登录使用服务端会话；个人项目、Markdown 文档、对话与研究内容都有持久化数据结构。AI 模型暂不绑定供应商，服务端预留 OpenAI-compatible Provider Adapter，由部署者自行填写地址、密钥和模型名称。

## 功能范围

| 模块 | 当前实现 | 状态 |
|---|---|---|
| 产品官网 | 首页、产品目录、品牌介绍、响应式布局、浅色/深色主题 | 已实现 |
| AI Chat | 独立聊天工作区、会话历史、新建/删除/重命名、SSE 流式输出、停止、复制、用户消息编辑、重新生成、失败回答重试、回答历史版本查看与恢复 | 核心流程已实现；需配置模型才能产生回答 |
| Research | 分类筛选、搜索、文章详情、Markdown 阅读 | 已实现；初始文章是示例内容 |
| Research CMS | 管理员创建、编辑、发布、删除文章 | 已实现 |
| Studio | 项目创建、列表、详情编辑、手动保存、项目删除、关联 AI 对话 | 核心项目工作流已实现 |
| Documents | 用户私有 Markdown 文档、项目关联、CRUD API、版本冲突保护 | 后端 API 已实现；编辑器与自动保存待完成 |
| User Center | 注册、登录、注销、个人资料修改、密码修改、项目入口 | 已实现 |
| Models | 多 Provider 模型目录、管理员 Provider 管理、密钥加密、默认模型、按需健康探测、上下文预算与 Chat 模型切换 | 基础管理已实现；原生 Anthropic 与浏览器登录 Provider 待做 |
| Pricing | 套餐说明 | 展示版；没有接入收费或支付 |
| Developers | API 路由、认证与本地运行说明 | 已实现 |
| Admin | 角色保护、统计概览、用户角色管理、研究 CMS | 已实现 |
| AI Provider | OpenAI-compatible Chat Completions 适配层 | 已实现适配层；需要你自己的服务凭据 |

## 技术栈

- **Frontend:** React 19, Vite 8, React Router 7, Lucide, React Markdown
- **Backend:** Node.js 22.12+, Express 5, Zod, Helmet, CORS, express-rate-limit
- **Database:** SQLite via better-sqlite3
- **Authentication:** bcrypt password hashing + random opaque session token + HttpOnly cookie
- **AI:** server-side OpenAI-compatible Provider Adapter

## 项目结构

```text
nova-ai/
├── client/
│   ├── index.html              # 轻量 HTML 壳，不承载页面业务逻辑
│   ├── vite.config.js
│   └── src/
│       ├── components/         # Shell、Brand、通用 UI、路由权限
│       ├── context/            # Auth 与主题状态
│       ├── lib/                # REST API client
│       ├── pages/              # Home、Chat、Research、Studio、Admin 等独立页面
│       ├── styles/             # 分模块样式，按固定顺序导入
│       │   ├── foundation.css
│       │   ├── shared.css
│       │   ├── home.css / products.css / research.css / auth.css
│       │   ├── chat.css / studio.css / account.css
│       │   ├── models-pricing.css / developers.css / admin.css
│       │   ├── about.css / responsive.css
│       │   └── index.css
│       ├── App.jsx             # 只负责 React Router 路由组合
│       └── main.jsx            # 应用启动入口
├── server/
│   ├── data/                 # SQLite 数据库运行时目录
│   ├── scripts/              # 管理员初始化工具
│   ├── src/
│   │   ├── middleware/       # 身份认证、请求来源校验
│   │   ├── routes/            # Auth、Projects、Documents、Conversations、Research、Admin
│   │   ├── services/          # AI Provider Adapter
│   │   ├── app.js
│   │   ├── config.js
│   │   └── db.js              # 自动建表与演示文章种子数据
│   └── test/                  # API 集成测试
├── docs/
├── .env.example
└── package.json
```

## 本地运行

### 1. 环境要求

- Node.js 22.12 或更高版本
- npm 10 或更高版本
- SQLite 由 `better-sqlite3` 自动管理，不需要单独安装数据库服务

### 2. 安装并配置

```bash
cp .env.example .env
```

打开 `.env`，至少将 `SESSION_SECRET` 替换为随机的、长度不少于 32 个字符的值。可以使用：

```bash
node -e "console.log(require('node:crypto').randomBytes(48).toString('base64url'))"
```

然后安装依赖：

```bash
npm install
```

### 3. 启动

在项目根目录运行：

```bash
npm run dev
```

默认地址：

- Web：<http://localhost:5173>
- API：<http://localhost:4000>
- 健康检查：<http://localhost:4000/api/health>

如需让同一 Wi-Fi 下的手机访问开发服务器：

1. 在 `.env` 的 `WEB_ORIGIN` 中添加电脑的局域网地址，例如 `http://192.168.1.20:5173`（多个地址用逗号分隔）。
2. 确保电脑防火墙允许 TCP 5173 与 4000 端口。
3. 手机浏览器访问 `http://192.168.1.20:5173`。前端会默认把 API 请求发到相同主机名的 4000 端口。

也可以分别运行：

```bash
npm run dev:server
npm run dev:client
```

第一次启动时，服务端会自动创建 `server/data/nova.sqlite`，并写入少量带有“示例内容”定位的 Research 文章。数据库文件不应提交到 Git。

## 创建管理员账户

管理员角色不会通过公开注册表单自动分配。先在网站注册普通账户，再回到项目根目录运行：

```bash
npm run admin:promote -- your-email@example.com
```

之后重新登录即可看到管理员权限。请勿将普通用户提升为管理员，除非你确认账户归属。

## 配置自己的 AI API

NOVA 的 Provider Adapter 位于 `server/src/services/provider.js`。当前实现使用 OpenAI-compatible Chat Completions 请求格式。

在根目录 `.env` 中设置：

```dotenv
AI_BASE_URL=https://your-provider.example/v1
AI_API_KEY=your-secret-key
AI_MODEL=your-model-name
AI_TIMEOUT_MS=60000
AI_PROVIDERS_JSON=
AI_DEFAULT_MODEL=
```

说明：

- `AI_BASE_URL` 填写 API 的基础地址，适配器会向其追加 `/chat/completions`。
- `AI_API_KEY` 仅由服务端读取，不传给前端，也不会通过模型目录或健康检查接口返回。
- `AI_MODEL` 是供应商要求的模型标识（旧版单 Provider 配置仍受支持）。
- 需要接入多个 OpenAI-compatible Provider 时，可以设置 `AI_PROVIDERS_JSON`。示例：
  ```json
  [
    {
      "id": "deepseek",
      "name": "DeepSeek",
      "baseUrl": "https://api.deepseek.com/v1",
      "apiKey": "server-only-key",
      "models": [
        { "id": "deepseek-chat", "name": "DeepSeek Chat", "capabilities": ["chat", "text"] }
      ]
    },
    {
      "id": "other",
      "name": "Other Provider",
      "baseUrl": "https://provider.example/v1",
      "apiKey": "another-server-only-key",
      "models": [
        { "id": "chat-model", "name": "Chat Model" }
      ]
    }
  ]
  ```
- `AI_DEFAULT_MODEL` 可指定默认模型，例如 `deepseek:deepseek-chat`；模型选择器只列出服务端已配置且启用的模型。
- Provider 密钥不会写入浏览器，也不会出现在 `/api/v1/models` 或健康检查响应中。
- 修改配置后重启服务端。
- 尚未配置可选择的模型时，聊天接口会返回 `503 AI_PROVIDER_NOT_CONFIGURED`；不会生成虚构回答。
- 旧版 `POST /api/conversations/:id/messages` 保留完整 JSON 响应；新版 `POST /api/v1/conversations/:id/messages/stream` 支持 SSE 增量输出、上游请求取消和消息生命周期状态。模型目录区分配置、启用、可选择与上游健康状态；多 Provider JSON 注册表已支持 OpenAI-compatible Chat Completions，已支持按需读取上游 `/models` 目录核验模型 ID，但没有自动健康巡检；自动发现、浏览器登录/OAuth Provider、工具调用或图片输入仍未实现。

## 测试与构建

```bash
npm test
npm run build
```

API 集成测试会使用临时 SQLite 文件，不会覆盖你的开发数据库。

## 安全基线

当前已经包含：

- 密码使用 bcrypt 哈希存储，不保存明文密码。
- 使用随机高熵会话令牌，数据库仅保存 SHA-256 摘要。
- 会话通过 `HttpOnly`、`SameSite=Strict` Cookie 传递。
- 登录成功后不向浏览器 JavaScript 暴露会话令牌。
- 写请求校验 `Origin` 和 `X-Requested-With` 请求头。
- 登录/注册与 API 请求速率限制。
- Helmet 安全响应头、CORS 来源限制、JSON 请求体大小限制。
- 项目查询均以当前用户 ID 作为数据范围，避免跨账户读写。
- 管理 API 使用服务端角色校验。
- 数据库外键约束和级联删除。

正式公开部署前仍需补充：HTTPS 与反向代理配置、邮件验证、密码重置、隐私政策/服务条款、持久化速率限制存储、数据库备份与恢复、日志脱敏、依赖漏洞扫描、完整威胁建模及安全审计。Cookie 会话方案适合前后端部署在同一站点或同站子域；若部署在不同站点，需要重新设计跨站 Cookie 与 CSRF 机制。

## 当前边界

这是功能完整度较高的开发起点，不应被描述为已经完成生产审计的商业 SaaS：

1. 示例 Research 内容是占位文章，发布前需人工审核、补充可核验资料。
2. 定价页只是产品方案说明，没有支付、订阅或账单系统。
3. Studio 当前管理项目元信息和 Markdown/纯文本内容，还没有文件上传、复杂画布或多人协作。
4. 聊天已支持持久化会话、SSE 流式输出、停止生成、会话重命名、复制、编辑用户消息、末轮回答重新生成、回答历史查看与恢复，以及按模型上下文窗口进行输入预算和历史裁剪；Token 计数会区分本地分词估算、保守字节上界和未知来源，不等同于每个第三方供应商的原生计数。附件和工具调用仍未实现。
5. 管理后台提供基础用户角色和 CMS 管理，不包含完整审计日志、封禁工作流或运营分析。

## 产品基线与代码审计

- [正式产品基线 / NOVA-PRD-1.0](docs/PRODUCT-BASELINE.md)
- [NOVA 开发任务追踪（V0.1 → V0.2）](docs/DEVELOPMENT-TRACKER.md)
- [API v1 接口契约](docs/API-V1.md)
- [V0.1 源码实现审计](docs/audits/NOVA-V0.1-IMPLEMENTATION-AUDIT.md)
- [技术债清单](docs/audits/TECH-DEBT.md)
- [安全与隐私审查](docs/audits/SECURITY-REVIEW.md)
- [V0.1 开发任务与验收清单](docs/audits/V0.1-BACKLOG.md)

## 开发路线

请参阅 [`docs/ROADMAP.md`](docs/ROADMAP.md) 与 [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)。
