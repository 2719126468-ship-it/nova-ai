import { Router } from 'express';
import { rateLimit } from 'express-rate-limit';
import { z } from 'zod';
import { db } from '../db.js';
import { requireAuth } from '../middleware/auth.js';
import { config } from '../config.js';
import { getModelRegistry, resolveModel } from '../services/model-registry.js';
import {
  createAssistantReply,
  streamAssistantReply,
  ProviderNotConfiguredError,
} from '../services/provider.js';
import { isPositiveId } from '../utils.js';
import { startUsageRecord, finishUsageRecord } from '../services/usage.js';

const router = Router();
const activeGenerations = new Set();
const generationLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: 6,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => 'user:' + req.user.id,
  message: { error: 'AI_RATE_LIMITED', message: '发送过于频繁，请稍后再试。' },
});
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

function selectModel(modelId, res, next) {
  const model = resolveModel(modelId);
  if (model) return model;
  if (!getModelRegistry().configured) {
    next(new ProviderNotConfiguredError());
    return null;
  }
  res.status(404).json({ error: 'MODEL_NOT_FOUND', message: '所选模型未在服务端启用。' });
  return null;
}

function findConversation(id, userId) {
  return db.prepare('SELECT * FROM conversations WHERE id=? AND user_id=?').get(id, userId);
}

function sendSse(res, event, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function readRecentHistory(conversationId, beforeMessageId = null) {
  const rows = beforeMessageId
    ? db.prepare(
      "SELECT role,content FROM messages WHERE conversation_id=? AND status='complete' AND id<? ORDER BY id DESC LIMIT 30",
    ).all(conversationId, beforeMessageId)
    : db.prepare(
      "SELECT role,content FROM messages WHERE conversation_id=? AND status='complete' ORDER BY id DESC LIMIT 30",
    ).all(conversationId);
  return rows.reverse();
}

function buildPrompt(conversationId, currentContent, beforeMessageId = null) {
  const budget = config.aiMaxContextChars;
  if (currentContent.length > budget) return null;

  const history = readRecentHistory(conversationId, beforeMessageId);
  // A failed or cancelled turn can leave its user message complete while the
  // assistant message is failed. Do not replay that unmatched user message.
  while (history.length && history.at(-1).role === 'user') history.pop();

  const selected = [];
  let usedCharacters = currentContent.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    if (usedCharacters + message.content.length > budget) break;
    selected.push(message);
    usedCharacters += message.content.length;
  }

  selected.reverse();
  // Do not begin the prompt with an assistant message whose user turn was clipped.
  while (selected.length && selected[0].role === 'assistant') selected.shift();
  return [...selected, { role: 'user', content: currentContent }];
}


async function streamAssistantResponse(res, prompt, pending, generationKey, hooks = {}) {
  const controller = new AbortController();
  let clientDisconnected = false;
  let partialContent = '';
  let providerUsage = null;
  const onClose = () => {
    if (!res.writableEnded) {
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
    modelId: hooks.modelId || getModelRegistry().defaultModelId,
    requestId: hooks.usageRecord?.requestId || null,
  });

  try {
    const content = await streamAssistantReply(prompt, {
      modelId: hooks.modelId || getModelRegistry().defaultModelId,
      signal: controller.signal,
      onUsage(usage) { providerUsage = usage; },
      onDelta(delta) {
        partialContent += delta;
        sendSse(res, 'message_delta', {
          messageId: pending.assistantMessageId,
          delta,
        });
      },
    });

    let assistantMessage;
    if (typeof hooks.onSuccess === 'function') {
      assistantMessage = hooks.onSuccess(content);
    } else {
      db.prepare("UPDATE messages SET content=?,status='complete',error_code=NULL WHERE id=?")
        .run(content, pending.assistantMessageId);
      assistantMessage = db.prepare(
        'SELECT id,role,content,status,error_code,created_at FROM messages WHERE id=?',
      ).get(pending.assistantMessageId);
    }
    finishUsageRecord(hooks.usageRecord, { status: 'succeeded', usage: providerUsage });
    sendSse(res, 'message_complete', { assistantMessage, requestId: hooks.usageRecord?.requestId || null });
    if (!res.writableEnded && !res.destroyed) res.end();
  } catch (error) {
    const cancelled = clientDisconnected || error?.code === 'AI_REQUEST_CANCELLED';
    if (typeof hooks.onFailure === 'function') {
      hooks.onFailure(error, { partialContent, cancelled });
    } else {
      db.prepare('UPDATE messages SET content=?,status=?,error_code=? WHERE id=?')
        .run(partialContent, cancelled ? 'cancelled' : 'failed', cancelled ? 'AI_REQUEST_CANCELLED' : (error?.code || 'AI_PROVIDER_ERROR'), pending.assistantMessageId);
    }

    finishUsageRecord(hooks.usageRecord, {
      status: cancelled ? 'cancelled' : 'failed',
      usage: providerUsage,
      errorCode: cancelled ? 'AI_REQUEST_CANCELLED' : (error?.code || 'AI_PROVIDER_ERROR'),
    });

    if (!clientDisconnected && !res.writableEnded && !res.destroyed) {
      sendSse(res, cancelled ? 'message_cancelled' : 'message_error', {
        messageId: pending.assistantMessageId,
        requestId: hooks.usageRecord?.requestId || null,
        code: cancelled ? 'AI_REQUEST_CANCELLED' : (error?.code || 'AI_PROVIDER_ERROR'),
        message: cancelled ? '生成已取消。' : (error?.message || '模型生成失败，请重试。'),
      });
      res.end();
    }
  } finally {
    activeGenerations.delete(generationKey);
    res.removeListener('close', onClose);
  }
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

router.post('/:id/messages', generationLimiter, async (req, res, next) => {
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
    const selectedModel = resolveModel();
    if (!selectedModel) throw new ProviderNotConfiguredError();
    const generationKey = String(req.user.id);
    if (activeGenerations.has(generationKey)) {
      return res.status(409).json({ error: 'AI_GENERATION_IN_PROGRESS', message: '当前账号已有生成任务，请等待完成或停止后重试。' });
    }
    activeGenerations.add(generationKey);

    try {
      const prompt = buildPrompt(conversationId, parsed.data.content);
      if (!prompt) return res.status(413).json({ error: 'AI_INPUT_TOO_LARGE', message: '当前消息超过服务端配置的字符预算，请缩短后重试。' });
      const usageRecord = startUsageRecord({
        userId: req.user.id,
        providerId: selectedModel.providerId,
        modelId: selectedModel.id,
        operation: 'chat',
      });
      const controller = new AbortController();
      let clientDisconnected = false;
      let providerUsage = null;
      const onClose = () => {
        if (!res.writableEnded) {
          clientDisconnected = true;
          controller.abort();
        }
      };
      res.once('close', onClose);

      try {
        const reply = await createAssistantReply(prompt, {
          signal: controller.signal,
          modelId: selectedModel.id,
          onUsage(usage) { providerUsage = usage; },
        });
        if (clientDisconnected || controller.signal.aborted || res.destroyed) {
          finishUsageRecord(usageRecord, { status: 'cancelled', usage: providerUsage, errorCode: 'AI_REQUEST_CANCELLED' });
          return;
        }

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
        const saved = save();
        finishUsageRecord(usageRecord, { status: 'succeeded', usage: providerUsage });
        res.status(201).json({ ...saved, requestId: usageRecord.requestId });
      } catch (error) {
        const cancelled = clientDisconnected || error?.code === 'AI_REQUEST_CANCELLED';
        finishUsageRecord(usageRecord, {
          status: cancelled ? 'cancelled' : 'failed',
          usage: providerUsage,
          errorCode: cancelled ? 'AI_REQUEST_CANCELLED' : (error?.code || 'AI_PROVIDER_ERROR'),
        });
        error.requestId = usageRecord.requestId;
        if (cancelled || res.destroyed) return;
        throw error;
      } finally {
        res.removeListener('close', onClose);
      }
    } finally {
      activeGenerations.delete(generationKey);
    }
  } catch (error) {
    next(error);
  }
});

router.post('/:id/messages/stream', generationLimiter, async (req, res, next) => {
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
  const selectedModel = selectModel(parsed.data.modelId, res, next);
  if (!selectedModel) return;

  const generationKey = String(req.user.id);
  if (activeGenerations.has(generationKey)) {
    return res.status(409).json({ error: 'AI_GENERATION_IN_PROGRESS', message: '当前账号已有生成任务，请等待完成或停止后重试。' });
  }
  activeGenerations.add(generationKey);

  const prompt = buildPrompt(conversationId, parsed.data.content);
  if (!prompt) {
    activeGenerations.delete(generationKey);
    return res.status(413).json({ error: 'AI_INPUT_TOO_LARGE', message: '当前消息超过服务端配置的字符预算，请缩短后重试。' });
  }
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
    activeGenerations.delete(generationKey);
    return next(error);
  }

  let usageRecord;
  try {
    usageRecord = startUsageRecord({ userId: req.user.id, providerId: selectedModel.providerId, modelId: selectedModel.id, operation: 'stream' });
  } catch (error) {
    db.prepare('DELETE FROM messages WHERE conversation_id=? AND id IN (?,?)')
      .run(conversationId, pending.userMessage.id, pending.assistantMessageId);
    activeGenerations.delete(generationKey);
    return next(error);
  }
  return streamAssistantResponse(res, prompt, pending, generationKey, { modelId: selectedModel.id, usageRecord });
});

router.put('/:id/messages/:messageId/stream', generationLimiter, async (req, res, next) => {
  if (!isPositiveId(req.params.id) || !isPositiveId(req.params.messageId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '对话或消息编号无效。' });
  }
  const parsed = streamMessageSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: '消息不能为空，且不能超过 20,000 个字符。' });
  }

  const conversationId = Number(req.params.id);
  const messageId = Number(req.params.messageId);
  const conversation = findConversation(conversationId, req.user.id);
  if (!conversation) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });

  const target = db.prepare(
    "SELECT id,role,content,status,created_at FROM messages WHERE id=? AND conversation_id=? AND role='user'",
  ).get(messageId, conversationId);
  if (!target || target.status !== 'complete') {
    return res.status(404).json({ error: 'MESSAGE_NOT_FOUND', message: '可编辑的用户消息不存在。' });
  }
  const selectedModel = selectModel(parsed.data.modelId, res, next);
  if (!selectedModel) return;

  const generationKey = String(req.user.id);
  if (activeGenerations.has(generationKey)) {
    return res.status(409).json({ error: 'AI_GENERATION_IN_PROGRESS', message: '当前账号已有生成任务，请等待完成或停止后重试。' });
  }
  activeGenerations.add(generationKey);

  const prompt = buildPrompt(conversationId, parsed.data.content, messageId);
  if (!prompt) {
    activeGenerations.delete(generationKey);
    return res.status(413).json({ error: 'AI_INPUT_TOO_LARGE', message: '当前消息超过服务端配置的字符预算，请缩短后重试。' });
  }

  const createPending = db.transaction(() => {
    const assistantResult = db.prepare(
      "INSERT INTO messages(conversation_id,role,content,status) VALUES(?,?,?,?)",
    ).run(conversationId, 'assistant', '', 'streaming');
    return {
      userMessage: {
        id: target.id,
        role: 'user',
        content: parsed.data.content,
        status: 'complete',
        error_code: null,
        created_at: target.created_at,
      },
      assistantMessageId: assistantResult.lastInsertRowid,
    };
  });

  let pending;
  try {
    pending = createPending();
  } catch (error) {
    activeGenerations.delete(generationKey);
    return next(error);
  }

  const commitEdit = db.transaction((assistantContent) => {
    const updated = db.prepare(
      "UPDATE messages SET content=?,status='complete',error_code=NULL WHERE id=? AND conversation_id=? AND role='user'",
    ).run(parsed.data.content, messageId, conversationId);
    if (!updated.changes) {
      const error = new Error('可编辑的用户消息已不存在。');
      error.code = 'MESSAGE_NOT_FOUND';
      error.status = 404;
      throw error;
    }

    db.prepare('DELETE FROM messages WHERE conversation_id=? AND id>? AND id<>?')
      .run(conversationId, messageId, pending.assistantMessageId);

    const firstUser = db.prepare(
      "SELECT id FROM messages WHERE conversation_id=? AND role='user' ORDER BY id LIMIT 1",
    ).get(conversationId);
    const nextTitle = firstUser?.id === messageId && conversation.title === target.content.slice(0, 42)
      ? parsed.data.content.slice(0, 42)
      : conversation.title;
    db.prepare('UPDATE conversations SET title=?,updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(nextTitle, conversationId);

    db.prepare("UPDATE messages SET content=?,status='complete',error_code=NULL WHERE id=? AND conversation_id=?")
      .run(assistantContent, pending.assistantMessageId, conversationId);
    return db.prepare(
      'SELECT id,role,content,status,error_code,created_at FROM messages WHERE id=?',
    ).get(pending.assistantMessageId);
  });

  const discardPending = () => {
    db.prepare('DELETE FROM messages WHERE id=? AND conversation_id=?')
      .run(pending.assistantMessageId, conversationId);
  };

  let usageRecord;
  try {
    usageRecord = startUsageRecord({ userId: req.user.id, providerId: selectedModel.providerId, modelId: selectedModel.id, operation: 'edit' });
  } catch (error) {
    discardPending();
    activeGenerations.delete(generationKey);
    return next(error);
  }
  return streamAssistantResponse(res, prompt, pending, generationKey, {
    onSuccess: commitEdit,
    onFailure: discardPending,
    modelId: selectedModel.id,
    usageRecord,
  });
});


router.post('/:id/messages/:messageId/retry/stream', generationLimiter, async (req, res, next) => {
  if (!isPositiveId(req.params.id) || !isPositiveId(req.params.messageId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '对话或消息编号无效。' });
  }
  const parsed = streamMessageSchema.pick({ modelId: true }).safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'VALIDATION_ERROR', message: '模型参数无效。' });
  }

  const conversationId = Number(req.params.id);
  const messageId = Number(req.params.messageId);
  if (!findConversation(conversationId, req.user.id)) {
    return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  }

  const target = db.prepare(
    "SELECT id,role,content,status FROM messages WHERE id=? AND conversation_id=? AND role='assistant'",
  ).get(messageId, conversationId);
  if (!target || !['failed', 'cancelled'].includes(target.status)) {
    return res.status(404).json({ error: 'MESSAGE_NOT_RETRYABLE', message: '只有失败或已停止的回答可以重试。' });
  }

  const latest = db.prepare(
    'SELECT id FROM messages WHERE conversation_id=? ORDER BY id DESC LIMIT 1',
  ).get(conversationId);
  if (!latest || latest.id !== target.id) {
    return res.status(409).json({ error: 'MESSAGE_NOT_LATEST', message: '只能重试当前对话的最后一条失败回答。' });
  }

  const userMessage = db.prepare(
    "SELECT id,role,content,status,error_code,created_at FROM messages WHERE conversation_id=? AND id<? AND role='user' AND status='complete' ORDER BY id DESC LIMIT 1",
  ).get(conversationId, messageId);
  if (!userMessage) {
    return res.status(409).json({ error: 'RETRY_CONTEXT_MISSING', message: '找不到这条回答对应的用户问题。' });
  }

  const selectedModel = selectModel(parsed.data.modelId, res, next);
  if (!selectedModel) return;

  const generationKey = String(req.user.id);
  if (activeGenerations.has(generationKey)) {
    return res.status(409).json({ error: 'AI_GENERATION_IN_PROGRESS', message: '当前账号已有生成任务，请等待完成或停止后重试。' });
  }
  activeGenerations.add(generationKey);

  const prompt = buildPrompt(conversationId, userMessage.content, userMessage.id);
  if (!prompt) {
    activeGenerations.delete(generationKey);
    return res.status(413).json({ error: 'AI_INPUT_TOO_LARGE', message: '原始问题超过服务端配置的字符预算，无法重试。' });
  }

  let pending;
  try {
    const createPending = db.transaction(() => {
      const assistantResult = db.prepare(
        "INSERT INTO messages(conversation_id,role,content,status) VALUES(?,?,?,?)",
      ).run(conversationId, 'assistant', '', 'streaming');
      return {
        userMessage,
        assistantMessageId: assistantResult.lastInsertRowid,
      };
    });
    pending = createPending();
  } catch (error) {
    activeGenerations.delete(generationKey);
    return next(error);
  }

  const commitRetry = db.transaction((assistantContent) => {
    db.prepare('DELETE FROM messages WHERE conversation_id=? AND id>=? AND id<>?')
      .run(conversationId, messageId, pending.assistantMessageId);
    db.prepare("UPDATE messages SET content=?,status='complete',error_code=NULL WHERE id=? AND conversation_id=?")
      .run(assistantContent, pending.assistantMessageId, conversationId);
    db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(conversationId);
    return db.prepare(
      'SELECT id,role,content,status,error_code,created_at FROM messages WHERE id=?',
    ).get(pending.assistantMessageId);
  });

  const discardPending = () => {
    db.prepare('DELETE FROM messages WHERE id=? AND conversation_id=?')
      .run(pending.assistantMessageId, conversationId);
  };

  let usageRecord;
  try {
    usageRecord = startUsageRecord({ userId: req.user.id, providerId: selectedModel.providerId, modelId: selectedModel.id, operation: 'retry' });
  } catch (error) {
    discardPending();
    activeGenerations.delete(generationKey);
    return next(error);
  }
  return streamAssistantResponse(res, prompt, pending, generationKey, {
    onSuccess: commitRetry,
    onFailure: discardPending,
    modelId: selectedModel.id,
    usageRecord,
  });
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
