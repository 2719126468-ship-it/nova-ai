import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { config } from './config.js';

if (config.dbPath !== ':memory:') fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });

export const db = new Database(config.dbPath);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.pragma('busy_timeout = 5000');

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  password_hash TEXT NOT NULL,
  name TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'user' CHECK(role IN ('user', 'admin')),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE TABLE IF NOT EXISTS sessions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_sessions_token_hash ON sessions(token_hash);
CREATE INDEX IF NOT EXISTS idx_sessions_expires_at ON sessions(expires_at);
CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  content TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_projects_user_updated ON projects(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS conversations (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL DEFAULT '新对话',
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_conversations_user_updated ON conversations(user_id, updated_at DESC);
CREATE TABLE IF NOT EXISTS messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id INTEGER NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system')),
  content TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_messages_conversation ON messages(conversation_id, id);
CREATE TABLE IF NOT EXISTS articles (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  slug TEXT NOT NULL UNIQUE,
  title TEXT NOT NULL,
  category TEXT NOT NULL DEFAULT '观点',
  summary TEXT NOT NULL DEFAULT '',
  body TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft' CHECK(status IN ('draft', 'published')),
  author_id INTEGER REFERENCES users(id) ON DELETE SET NULL,
  published_at TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_articles_status_published ON articles(status, published_at DESC);
`);

const articleCount = db.prepare('SELECT COUNT(*) AS count FROM articles').get().count;
if (articleCount === 0) {
  const seed = db.prepare(`INSERT INTO articles (slug,title,category,summary,body,status,published_at)
    VALUES (@slug,@title,@category,@summary,@body,'published',CURRENT_TIMESTAMP)`);
  const examples = [
    {
      slug: 'what-we-mean-by-intelligence', category: '观点', title: '我们谈论人工智能时，究竟在谈论什么？',
      summary: '从能力、工具到协作关系，重新梳理人工智能产品真正应该解决的问题。',
      body: `人工智能不是一个单一功能，也不是一个神秘的黑箱。它是一组持续演进的技术能力，正在被封装进搜索、创作、分析与自动化等具体工作流。\n\n对产品而言，模型能力只是起点。真正的体验还取决于上下文是否连续、结果能否验证、用户能否掌控过程，以及系统是否清楚表达自己的边界。\n\n**好的 AI 产品不应该只展示“它有多聪明”，还应该让用户清楚地知道：它能帮我完成什么、依据是什么、下一步由谁决定。**`
    },
    {
      slug: 'designing-multimodal-workflows', category: '多模态', title: '多模态交互，不只是把更多输入放在一起',
      summary: '语言、图像与声音如何共同构成自然、连贯且可控的工作流程。',
      body: `多模态系统的价值不在于输入格式的数量，而在于不同信息之间能否形成真正有用的联系。\n\n当用户上传一张图、一段录音和一份文档时，产品需要理解它们之间的关系，并让用户能够修正系统的理解。\n\n因此，多模态产品设计需要同时考虑内容组织、来源标记、任务状态、失败恢复与隐私边界。`
    },
    {
      slug: 'trustworthy-ai-products', category: 'AI 安全', title: '可信赖的 AI 产品，需要把边界设计进体验',
      summary: '可靠性、隐私和透明度不应只是发布前的检查项。',
      body: `可信赖不是一句宣传语。它需要体现在默认设置、数据生命周期、权限模型和错误反馈之中。\n\n用户应该知道哪些内容会被保存、谁可以访问、如何删除，以及模型是否真的完成了请求。\n\n当服务不可用或接口尚未配置时，产品应该明确说明，而不是用虚构结果掩盖问题。`
    }
  ];
  const seedMany = db.transaction((items) => items.forEach((item) => seed.run(item)));
  seedMany(examples);
}

export function closeDatabase() { db.close(); }
