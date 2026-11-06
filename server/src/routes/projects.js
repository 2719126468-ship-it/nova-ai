import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { isPositiveId } from '../utils.js';

const router = Router();
const conversationLinkSchema = z.object({ conversationId: z.number().int().positive() });
const projectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional().default(''),
  content: z.string().max(200000).optional().default(''),
});
router.use(requireAuth);

router.get('/', (req, res) => {
  const projects = db.prepare(`
    SELECT p.id,p.title,p.description,p.content,p.created_at,p.updated_at,
      (SELECT COUNT(*) FROM project_conversations pc WHERE pc.project_id=p.id AND pc.user_id=p.user_id) AS conversation_count
    FROM projects p WHERE p.user_id=? ORDER BY p.updated_at DESC
  `).all(req.user.id);
  res.json({ projects });
});
router.post('/', (req, res) => {
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '项目名称为必填项，且不能超过 120 个字符。' });
  const result = db.prepare('INSERT INTO projects(user_id,title,description,content) VALUES(?,?,?,?)')
    .run(req.user.id, parsed.data.title, parsed.data.description, parsed.data.content);
  const project = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(result.lastInsertRowid, req.user.id);
  res.status(201).json({ project });
});

router.get('/:id/conversations', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const id = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在。' });
  const conversations = db.prepare(`
    SELECT c.id,c.title,c.created_at,c.updated_at,pc.created_at AS linked_at,
      (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM project_conversations pc JOIN conversations c ON c.id=pc.conversation_id
    WHERE pc.project_id=? AND pc.user_id=? AND c.user_id=?
    ORDER BY pc.created_at DESC
  `).all(id, req.user.id, req.user.id);
  res.json({ conversations });
});

router.post('/:id/conversations', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const parsed = conversationLinkSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '请提供有效的 conversationId。' });
  const id = Number(req.params.id);
  const project = db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在。' });
  const conversation = db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?')
    .get(parsed.data.conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'CONVERSATION_NOT_FOUND', message: '对话不存在。' });
  const result = db.prepare('INSERT OR IGNORE INTO project_conversations(project_id,conversation_id,user_id) VALUES(?,?,?)')
    .run(id, parsed.data.conversationId, req.user.id);
  res.status(result.changes ? 201 : 200).json({ success: true, alreadyLinked: result.changes === 0 });
});

router.delete('/:id/conversations/:conversationId', (req, res) => {
  if (!isPositiveId(req.params.id) || !isPositiveId(req.params.conversationId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '项目或对话编号无效。' });
  }
  const id = Number(req.params.id);
  const conversationId = Number(req.params.conversationId);
  const project = db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(id, req.user.id);
  if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在。' });
  const conversation = db.prepare('SELECT id FROM conversations WHERE id=? AND user_id=?').get(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'CONVERSATION_NOT_FOUND', message: '对话不存在。' });
  const result = db.prepare('DELETE FROM project_conversations WHERE project_id=? AND conversation_id=? AND user_id=?')
    .run(id, conversationId, req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'LINK_NOT_FOUND', message: '项目中没有关联这段对话。' });
  res.json({ success: true });
});

router.get('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const project = db.prepare(`
    SELECT p.*,
      (SELECT COUNT(*) FROM project_conversations pc WHERE pc.project_id=p.id AND pc.user_id=p.user_id) AS conversation_count
    FROM projects p WHERE p.id=? AND p.user_id=?
  `).get(Number(req.params.id), req.user.id);
  if (!project) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在。' });
  res.json({ project });
});
router.put('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const parsed = projectSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '项目数据格式不正确。' });
  const result = db.prepare(`UPDATE projects SET title=?,description=?,content=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?`)
    .run(parsed.data.title, parsed.data.description, parsed.data.content, Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在。' });
  const project = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  res.json({ project });
});
router.delete('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const result = db.prepare('DELETE FROM projects WHERE id=? AND user_id=?').run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '项目不存在。' });
  res.json({ success: true });
});
export default router;
