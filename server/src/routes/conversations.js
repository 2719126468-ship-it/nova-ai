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
import { countPromptTokens } from '../services/token-budget.js';

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

function archiveMessageVersion(messageId, content, status, errorCode, source) {
  if (!['complete', 'failed', 'cancelled'].includes(status)) return;
  db.prepare(
    'INSERT INTO message_versions (message_id,content,status,error_code,source) VALUES (?,?,?,?,?)',
  ).run(messageId, content || '', status, errorCode || null, source);
}

function copyMessageVersions(sourceMessageId, destinationMessageId) {
  db.prepare(`
    INSERT INTO message_versions (message_id,content,status,error_code,source,created_at)
    SELECT ?,content,status,error_code,source,created_at
    FROM message_versions WHERE message_id=? ORDER BY id
  `).run(destinationMessageId, sourceMessageId);
}

function sendSse(res, event, payload) {
  if (res.writableEnded || res.destroyed) return;
  res.write('event: ' + event + '\n');
  res.write('data: ' + JSON.stringify(payload) + '\n\n');
}

function readRecentHistory(conversationId, beforeMessageId = null) {
  const rows = beforeMessageId
    ? db.prepare(
      "SELECT role,content FROM messages WHERE conversation_id=? AND status='complete' AND id<? ORDER BY id DESC LIMIT 31",
    ).all(conversationId, beforeMessageId)
    : db.prepare(
      "SELECT role,content FROM messages WHERE conversation_id=? AND status='complete' ORDER BY id DESC LIMIT 31",
    ).all(conversationId);
  return {
    messages: rows.slice(0, 30).reverse(),
    hasOlderHistory: rows.length > 30,
  };
}

function buildPrompt(conversationId, currentContent, model, beforeMessageId = null) {
  const characterBudget = config.aiMaxContextChars;
  const contextWindowTokens = Number.isSafeInteger(model.contextLimit) && model.contextLimit > 0
    ? model.contextLimit
    : null;
  const canUseByteUpperBound = contextWindowTokens !== null;
  const contextLimitSource = model.contextLimitSource || 'unknown';
  const inputTokenBudget = contextWindowTokens === null
    ? null
    : Math.max(0, Math.floor(contextWindowTokens * (1 - config.aiContextSafetyMarginPercent / 100)) - config.aiContextOutputReserve);

  const currentMessage = { role: 'user', content: currentContent };
  const currentEstimate = countPromptTokens([currentMessage], model, { allowByteUpperBound: canUseByteUpperBound });
  const currentIsTooLongByCharacters = currentContent.length > characterBudget;
  const currentIsTooLongByTokens = inputTokenBudget !== null
    && (currentEstimate.tokens === null || currentEstimate.tokens > inputTokenBudget);

  const contextPolicy = {
    maxMessageContentCharacters: characterBudget,
    modelContextWindowTokens: contextWindowTokens,
    modelContextWindowSource: contextLimitSource,
    inputTokenBudget,
    estimatedInputTokens: currentEstimate.tokens,
    tokenizer: currentEstimate.tokenizer,
    tokenEstimateSource: currentEstimate.source,
    outputReserveTokens: config.aiContextOutputReserve,
    outputLimitEnforced: model.maxTokensParameter !== 'none',
    safetyMarginPercent: contextWindowTokens === null ? null : config.aiContextSafetyMarginPercent,
    currentMessagePreserved: true,
    historyTruncated: false,
    historyMessagesIncluded: 0,
    historyMessagesOmitted: 0,
    olderHistoryOmitted: false,
    mode: contextWindowTokens === null ? 'character_fallback' : 'model_context_budget',
  };

  if (currentIsTooLongByCharacters || currentIsTooLongByTokens) {
    return {
      prompt: null,
      contextPolicy,
      error: {
        code: 'AI_INPUT_TOO_LARGE',
        message: currentIsTooLongByTokens
          ? '当前问题超过该模型可用的输入预算。系统已预留回复空间和安全余量，请缩短问题后重试。'
          : '当前问题超过服务端字符上限，请缩短后重试。',
      },
    };
  }

  const { messages: history, hasOlderHistory } = readRecentHistory(conversationId, beforeMessageId);
  // A failed or cancelled turn can leave its user message complete while the
  // assistant message is failed. Do not replay that unmatched user message.
  while (history.length && history.at(-1).role === 'user') history.pop();

  const selected = [];
  let usedCharacters = currentContent.length;
  for (let index = history.length - 1; index >= 0; index -= 1) {
    const message = history[index];
    const nextCharacters = usedCharacters + message.content.length;
    if (nextCharacters > characterBudget) break;

    const candidateHistory = [...selected].reverse().concat(message);
    const candidatePrompt = [...candidateHistory, currentMessage];
    const candidateEstimate = countPromptTokens(candidatePrompt, model, {
      allowByteUpperBound: canUseByteUpperBound,
    });
    if (inputTokenBudget !== null
      && (candidateEstimate.tokens === null || candidateEstimate.tokens > inputTokenBudget)) {
      break;
    }

    selected.push(message);
    usedCharacters = nextCharacters;
  }

  selected.reverse();
  // Do not begin the prompt with an assistant message whose user turn was clipped.
  while (selected.length && selected[0].role === 'assistant') selected.shift();

  const prompt = [...selected, currentMessage];
  const finalEstimate = countPromptTokens(prompt, model, { allowByteUpperBound: canUseByteUpperBound });
  contextPolicy.estimatedInputTokens = finalEstimate.tokens;
  contextPolicy.tokenizer = finalEstimate.tokenizer;
  contextPolicy.tokenEstimateSource = finalEstimate.source;
  contextPolicy.historyMessagesIncluded = selected.length;
  contextPolicy.historyMessagesOmitted = Math.max(0, history.length - selected.length);
  contextPolicy.olderHistoryOmitted = hasOlderHistory;
  contextPolicy.historyTruncated = contextPolicy.historyMessagesOmitted > 0 || hasOlderHistory;

  return { prompt, contextPolicy, error: null };
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
    contextPolicy: hooks.contextPolicy || null,
  });

  try {
    const content = await streamAssistantReply(prompt, {
      modelId: hooks.modelId || getModelRegistry().defaultModelId,
      maxOutputTokens: hooks.contextPolicy?.outputReserveTokens,
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
        `SELECT id,role,content,status,error_code,created_at,
          (SELECT COUNT(*) FROM message_versions v WHERE v.message_id=messages.id) AS version_count
        FROM messages WHERE id=?`,
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
    `SELECT m.id,m.role,m.content,m.status,m.error_code,m.created_at,
      (SELECT COUNT(*) FROM message_versions v WHERE v.message_id=m.id) AS version_count
    FROM messages m WHERE m.conversation_id=? ORDER BY m.id`,
  ).all(conversation.id);
  res.json({ conversation, messages });
});

router.get('/:id/messages/:messageId/versions', (req, res) => {
  if (!isPositiveId(req.params.id) || !isPositiveId(req.params.messageId)) {
    return res.status(400).json({ error: 'INVALID_ID', message: '对话或消息编号无效。' });
  }
  const conversationId = Number(req.params.id);
  const messageId = Number(req.params.messageId);
  if (!findConversation(conversationId, req.user.id)) {
    return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });
  }
  const message = db.prepare(
    "SELECT id FROM messages WHERE id=? AND conversation_id=? AND role='assistant'",
  ).get(messageId, conversationId);
  if (!message) return res.status(404).json({ error: 'MESSAGE_NOT_FOUND', message: '回答不存在。' });
  const versions = db.prepare(
    'SELECT id,content,status,error_code,source,created_at FROM message_versions WHERE message_id=? ORDER BY id DESC',
  ).all(messageId);
  res.json({ versions });
});

router.post('/:id/messages/:messageId/restore', (req, res, next) => {
  try {
    if (!isPositiveId(req.params.id) || !isPositiveId(req.params.messageId)) {
      return res.status(400).json({ error: 'INVALID_ID', message: '对话或消息编号无效。' });
    }
    const versionId = Number(req.body?.versionId);
    if (!Number.isSafeInteger(versionId) || versionId < 1) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: '请选择有效的回答版本。' });
    }

    const conversationId = Number(req.params.id);
    const messageId = Number(req.params.messageId);
    const conversation = findConversation(conversationId, req.user.id);
    if (!conversation) return res.status(404).json({ error: 'NOT_FOUND', message: '对话不存在。' });

    const generationKey = String(req.user.id);
    if (activeGenerations.has(generationKey)) {
      return res.status(409).json({ error: 'AI_GENERATION_IN_PROGRESS', message: '请等待当前生成完成后再恢复回答版本。' });
    }

    const message = db.prepare(
      "SELECT id,role,content,status,error_code FROM messages WHERE id=? AND conversation_id=? AND role='assistant'",
    ).get(messageId, conversationId);
    if (!message) return res.status(404).json({ error: 'MESSAGE_NOT_FOUND', message: '回答不存在。' });
    if (message.status === 'streaming') {
      return res.status(409).json({ error: 'MESSAGE_STILL_STREAMING', message: '生成尚未完成，暂时无法恢复版本。' });
    }

    const version = db.prepare(
      'SELECT id,content,status,error_code FROM message_versions WHERE id=? AND message_id=?',
    ).get(versionId, messageId);
    if (!version) return res.status(404).json({ error: 'VERSION_NOT_FOUND', message: '回答版本不存在。' });

    const result = db.transaction(() => {
      archiveMessageVersion(message.id, message.content, message.status, message.error_code, 'restore');
      db.prepare(
        'UPDATE messages SET content=?,status=?,error_code=? WHERE id=? AND conversation_id=? AND role=\'assistant\'',
      ).run(version.content, version.status, version.error_code, messageId, conversationId);
      // The selected historical version becomes current; the former current answer
      // is now the new restorable version, so the history count stays stable.
      db.prepare('DELETE FROM message_versions WHERE id=? AND message_id=?').run(versionId, messageId);
      db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?').run(conversationId);

      const restoredMessage = db.prepare(`
        SELECT m.id,m.role,m.content,m.status,m.error_code,m.created_at,
          (SELECT COUNT(*) FROM message_versions v WHERE v.message_id=m.id) AS version_count
        FROM messages m WHERE m.id=? AND m.conversation_id=?
      `).get(messageId, conversationId);
      const versions = db.prepare(
        'SELECT id,content,status,error_code,source,created_at FROM message_versions WHERE message_id=? ORDER BY id DESC',
      ).all(messageId);
      return { message: restoredMessage, versions };
    })();

    return res.json(result);
  } catch (error) {
    return next(error);
  }
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
      const promptResult = buildPrompt(conversationId, parsed.data.content, selectedModel);
      if (!promptResult.prompt) return res.status(413).json({ ...promptResult.error, contextPolicy: promptResult.contextPolicy });
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
        const reply = await createAssistantReply(promptResult.prompt, {
          signal: controller.signal,
          modelId: selectedModel.id,
          maxOutputTokens: promptResult.contextPolicy.outputReserveTokens,
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
        res.status(201).json({ ...saved, requestId: usageRecord.requestId, contextPolicy: promptResult.contextPolicy });
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

  const promptResult = buildPrompt(conversationId, parsed.data.content, selectedModel);
  if (!promptResult.prompt) {
    activeGenerations.delete(generationKey);
    return res.status(413).json({ ...promptResult.error, contextPolicy: promptResult.contextPolicy });
  }
  const prompt = promptResult.prompt;
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
  return streamAssistantResponse(res, prompt, pending, generationKey, { modelId: selectedModel.id, usageRecord, contextPolicy: promptResult.contextPolicy });
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

  const promptResult = buildPrompt(conversationId, parsed.data.content, selectedModel, messageId);
  if (!promptResult.prompt) {
    activeGenerations.delete(generationKey);
    return res.status(413).json({ ...promptResult.error, contextPolicy: promptResult.contextPolicy });
  }
  const prompt = promptResult.prompt;

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

    const previousAssistant = db.prepare(
      "SELECT id,content,status,error_code FROM messages WHERE conversation_id=? AND id>? AND id<? AND role='assistant' ORDER BY id LIMIT 1",
    ).get(conversationId, messageId, pending.assistantMessageId);
    if (previousAssistant) {
      copyMessageVersions(previousAssistant.id, pending.assistantMessageId);
      archiveMessageVersion(
        pending.assistantMessageId,
        previousAssistant.content,
        previousAssistant.status,
        previousAssistant.error_code,
        'edit_regeneration',
      );
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
      `SELECT id,role,content,status,error_code,created_at,
        (SELECT COUNT(*) FROM message_versions v WHERE v.message_id=messages.id) AS version_count
      FROM messages WHERE id=?`,
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
    contextPolicy: promptResult.contextPolicy,
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
    "SELECT id,role,content,status,error_code FROM messages WHERE id=? AND conversation_id=? AND role='assistant'",
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

  const promptResult = buildPrompt(conversationId, userMessage.content, selectedModel, userMessage.id);
  if (!promptResult.prompt) {
    activeGenerations.delete(generationKey);
    return res.status(413).json({ ...promptResult.error, contextPolicy: promptResult.contextPolicy });
  }
  const prompt = promptResult.prompt;

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
    copyMessageVersions(target.id, pending.assistantMessageId);
    archiveMessageVersion(
      pending.assistantMessageId,
      target.content,
      target.status,
      target.error_code,
      'retry',
    );
    db.prepare('DELETE FROM messages WHERE conversation_id=? AND id>=? AND id<>?')
      .run(conversationId, messageId, pending.assistantMessageId);
    db.prepare("UPDATE messages SET content=?,status='complete',error_code=NULL WHERE id=? AND conversation_id=?")
      .run(assistantContent, pending.assistantMessageId, conversationId);
    db.prepare('UPDATE conversations SET updated_at=CURRENT_TIMESTAMP WHERE id=?')
      .run(conversationId);
    return db.prepare(
      `SELECT id,role,content,status,error_code,created_at,
        (SELECT COUNT(*) FROM message_versions v WHERE v.message_id=messages.id) AS version_count
      FROM messages WHERE id=?`,
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
    contextPolicy: promptResult.contextPolicy,
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
