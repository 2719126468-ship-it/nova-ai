import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import {
  createAssistantReply,
  streamAssistantReply,
  ProviderNotConfiguredError,
} from '../services/provider.js';
import { isPositiveId } from '../utils.js';

const router = Router();
const messageSchema = z.object({
  content: z.string().trim().min(1).max(20000),
});
const streamMessageSchema = messageSchema.extend({
  modelId: z.string().trim().min(1).max(120).optional(),
});
const titleSchema = z.object({
  title: z.string().trim().min(1).max(100),
});
router.use(requireAuth);

const aiUserRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  keyGenerator: (req) => 'user:' + String(req.user.id),
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'AI_USER_RATE_LIMITED',
    message: '你的 AI 请求次数已达到当前窗口上限（20 次/15 分钟），请稍后重试。',
  },
});

const aiIpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: {
    error: 'AI_IP_RATE_LIMITED',
    message: '当前网络的 AI 请求过于频繁，请稍后重试。',
  },
});

const activeAiUsers = new Set();
function limitConcurrentAiRequests(req, res, next) {
  const userKey = String(req.user.id);
  if (activeAiUsers.has(userKey)) {
    return res.status(429).json({
      error: 'AI_CONCURRENCY_LIMITED',
      message: '同一账号当前只能运行一个 AI 生成任务，请先停止或等待当前任务完成。',
    });
  }

  activeAiUsers.add(userKey);
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    activeAiUsers.delete(userKey);
  };
  res.once('finish', release);
  res.once('close', release);
  next();
}

function findConversation(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
}

function sendSse(res, event, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function readRecentHistory(conversationId) {
  return db.prepare(
    "SELECT role,content FROM messages WHERE conversation_id=? AND status='complete' ORDER BY id DESC LIMIT 30",
  ).all(conversationId).reverse();
}

router.get('/', (req, res) => {
  const conversations = db.prepare(`
    SELECT c.id,c.title,c.created_at,c.updated_at,
      (SELECT content FROM messages m WHERE m.conversation_id=c.id ORDER BY m.id DESC LIMIT 1) AS last_message
    FROM conversations c
    WHERE c.user_id=?
    ORDER BY c.updated_at DESC
  `).all(req.user.id);
  res.json({ conversations });
});

router.post('/', (req, res) => {
  const title = typeof req.body?.title === 'string' ? req.body.title.trim().slice(0, 100) : '新对话';
  const result = db.prepare('INSERT INTO conversations(user_id,title) VALUES(?,?)')
    .run(req.user.id, title || '新对话');
  const conversation = findConversation(result.lastInsertRowid, req.user.id);
  res.status(201).json({ conversation });
});

router.get('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
  }
  const conversation = findConversation(Number(req.params.id), req.user.id);
  if (!conversation) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  const messages = db.prepare(
    'SELECT id,role,content,status,error_code,created_at FROM messages WHERE conversation_id=? ORDER BY id',
  ).all(conversation.id);
  res.json({ conversation, messages });
});

router.patch('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
  }
  const parsed = titleSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: '标题不能为空，且不能超过 100 个字符。' });
  }
  const result = db.prepare(
    'UPDATE conversations SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=? AND user_id=?',
  ).run(parsed.data.title, Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  res.json({ conversation: findConversation(Number(req.params.id), req.user.id) });
});

router.post('/:id/messages', aiUserRateLimiter, aiIpRateLimiter, limitConcurrentAiRequests, async (req, res, next) => {
  try {
    if (!isPositiveId(req.params.id)) {
      return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
    }
    const parsed = messageSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: '消息不能为空，且不能超过 20,000 个字符。' });
    }
    const conversationId = Number(req.params.id);
    if (!findConversation(conversationId, req.user.id)) {
      return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
    }
    if (!config.aiConfigured) throw new ProviderNotConfiguredError();

    const prompt = [...readRecentHistory(conversationId), { role: 'user', content: parsed.data.content }];
    const controller = new AbortController();
    const onClose = () => {
      if (!res.writableEnded && !res.destroyed) controller.abort();
    };
    res.once('close', onClose);

    let reply;
    try {
      reply = await createAssistantReply(prompt, { signal: controller.signal });
    } catch (error) {
      if (controller.signal.aborted) return;
      throw error;
    } finally {
      res.removeListener('close', onClose);
    }
    if (controller.signal.aborted || res.destroyed) return;

    const insert = db.prepare('INSERT INTO messages(conversation_id,role,content) VALUES(?,?,?)');
    const save = db.transaction(() => {
      const userResult = insert.run(conversationId, 'user', parsed.data.content);
      const assistantResult = insert.run(conversationId, 'assistant', reply);
      db.prepare("UPDATE conversations SET title=CASE WHEN title='新对话' THEN ? ELSE title END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
        .run(parsed.data.content.slice(0, 42), conversationId);
      return {
        userMessage: db.prepare('SELECT id,role,content,status,created_at FROM messages WHERE id=?').get(userResult.lastInsertRowid),
        assistantMessage: db.prepare('SELECT id,role,content,status,created_at FROM messages WHERE id=?').get(assistantResult.lastInsertRowid),
      };
    });
    res.status(201).json(save());
  } catch (error) {
    next(error);
  }
});

router.post('/:id/messages/stream', aiUserRateLimiter, aiIpRateLimiter, limitConcurrentAiRequests, async (req, res, next) => {
  if (!isPositiveId(req.params.id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
  }
  const parsed = streamMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: '消息不能为空，且不能超过 20,000 个字符。' });
  }

  const conversationId = Number(req.params.id);
  if (!findConversation(conversationId, req.user.id)) {
    return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  }
  if (!config.aiConfigured) return next(new ProviderNotConfiguredError());
  if (parsed.data.modelId && parsed.data.modelId !== config.aiModel) {
    return res.status(404).json({ error: 'MODEL_NOT_FOUND', message: '所选模型未在服务端启用。' });
  }

  const prompt = [...readRecentHistory(conversationId), { role: 'user', content: parsed.data.content }];
  const insert = db.prepare('INSERT INTO messages(conversation_id,role,content,status) VALUES(?,?,?,?)');
  const createPendingMessages = db.transaction(() => {
    const userResult = insert.run(conversationId, 'user', parsed.data.content, 'complete');
    const assistantResult = insert.run(conversationId, 'assistant', '', 'streaming');
    db.prepare("UPDATE conversations SET title=CASE WHEN title='新对话' THEN ? ELSE title END,updated_at=CURRENT_TIMESTAMP WHERE id=?")
      .run(parsed.data.content.slice(0, 42), conversationId);
    return {
      userMessage: db.prepare('SELECT id,role,content,status,created_at FROM messages WHERE id=?').get(userResult.lastInsertRowid),
      assistantMessageId: assistantResult.lastInsertRowid,
    };
  });

  let pending;
  try {
    pending = createPendingMessages();
  } catch (error) {
    return next(error);
  }

  const controller = new AbortController();
  let clientDisconnected = false;
  let partialContent = '';
  const onClose = () => {
    if (!res.writableEnded && !res.destroyed) {
      clientDisconnected = true;
      controller.abort();
    }
  };
  res.once('close', onClose);

  res.status(200);
  res.set({
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  });
  res.flushHeaders();
  sendSse(res, 'message_start', {
    userMessage: pending.userMessage,
    assistantMessageId: pending.assistantMessageId,
    modelId: config.aiModel,
  });

  try {
    const content = await streamAssistantReply(prompt, {
      signal: controller.signal,
      onDelta(delta) {
        partialContent += delta;
        sendSse(res, 'message_delta', {
          messageId: pending.assistantMessageId,
          delta,
        });
      },
    });

    db.prepare("UPDATE messages SET content=?,status='complete',error_code=NULL WHERE id=?")
      .run(content, pending.assistantMessageId);
    const assistantMessage = db.prepare(
      'SELECT id,role,content,status,error_code,created_at FROM messages WHERE id=?',
    ).get(pending.assistantMessageId);
    sendSse(res, 'message_complete', { assistantMessage });
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (error) {
    const cancelled = clientDisconnected || error?.code === 'AI_REQUEST_CANCELLED';
    db.prepare('UPDATE messages SET content=?,status=?,error_code=? WHERE id=?')
      .run(partialContent, cancelled ? 'cancelled' : 'failed', cancelled ? 'AI_REQUEST_CANCELLED' : (error?.code || 'AI_PROVIDER_ERROR'), pending.assistantMessageId);

    if (!clientDisconnected && !res.writableEnded && !res.destroyed) {
      sendSse(res, cancelled ? 'message_cancelled' : 'message_error', {
        messageId: pending.assistantMessageId,
        code: cancelled ? 'AI_REQUEST_CANCELLED' : (error?.code || 'AI_PROVIDER_ERROR'),
        message: cancelled ? '生成已取消。' : (error?.message || '模型生成失败，请重试。'),
      });
      res.end();
    }
  } finally {
    res.removeListener('close', onClose);
  }
});

router.delete('/:id', (req, res) => {
  if (!isPositiveId(req.params.id)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '对话编号无效。' });
  }
  const result = db.prepare('DELETE FROM conversations WHERE id=? AND user_id=?')
    .run(Number(req.params.id), req.user.id);
  if (!result.changes) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  res.json({ success: true });
});

export default router;
