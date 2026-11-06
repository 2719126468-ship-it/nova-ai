import express, { Router } from 'express';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { isPositiveId } from '../utils.js';

const router = Router();
const MAX_FILE_BYTES = 2 * 1024 * 1024;
const MAX_PROJECT_FILES = 20;
const MAX_PROJECT_BYTES = 10 * 1024 * 1024;
const MIME_BY_EXTENSION = {
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.csv': 'text/csv; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
};
const instructionSchema = z.object({
  instructions: z.string().max(16000),
  expectedVersion: z.number().int().positive(),
});

router.use(requireAuth);

function readProject(projectId, userId) {
  return db.prepare(
    'SELECT id,title,instructions,instructions_version AS instructionsVersion FROM projects WHERE id=? AND user_id=?',
  ).get(projectId, userId);
}

function readProjectFiles(projectId, userId) {
  return db.prepare(`
    SELECT id,original_name AS name,extension,mime_type AS mimeType,size_bytes AS sizeBytes,
      sha256,include_in_context AS includeInContext,created_at AS createdAt
    FROM project_files
    WHERE project_id=? AND user_id=?
    ORDER BY created_at DESC,id DESC
  `).all(projectId, userId).map((file) => ({
    ...file,
    includeInContext: file.includeInContext === 1,
  }));
}

function readFile(fileId, projectId, userId) {
  return db.prepare(
    'SELECT * FROM project_files WHERE id=? AND project_id=? AND user_id=?',
  ).get(fileId, projectId, userId);
}

function parseUploadName(header) {
  let decoded;
  try {
    decoded = decodeURIComponent(String(header || ''));
  } catch {
    return null;
  }
  const name = decoded.replace(/\\/g, '/').split('/').pop().normalize('NFC').trim();
  if (!name || name.length > 180 || /[\u0000-\u001f\u007f]/.test(name)) return null;
  return name;
}

router.get('/:id/context', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const project = readProject(Number(req.params.id), req.user.id);
  if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在。' });
  res.set('Cache-Control', 'no-store');
  res.json({ project, files: readProjectFiles(project.id, req.user.id) });
});

router.put('/:id/context', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const parsed = instructionSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: '项目指令最多 16000 个字符，且必须提供 expectedVersion。' });
  }
  const projectId = Number(req.params.id);
  const project = readProject(projectId, req.user.id);
  if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在。' });
  if (project.instructionsVersion !== parsed.data.expectedVersion) {
    return res.status(409).json({
      error: 'PROJECT_CONTEXT_VERSION_CONFLICT',
      message: '项目指令已被更新，请读取最新版本后再保存。',
      currentVersion: project.instructionsVersion,
    });
  }
  const updated = db.prepare(`
    UPDATE projects
    SET instructions=?,instructions_version=instructions_version+1,updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND user_id=? AND instructions_version=?
  `).run(parsed.data.instructions, projectId, req.user.id, parsed.data.expectedVersion);
  if (!updated.changes) {
    const latest = readProject(projectId, req.user.id);
    return res.status(409).json({
      error: 'PROJECT_CONTEXT_VERSION_CONFLICT',
      message: '项目指令已被更新，请读取最新版本后再保存。',
      currentVersion: latest?.instructionsVersion,
    });
  }
  const next = readProject(projectId, req.user.id);
  res.set('Cache-Control', 'no-store');
  res.json({ project: next });
});

router.get('/:id/files', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const project = readProject(Number(req.params.id), req.user.id);
  if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在。' });
  res.set('Cache-Control', 'no-store');
  res.json({ files: readProjectFiles(project.id, req.user.id) });
});

router.post('/:id/files', express.raw({ type: 'application/octet-stream', limit: MAX_FILE_BYTES }), (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '项目编号无效。' });
  const projectId = Number(req.params.id);
  const project = readProject(projectId, req.user.id);
  if (!project) return res.status(404).json({ error: 'PROJECT_NOT_FOUND', message: '项目不存在。' });
  if (!Buffer.isBuffer(req.body) || !req.body.length) {
    return res.status(400).json({ error: 'FILE_REQUIRED', message: '请选择非空文件后上传。' });
  }
  if (req.body.length > MAX_FILE_BYTES) {
    return res.status(413).json({ error: 'FILE_TOO_LARGE', message: '单个文件不能超过 2 MiB。' });
  }

  const name = parseUploadName(req.get('x-file-name'));
  if (!name) return res.status(400).json({ error: 'INVALID_FILE_NAME', message: '文件名无效。' });
  const extension = name.slice(name.lastIndexOf('.')).toLowerCase();
  if (!Object.hasOwn(MIME_BY_EXTENSION, extension)) {
    return res.status(415).json({ error: 'UNSUPPORTED_FILE_TYPE', message: '仅支持 TXT、Markdown、CSV 和 JSON 文本文件。' });
  }

  let extractedText;
  try {
    extractedText = new TextDecoder('utf-8', { fatal: true }).decode(req.body).replace(/^\uFEFF/, '');
  } catch {
    return res.status(415).json({ error: 'INVALID_TEXT_ENCODING', message: '文件必须是有效的 UTF-8 文本。' });
  }
  if (extractedText.includes('\0')) {
    return res.status(415).json({ error: 'INVALID_TEXT_CONTENT', message: '文件包含不支持的二进制内容。' });
  }
  if (extension === '.json') {
    try { JSON.parse(extractedText); } catch {
      return res.status(400).json({ error: 'INVALID_JSON_FILE', message: 'JSON 文件内容格式无效。' });
    }
  }

  const usage = db.prepare(
    'SELECT COUNT(*) AS count,COALESCE(SUM(size_bytes),0) AS bytes FROM project_files WHERE project_id=? AND user_id=?',
  ).get(projectId, req.user.id);
  if (usage.count >= MAX_PROJECT_FILES) {
    return res.status(409).json({ error: 'PROJECT_FILE_LIMIT', message: '每个项目最多保存 20 个文件。' });
  }
  if (usage.bytes + req.body.length > MAX_PROJECT_BYTES) {
    return res.status(409).json({ error: 'PROJECT_STORAGE_LIMIT', message: '每个项目的文件总量不能超过 10 MiB。' });
  }

  const sha256 = createHash('sha256').update(req.body).digest('hex');
  try {
    const inserted = db.prepare(`
      INSERT INTO project_files(
        user_id,project_id,original_name,extension,mime_type,size_bytes,sha256,content,extracted_text
      ) VALUES(?,?,?,?,?,?,?,?,?)
    `).run(
      req.user.id,
      projectId,
      name,
      extension,
      MIME_BY_EXTENSION[extension],
      req.body.length,
      sha256,
      req.body,
      extractedText,
    );
    const file = readFile(inserted.lastInsertRowid, projectId, req.user.id);
    res.status(201).json({
      file: {
        id: file.id,
        name: file.original_name,
        extension: file.extension,
        mimeType: file.mime_type,
        sizeBytes: file.size_bytes,
        includeInContext: false,
        createdAt: file.created_at,
      },
    });
  } catch (error) {
    if (String(error.code || '').includes('CONSTRAINT_UNIQUE')) {
      return res.status(409).json({ error: 'DUPLICATE_PROJECT_FILE', message: '该文件内容已经存在于此项目。' });
    }
    throw error;
  }
});

router.patch('/:id/files/:fileId', (req, res) => {
  if (!isPositiveId(req.params.id) || !isPositiveId(req.params.fileId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '项目或文件编号无效。' });
  }
  const parsed = z.object({ includeInContext: z.boolean() }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'includeInContext 必须为布尔值。' });
  const projectId = Number(req.params.id);
  const file = readFile(Number(req.params.fileId), projectId, req.user.id);
  if (!file) return res.status(404).json({ error: 'PROJECT_FILE_NOT_FOUND', message: '文件不存在。' });
  db.prepare('UPDATE project_files SET include_in_context=? WHERE id=? AND project_id=? AND user_id=?')
    .run(parsed.data.includeInContext ? 1 : 0, file.id, projectId, req.user.id);
  res.json({ files: readProjectFiles(projectId, req.user.id) });
});

router.get('/:id/files/:fileId/download', (req, res) => {
  if (!isPositiveId(req.params.id) || !isPositiveId(req.params.fileId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '项目或文件编号无效。' });
  }
  const file = readFile(Number(req.params.fileId), Number(req.params.id), req.user.id);
  if (!file) return res.status(404).json({ error: 'PROJECT_FILE_NOT_FOUND', message: '文件不存在。' });
  res.set('Cache-Control', 'no-store');
  res.set('X-Content-Type-Options', 'nosniff');
  res.set('Content-Disposition', "attachment; filename*=UTF-8''" + encodeURIComponent(file.original_name));
  res.set('Content-Type', file.mime_type);
  res.send(Buffer.from(file.content));
});

router.delete('/:id/files/:fileId', (req, res) => {
  if (!isPositiveId(req.params.id) || !isPositiveId(req.params.fileId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '项目或文件编号无效。' });
  }
  const projectId = Number(req.params.id);
  const deleted = db.prepare(
    'DELETE FROM project_files WHERE id=? AND project_id=? AND user_id=?',
  ).run(Number(req.params.fileId), projectId, req.user.id);
  if (!deleted.changes) return res.status(404).json({ error: 'PROJECT_FILE_NOT_FOUND', message: '文件不存在。' });
  res.json({ success: true, files: readProjectFiles(projectId, req.user.id) });
});

export default router;
