import { Router } from 'express';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth, requireAdmin } from '../middleware/auth.js';
import { decryptProviderSecret, encryptProviderSecret } from '../services/provider-secrets.js';
import { getModelRegistry } from '../services/model-registry.js';

const providerIdSchema = z.string().trim().regex(/^[a-zA-Z0-9_-]{1,64}$/);
const modelSchema = z.object({
  id: z.string().trim().min(1).max(200),
  name: z.string().trim().min(1).max(120).optional(),
  enabled: z.boolean().optional().default(true),
  capabilities: z.array(z.string().trim().min(1).max(40)).max(20).optional().default(['chat', 'text']),
  contextLimit: z.number().int().positive().max(10000000).nullable().optional().default(null),
  tokenizer: z.enum(['auto', 'cl100k_base', 'o200k_base', 'none']).optional().default('auto'),
  maxTokensParameter: z.enum(['auto', 'max_tokens', 'max_completion_tokens', 'none']).optional().default('auto'),
});

function addUniqueModelIds(models, ctx) {
  const seen = new Set();
  models.forEach((model, index) => {
    if (seen.has(model.id)) {
      ctx.addIssue({ code: 'custom', path: ['models', index, 'id'], message: '模型 ID 不能重复。' });
    }
    seen.add(model.id);
  });
}

const providerBaseUrlSchema = z.string().trim().min(1).max(500).superRefine((value, ctx) => {
  try {
    const url = new URL(value);
    const allowedProtocol = url.protocol === 'https:' || (config.nodeEnv !== 'production' && url.protocol === 'http:');
    if (!url.hostname || !allowedProtocol || url.username || url.password || url.search || url.hash) {
      ctx.addIssue({ code: 'custom', message: '生产环境必须使用 HTTPS；地址不能包含账号、密码、查询参数或片段。' });
    }
  } catch {
    ctx.addIssue({ code: 'custom', message: '请输入有效的 Provider API 基础地址。' });
  }
});

const providerCreateSchema = z.object({
  id: providerIdSchema,
  name: z.string().trim().min(1).max(120),
  baseUrl: providerBaseUrlSchema,
  apiKey: z.string().trim().min(1).max(4000),
  enabled: z.boolean().optional().default(true),
  models: z.array(modelSchema).min(1).max(100),
}).superRefine((value, ctx) => addUniqueModelIds(value.models, ctx));

const providerUpdateSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  baseUrl: providerBaseUrlSchema.optional(),
  apiKey: z.string().max(4000).optional(),
  enabled: z.boolean().optional(),
  models: z.array(modelSchema).min(1).max(100).optional(),
}).superRefine((value, ctx) => {
  if (value.models) addUniqueModelIds(value.models, ctx);
  if (!Object.keys(value).length) ctx.addIssue({ code: 'custom', message: '至少提供一个需要更新的字段。' });
});

function normalizeStoredModels(models) {
  return models.map((model) => ({
    id: model.id.trim(),
    name: model.name?.trim() || model.id.trim(),
    enabled: model.enabled !== false,
    capabilities: [...new Set(model.capabilities || ['chat', 'text'])],
    contextLimit: model.contextLimit ?? null,
    tokenizer: model.tokenizer || 'auto',
    maxTokensParameter: model.maxTokensParameter || 'auto',
  }));
}

function readManagedProviderRows() {
  return db.prepare(
    'SELECT id,name,protocol,base_url,enabled,models_json,api_key_encrypted,created_at,updated_at FROM ai_providers ORDER BY name COLLATE NOCASE,id',
  ).all().map((row) => {
    let models = [];
    try {
      const parsed = JSON.parse(row.models_json);
      models = Array.isArray(parsed) ? parsed : [];
    } catch {
      models = [];
    }
    return {
      id: row.id,
      name: row.name,
      protocol: row.protocol,
      baseUrl: row.base_url,
      enabled: row.enabled === 1,
      models,
      hasApiKey: Boolean(row.api_key_encrypted),
      source: 'database',
      readOnly: false,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    };
  });
}

function providerManagementState() {
  const managedProviders = readManagedProviderRows();
  const managedIds = new Set(managedProviders.map((provider) => provider.id));
  const registry = getModelRegistry();
  const environmentProviders = registry.providers
    .filter((provider) => !managedIds.has(provider.id))
    .map((provider) => ({
      id: provider.id,
      name: provider.name,
      protocol: 'openai-compatible',
      baseUrl: null,
      enabled: true,
      models: registry.models
        .filter((model) => model.provider === provider.id)
        .map((model) => ({
          id: model.id.slice(provider.id.length + 1),
          name: model.name,
          enabled: model.enabled,
          capabilities: model.capabilities,
          contextLimit: model.contextLimit,
        })),
      hasApiKey: provider.configured,
      source: 'environment',
      readOnly: true,
    }));
  const storedDefault = db.prepare("SELECT value FROM ai_settings WHERE key='default_model_id'").get()?.value || '';
  const environmentControlsDefault = Boolean(config.aiDefaultModelId || config.aiModel);

  return {
    providers: [...managedProviders, ...environmentProviders],
    defaultModelId: registry.defaultModelId,
    defaultModelSource: environmentControlsDefault ? 'environment' : (storedDefault ? 'database' : 'automatic'),
    canManageProviders: Boolean(config.providerEncryptionKey),
    environmentProviderCount: environmentProviders.length,
    configurationError: registry.configurationError,
  };
}

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
      COALESCE(SUM(CASE WHEN status='succeeded' THEN 1 ELSE 0 END),0) AS succeeded,
      COALESCE(SUM(CASE WHEN status='failed' THEN 1 ELSE 0 END),0) AS failed,
      COALESCE(SUM(CASE WHEN status='cancelled' THEN 1 ELSE 0 END),0) AS cancelled,
      COALESCE(SUM(CASE WHEN usage_source='provider' THEN 1 ELSE 0 END),0) AS providerReportedRequests,
      COALESCE(SUM(input_tokens),0) AS reportedInputTokens,
      COALESCE(SUM(output_tokens),0) AS reportedOutputTokens,
      COALESCE(SUM(total_tokens),0) AS reportedTotalTokens
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

router.get('/providers', (req, res) => {
  res.set('Cache-Control', 'no-store');
  res.json(providerManagementState());
});

router.post('/providers', (req, res, next) => {
  try {
    const parsed = providerCreateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Provider 信息无效，请检查地址、密钥和模型列表。', details: z.flattenError(parsed.error) });
    }
    const input = parsed.data;
    if (db.prepare('SELECT id FROM ai_providers WHERE id=?').get(input.id)
      || getModelRegistry().providers.some((provider) => provider.id === input.id)) {
      return res.status(409).json({ error: 'PROVIDER_ID_RESERVED', message: '该 Provider ID 已由环境配置或数据库占用。' });
    }

    const secret = encryptProviderSecret(input.apiKey);
    const models = normalizeStoredModels(input.models);
    db.prepare(`
      INSERT INTO ai_providers(id,name,protocol,base_url,api_key_encrypted,enabled,models_json)
      VALUES(?,?,'openai-compatible',?,?,?,?)
    `).run(input.id, input.name, input.baseUrl.replace(/\/+$/, ''), secret, input.enabled ? 1 : 0, JSON.stringify(models));

    res.status(201).json(providerManagementState());
  } catch (error) {
    next(error);
  }
});

router.put('/providers/:id', (req, res, next) => {
  try {
    const parsed = providerUpdateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: 'Provider 更新内容无效。', details: z.flattenError(parsed.error) });
    }
    const id = providerIdSchema.safeParse(req.params.id);
    if (!id.success) return res.status(400).json({ error: 'INVALID_ID', message: 'Provider ID 无效。' });

    if (!config.providerEncryptionKey) {
      return res.status(503).json({ error: 'PROVIDER_ENCRYPTION_NOT_CONFIGURED', message: '请先在服务器配置 PROVIDER_ENCRYPTION_KEY。' });
    }
    const current = db.prepare('SELECT * FROM ai_providers WHERE id=?').get(id.data);
    if (!current) return res.status(404).json({ error: 'PROVIDER_NOT_FOUND', message: '找不到可管理的 Provider。' });
    const input = parsed.data;
    if (typeof input.apiKey !== 'string' || !input.apiKey.trim()) decryptProviderSecret(current.api_key_encrypted);
    const apiKeyEncrypted = typeof input.apiKey === 'string' && input.apiKey.trim()
      ? encryptProviderSecret(input.apiKey)
      : current.api_key_encrypted;
    const models = input.models ? normalizeStoredModels(input.models) : JSON.parse(current.models_json);
      const nextBaseUrl = input.baseUrl ? input.baseUrl.replace(/\/+$/, '') : current.base_url;
    const contextSourceChanged = nextBaseUrl !== current.base_url || input.models !== undefined;
    db.prepare(`
      UPDATE ai_providers
      SET name=?,base_url=?,api_key_encrypted=?,enabled=?,models_json=?,updated_at=CURRENT_TIMESTAMP
      WHERE id=?
    `).run(
      input.name ?? current.name,
      nextBaseUrl,
      apiKeyEncrypted,
      input.enabled === undefined ? current.enabled : (input.enabled ? 1 : 0),
      JSON.stringify(models),
      id.data,
    );
    if (contextSourceChanged) {
      db.prepare('DELETE FROM model_context_windows WHERE provider_id=?').run(id.data);
    }

    res.json(providerManagementState());
  } catch (error) {
    next(error);
  }
});

router.delete('/providers/:id', (req, res) => {
  const id = providerIdSchema.safeParse(req.params.id);
  if (!id.success) return res.status(400).json({ error: 'INVALID_ID', message: 'Provider ID 无效。' });
  const result = db.transaction(() => {
    const deleted = db.prepare('DELETE FROM ai_providers WHERE id=?').run(id.data);
    if (deleted.changes) {
      db.prepare('DELETE FROM model_context_windows WHERE provider_id=?').run(id.data);
    }
    return deleted;
  })();
  if (!result.changes) return res.status(404).json({ error: 'PROVIDER_NOT_FOUND', message: '找不到可管理的 Provider。' });
  const defaultSetting = db.prepare("SELECT value FROM ai_settings WHERE key='default_model_id'").get()?.value || '';
  if (defaultSetting.startsWith(id.data + ':')) {
    db.prepare("DELETE FROM ai_settings WHERE key='default_model_id'").run();
  }
  res.json(providerManagementState());
});

router.put('/model-default', (req, res) => {
  const parsed = z.object({
    defaultModelId: z.string().trim().min(1).max(300).nullable(),
  }).safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '默认模型 ID 无效。' });
  if (config.aiDefaultModelId || config.aiModel) {
    return res.status(409).json({ error: 'DEFAULT_MODEL_ENV_MANAGED', message: '默认模型由服务器环境变量控制，请先调整 AI_DEFAULT_MODEL / AI_MODEL。' });
  }

  const modelId = parsed.data.defaultModelId;
  if (modelId !== null) {
    const model = getModelRegistry().models.find((entry) => entry.id === modelId && entry.selectable);
    if (!model) return res.status(400).json({ error: 'DEFAULT_MODEL_NOT_SELECTABLE', message: '默认模型必须是已启用且配置完整的模型。' });
    db.prepare(`
      INSERT INTO ai_settings(key,value,updated_at) VALUES('default_model_id',?,CURRENT_TIMESTAMP)
      ON CONFLICT(key) DO UPDATE SET value=excluded.value,updated_at=CURRENT_TIMESTAMP
    `).run(modelId);
  } else {
    db.prepare("DELETE FROM ai_settings WHERE key='default_model_id'").run();
  }
  res.json(providerManagementState());
});

export default router;
