import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { createAssistantReply, ProviderNotConfiguredError } from '../services/provider.js';
import { isPositiveId } from '../utils.js';

const router = Router();
const messageSchema = z.object({ content: z.string().trim().min(1).max(20000) });
router.use(requireAuth);

router.get('/', (req, res) => {
  const conversations = db.prepare(`SELECT c.id,c.title,c.created_at,c.updated_at,
    (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM conversations c WHERE c.user_id=? ORDER BY c.updated_at DESC`).all(req.user.id);
  res.json({ conversations });
});
router.post('/', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : '新对话';
  const result = db.prepare('INSERT INTO conversations(user_id,title) VALUES(?,?)').run(req.user.id, title || '新对话');
  const conversation = db.prepare('SELECT * FROM conversations WHERE id=?').get(result.lastInsertRowid);
  res.status(201).json({ conversation });
});
router.get('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
  const conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(Number(req.params.id), req.user.id);
  if (!conversation) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  const messages = db.prepare('SELECT id,role,content,created_at FROM messages WHERE conversation_id=? ORDER BY id').all(conversation.id);
  res.json({ conversation, messages });
});
router.post('/:id/messages', async (req, res, next) => {
  try {
    if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '消息不能为空，且不能超过 20,000 个字符。' });
    const conversationId = Number(req.params.id);
    const conversation = db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(conversationId, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
    if (!process.env.AI_BASE_URL || !process.env.AI_API_KEY || !process.env.AI_MODEL) {
      throw new ProviderNotConfiguredError();
    }
    const history = db.prepare('SELECT role,content FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 30').all(conversationId).reverse();
    const prompt = [...history, { role: 'user', content: parsed.data.content }];
    const reply = await createAssistantReply(prompt);
    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)');
    const save = db.transaction(() => {
      insert.run(conversationId, 'user', parsed.data.content);
      const assistant = insert.run(conversationId, 'assistant', reply);
      db.prepare('UPDATE conversations SET title=CASE WHEN title=\'新对话\' THEN ? ELSE title END,updated_at=CURRENT_TIMESTAMP WHERE id=?')
        .run(parsed.data.content.slice(0, 42), conversationId);
      return db.prepare('SELECT id,role,content,created_at FROM messages WHERE id=?').get(assistant.lastInsertRowid);
    });
    const assistantMessage = save();
    const userMessage = db.prepare('SELECT id,role,content,created_at FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 2').all(conversationId)[0];
    res.status(201).json({ userMessage: { role: 'user', content: parsed.data.content }, assistantMessage });
  } catch (error) { next(error); }
});
router.delete('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
  const result = db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?').run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  res.json({ success: true });
});
export default router;
