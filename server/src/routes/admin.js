import { Router } from 'express';
import { db } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
router.use(requireAuth, requireAdmin);
router.get('/overview', (req, res) => {
  const stats = {
    users: db.prepare('SELECT COUNT(*) AS count FROM users').get().count,
    projects: db.prepare('SELECT COUNT(*) AS count FROM projects').get().count,
    conversations: db.prepare('SELECT COUNT(*) AS count FROM conversations').get().count,
    articles: db.prepare("SELECT COUNT(*) AS count FROM articles WHERE status='published'").get().count,
  };
  const recentUsers = db.prepare('SELECT id,email,name,role,created_at FROM users ORDER BY id DESC LIMIT 12').all();
  res.json({ stats, recentUsers });
});

router.get('/usage', (req, res) => {
  const requestedLimit = Number(req.query.limit ?? 50);
  const limit = Number.isInteger(requestedLimit) ? Math.min(Math.max(requestedLimit, 1), 100) : 50;
  const summary = db.prepare(`
    SELECT
      COUNT(*) AS requests,
      SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END) AS succeeded,
      SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END) AS failed,
      SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END) AS cancelled,
      SUM(CASE WHEN usage_source='provider' THEN 1 ELSE 0 END) AS providerReportedRequests,
      SUM(input_tokens) AS reportedInputTokens,
      SUM(output_tokens) AS reportedOutputTokens,
      SUM(total_tokens) AS reportedTotalTokens
    FROM ai_usage
  `).get();
  const records = db.prepare(`
    SELECT request_id,user_id,provider_id,model_id,operation,status,error_code,duration_ms,
      input_tokens,output_tokens,total_tokens,usage_source,created_at,completed_at
    FROM ai_usage ORDER BY id DESC LIMIT ?
  `).all(limit);
  res.json({
    summary: {
      ...summary,
      note: 'Token totals include only values reported by upstream providers; null values are unknown, not zero estimates.',
    },
    records,
  });
});
router.get('/articles', (req, res) => {
  const articles = db.prepare('SELECT id,slug,title,category,summary,body,status,published_at,updated_at FROM articles ORDER BY updated_at DESC LIMIT 100').all();
  res.json({ articles });
});
router.get('/users', (req, res) => {
  const users = db.prepare(`SELECT u.id,u.email,u.name,u.role,u.created_at,
    (SELECT COUNT(*) FROM projects p WHERE p.user_id=u.id) AS project_count,
    (SELECT COUNT(*) FROM conversations c WHERE c.user_id=u.id) AS conversation_count
    FROM users u ORDER BY u.id DESC LIMIT 100`).all();
  res.json({ users });
});
router.patch('/users/:id/role', (req, res) => {
  const id = Number(req.params.id);
  const role = req.body?.role;
  if (!Number.isInteger(id) || id < 1 || !['user','admin'].includes(role)) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: '用户或角色参数无效。' });
  }
  if (id === req.user.id && role !== 'admin') return res.status(400).json({ error: 'SELF_DEMOTION_BLOCKED', message: '不能在当前会话中移除自己的管理员权限。' });
  const result = db.prepare('UPDATE users SET role=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(role,id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '用户不存在。' });
  res.json({ success: true });
});
export default router;
