import { useState } from 'react';
import { ArrowUpRight, BookOpen, Check, Copy, Terminal } from 'lucide-react';
import { Eyebrow, PageIntro } from '../components/UI';

const groups = [
  { title: 'Authentication', rows: [['POST', '/api/auth/register', '创建用户账户'], ['POST', '/api/auth/login', '登录并创建会话'], ['POST', '/api/auth/logout', '注销当前会话'], ['GET', '/api/auth/me', '获取当前用户'], ['PATCH', '/api/auth/me', '更新个人资料'], ['PATCH', '/api/auth/password', '更新账户密码']] },
  { title: 'Projects', rows: [['GET', '/api/projects', '列出自己的项目'], ['POST', '/api/projects', '创建项目'], ['GET', '/api/projects/:id', '读取项目详情'], ['PUT', '/api/projects/:id', '更新项目内容'], ['DELETE', '/api/projects/:id', '删除项目']] },
  { title: 'Conversations', rows: [['GET', '/api/conversations', '列出对话历史'], ['POST', '/api/conversations', '创建对话'], ['GET', '/api/conversations/:id', '读取对话与消息'], ['POST', '/api/conversations/:id/messages', '发送消息并请求模型'], ['DELETE', '/api/conversations/:id', '删除对话']] },
  { title: 'Research & Operations', rows: [['GET', '/api/research', '读取已发布文章'], ['GET', '/api/research/:slug', '读取文章详情'], ['POST', '/api/research', '管理员创建文章'], ['PUT', '/api/research/:id', '管理员更新文章'], ['DELETE', '/api/research/:id', '管理员删除文章'], ['GET', '/api/admin/overview', '管理员统计概览'], ['GET', '/api/admin/users', '管理员用户列表'], ['GET', '/api/health', '服务健康状态']] },
];
function CopyButton({ value }) {
  const [copied, setCopied] = useState(false);
  async function copy() { try { await navigator.clipboard.writeText(value); setCopied(true); setTimeout(() => setCopied(false), 1500); } catch { setCopied(false); } }
  return <button className="copy-button" onClick={copy} aria-label="复制代码">{copied ? <Check size={14} /> : <Copy size={14} />}{copied ? '已复制' : '复制'}</button>;
}
export default function Developers() {
  return <main className="page-wrap container-wide developers-page"><PageIntro eyebrow="NOVA DEVELOPER PLATFORM" title={<>为开发者而构建。<br />为扩展留出空间。</>} description="REST API、服务端会话认证与可配置的 AI Provider Adapter。当前文档与仓库代码保持同步。" />
    <div className="developer-quickstart"><div className="quickstart-heading"><div className="quickstart-icon"><Terminal size={19} /></div><div><span className="eyebrow">QUICK START</span><h2>在本地运行 NOVA</h2></div></div><div className="code-block-heading"><span>TERMINAL</span><CopyButton value={'cp .env.example .env\nnpm install\nnpm run dev'} /></div><pre><code><span className="code-muted"># 复制环境配置并设置 SESSION_SECRET</span>{'\n'}cp .env.example .env{'\n'}npm install{'\n'}npm run dev</code></pre><p>前端默认运行在 `http://localhost:5173`，API 默认运行在 `http://localhost:4000`。</p></div>
    <div className="api-doc-heading"><div><Eyebrow>API REFERENCE</Eyebrow><h2>接口目录</h2></div><span className="api-base">BASE URL <code>http://localhost:4000/api</code></span></div>
    <div className="api-doc-groups">{groups.map((group) => <section className="api-doc-group" key={group.title}><h3>{group.title}</h3>{group.rows.map(([method, route, description]) => <div className="api-doc-row" key={`${method}-${route}`}><span className={`method method-${method.toLowerCase()}`}>{method}</span><code>{route}</code><span>{description}</span></div>)}</section>)}</div>
    <div className="api-auth-note"><BookOpen size={19} /><div><h3>认证与请求约定</h3><p>登录成功后，服务端通过 `HttpOnly`、`SameSite=Strict` Cookie 建立会话。浏览器请求需启用 `credentials: include`，所有写操作需携带 `X-Requested-With: NOVA-Web`。API 密钥不通过客户端传输。</p></div></div>
    <div className="developer-env"><Eyebrow>PROVIDER ENVIRONMENT</Eyebrow><h2>配置你的 AI 服务</h2><pre><code>{`AI_BASE_URL=https://provider.example/v1
AI_API_KEY=keep-this-on-server-only
AI_MODEL=your-model-name`}</code></pre><p>服务端适配 OpenAI-compatible `/chat/completions`。如果这三个值未配置，聊天接口会返回明确的 503 状态，不会伪造回答。</p></div>
  </main>;
}
