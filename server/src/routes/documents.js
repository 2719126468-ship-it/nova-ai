import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { isPositiveId } from '../utils.js';

const router = Router();
const documentFields = `
  id,title,content,project_id AS projectId,version,
  archived_at AS archivedAt,
  created_at AS createdAt,updated_at AS updatedAt
`;

const createDocumentSchema = z.object({
  title: z.string().trim().min(1).max(120),
  content: z.string().max(200000).optional().default(''),
  projectId: z.number().int().positive().nullable().optional().default(null),
});

const updateDocumentSchema = z.object({
  title: z.string().trim().min(1).max(120).optional(),
  content: z.string().max(200000).optional(),
  projectId: z.number().int().positive().nullable().optional(),
  archived: z.boolean().optional(),
  expectedVersion: z.number().int().positive(),
}).superRefine((value, ctx) => {
  if (value.title === undefined && value.content === undefined
    && value.projectId === undefined && value.archived === undefined) {
    ctx.addIssue({
      code: 'custom',
      message: '至少提供 title、content、projectId 或 archived 其中一个字段。',
    });
  }
});

const listQuerySchema = z.object({
  projectId: z.coerce.number().int().positive().optional(),
  q: z.string().trim().max(120).optional(),
  archived: z.enum(['active', 'archived', 'all']).default('active'),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(10000).default(0),
});

router.use(requireAuth);

function readDocument(id, userId) {
  return db.prepare(`SELECT ${documentFields} FROM documents WHERE id=? AND user_id=?`).get(id, userId);
}

function ownedProjectExists(projectId, userId) {
  if (projectId === null || projectId === undefined) return true;
  return Boolean(db.prepare('SELECT id FROM projects WHERE id=? AND user_id=?').get(projectId, userId));
}

router.get('/', (req, res) => {
  const parsed = listQuerySchema.safeParse(req.query);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: '文档筛选条件无效；limit 必须为 1–100，offset 不能超过 10000。',
    });
  }

  const { projectId, q, archived, limit, offset } = parsed.data;
  if (projectId !== undefined && !ownedProjectExists(projectId, req.user.id)) {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在。' });
  }

  const filters = ['user_id=?'];
  const params = [req.user.id];
  if (archived === 'active') filters.push('archived_at IS NULL');
  else if (archived === 'archived') filters.push('archived_at IS NOT NULL');
  if (projectId !== undefined) {
    filters.push('project_id=?');
    params.push(projectId);
  }
  if (q) {
    filters.push('instr(lower(title),lower(?)) > 0');
    params.push(q);
  }
  const where = filters.join(' AND ');
  const total = db.prepare(`SELECT COUNT(*) AS count FROM documents WHERE ${where}`).get(...params).count;
  const documents = db.prepare(`
    SELECT id,title,project_id AS projectId,version,archived_at AS archivedAt,
      length(content) AS contentLength,created_at AS createdAt,updated_at AS updatedAt
    FROM documents
    WHERE ${where}
    ORDER BY updated_at DESC,id DESC
    LIMIT ? OFFSET ?
  `).all(...params, limit, offset);

  const archivedCount = db.prepare(
    'SELECT COUNT(*) AS count FROM documents WHERE user_id=? AND archived_at IS NOT NULL',
  ).get(req.user.id).count;

  res.set('Cache-Control', 'no-store');
  res.json({ documents, total, archivedCount, limit, offset, archived });
});

router.post('/', (req, res) => {
  const parsed = createDocumentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: '文档标题必填且不超过 120 个字符，正文不能超过 200000 个字符。',
    });
  }
  const input = parsed.data;
  if (!ownedProjectExists(input.projectId, req.user.id)) {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在。' });
  }

  const result = db.prepare(
    'INSERT INTO documents(user_id,project_id,title,content) VALUES(?,?,?,?)',
  ).run(req.user.id, input.projectId, input.title, input.content);
  const document = readDocument(result.lastInsertRowid, req.user.id);
  res.set('Cache-Control', 'no-store');
  res.status(201).json({ document });
});

router.get('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '文档编号无效。' });
  }
  const document = readDocument(Number(req.params.id), req.user.id);
  if (!document) return res.status(404).json({ error: 'NOT_FOUND', message: '文档不存在。' });
  res.set('Cache-Control', 'no-store');
  res.json({ document });
});

router.put('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '文档编号无效。' });
  }
  const parsed = updateDocumentSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'VALIDATION_ERROR',
      message: '文档更新内容无效，且必须提供 expectedVersion 以避免覆盖较新的编辑。',
    });
  }

  const id = Number(req.params.id);
  const input = parsed.data;
  const current = db.prepare(
    'SELECT id,title,content,project_id,version,archived_at FROM documents WHERE id=? AND user_id=?',
  ).get(id, req.user.id);
  if (!current) return res.status(404).json({ error: 'NOT_FOUND', message: '文档不存在。' });
  if (input.expectedVersion !== current.version) {
    return res.status(409).json({
      error: 'DOCUMENT_VERSION_CONFLICT',
      message: '文档已被更新；请先读取最新版本，再合并本次编辑。',
      currentVersion: current.version,
    });
  }

  const nextProjectId = input.projectId === undefined ? current.project_id : input.projectId;
  if (!ownedProjectExists(nextProjectId, req.user.id)) {
    return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在。' });
  }

  const archivedAt = input.archived === undefined
    ? current.archived_at
    : input.archived
      ? (current.archived_at || new Date().toISOString())
      : null;

  const result = db.prepare(`
    UPDATE documents
    SET title=?,content=?,project_id=?,archived_at=?,version=version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND user_id=? AND version=?
  `).run(
    input.title ?? current.title,
    input.content ?? current.content,
    nextProjectId,
    archivedAt,
    id,
    req.user.id,
    input.expectedVersion,
  );
  if (!result.changes) {
    const latest = db.prepare('SELECT version FROM documents WHERE id=? AND user_id=?').get(id, req.user.id);
    if (!latest) return res.status(404).json({ error: 'NOT_FOUND', message: '文档不存在。' });
    return res.status(409).json({
      error: 'DOCUMENT_VERSION_CONFLICT',
      message: '文档已被更新；请先读取最新版本，再合并本次编辑。',
      currentVersion: latest.version,
    });
  }

  const document = readDocument(id, req.user.id);
  res.set('Cache-Control', 'no-store');
  res.json({ document });
});

router.delete('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '文档编号无效。' });
  }
  const result = db.prepare('DELETE FROM documents WHERE id=? AND user_id=?')
    .run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '文档不存在。' });
  res.json({ success: true });
});

export default router;
