import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';

const router = Router();
const articleSchema = z.object({
  slug: z.string().trim().min(3).max(120).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
  title: z.string().trim().min(3).max(180),
  category: z.string().trim().min(1).max(50),
  summary: z.string().trim().max(500).default(''),
  body: z.string().trim().min(20).max(50000),
  status: z.enum(['draft', 'published']).default('draft'),
});
router.get('/', (req, res) => {
  const articles = db.prepare(`SELECT id,slug,title,category,summary,published_at,created_at,updated_at
    FROM articles WHERE status='published' ORDER BY published_at DESC,id DESC`).all();
  res.json({ articles });
});
router.get('/:slug', (req, res) => {
  const article = db.prepare(`SELECT id,slug,title,category,summary,body,published_at,created_at,updated_at
    FROM articles WHERE slug=? AND status='published'`).get(req.params.slug);
  if (!article) return res.status(404).json({ error: 'NOT_FOUND', message: '文章不存在或尚未发布。' });
  res.json({ article });
});
router.post('/', requireAuth, requireAdmin, (req, res) => {
  const parsed = articleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '文章字段不完整或格式不正确。', details: z.flattenError(parsed.error) });
  try {
    const { slug, title, category, summary, body, status } = parsed.data;
    const result = db.prepare(`INSERT INTO articles(slug,title,category,summary,body,status,author_id,published_at)
      VALUES(?,?,?,?,?,?,?,CASE WHEN ?='published' THEN CURRENT_TIMESTAMP ELSE NULL END)`)
      .run(slug, title, category, summary, body, status, req.user.id, status);
    const article = db.prepare('SELECT * FROM articles WHERE id=?').get(result.lastInsertRowid);
    res.status(201).json({ article });
  } catch (error) {
    if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') return res.status(409).json({ error: 'SLUG_EXISTS', message: '该文章 URL 标识已存在。' });
    throw error;
  }
});
router.put('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'INVALID_ID', message: '文章编号无效。' });
  const parsed = articleSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '文章字段不完整或格式不正确。' });
  const item = parsed.data;
  const result = db.prepare(`UPDATE articles SET slug=?,title=?,category=?,summary=?,body=?,status=?,
    published_at=CASE WHEN ?='published' THEN COALESCE(published_at,CURRENT_TIMESTAMP) ELSE NULL END,
    updated_at=CURRENT_TIMESTAMP WHERE id=?`)
    .run(item.slug,item.title,item.category,item.summary,item.body,item.status,item.status,id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '文章不存在。' });
  res.json({ article: db.prepare('SELECT * FROM articles WHERE id=?').get(id) });
});
router.delete('/:id', requireAuth, requireAdmin, (req, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id < 1) return res.status(400).json({ error: 'INVALID_ID', message: '文章编号无效。' });
  const result = db.prepare('DELETE FROM articles WHERE id=?').run(id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '文章不存在。' });
  res.json({ success: true });
});
export default router;
