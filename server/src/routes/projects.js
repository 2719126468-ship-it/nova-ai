import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { isPositiveId } from '../utils.js';

const router = Router();
const projectSchema = z.object({
  title: z.string().trim().min(1).max(120),
  description: z.string().max(500).optional().default(''),
  content: z.string().max(200000).optional().default(''),
});
router.use(requireAuth);

router.get('/', (req, res) => {
  const projects = db.prepare('SELECT id,title,description,content,created_at,updated_at FROM projects WHERE user_id=? ORDER BY updated_at DESC').all(req.user.id);
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
router.get('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const project = db.prepare('SELECT * FROM projects WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
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
