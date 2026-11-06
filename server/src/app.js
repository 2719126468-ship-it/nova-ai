import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { getModelRegistry } from './services/model-registry.js';
import { requireAuth } from './middleware/auth.js';
import { probeModel } from './services/model-health.js';
import { requireAppRequest } from './middleware/security.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import projectContextRoutes from './routes/project-context.js';
import documentRoutes from './routes/documents.js';
import conversationRoutes from './routes/conversations.js';
import researchRoutes from './routes/research.js';
import adminRoutes from './routes/admin.js';

function getModelCatalog() {
  const registry = getModelRegistry();
  const defaultModel = registry.models.find((model) => model.id === registry.defaultModelId) || null;
  const provider = defaultModel
    ? registry.providers.find((item) => item.id === defaultModel.provider)
    : null;

  return {
    configured: registry.configured,
    defaultModelId: registry.defaultModelId,
    provider: provider || {
      id: null,
      name: 'No configured provider',
      configured: false,
      health: 'unknown',
      status: 'not_configured',
    },
    providers: registry.providers,
    models: registry.models,
    contextPolicy: {
      maxMessageContentCharacters: config.aiMaxContextChars,
      outputReserveTokens: config.aiContextOutputReserve,
      safetyMarginPercent: config.aiContextSafetyMarginPercent,
      mode: 'per_model',
      note: '模型上下文上限和输入 Token 数会分别标注来源；字符预算始终作为额外硬限制。',
    },
    configurationError: registry.configurationError,
    note: registry.configured
      ? '配置完整不代表上游服务已连通；当前尚未执行主动健康检查。'
      : '尚未配置可选择的模型。模型密钥只从服务端环境变量读取。',
  };
}

export function createApp() {
  const app = express();
  app.disable('x-powered-by');
  app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false }));
  app.use(cors({
    origin(origin, callback) {
      callback(null, !origin || config.webOrigins.includes(origin));
    },
    credentials: true,
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Content-Type', 'X-Requested-With', 'X-File-Name'],
  }));
  app.use(express.json({ limit: '1mb' }));
  app.use(cookieParser());
  app.use('/api', requireAppRequest);

  const apiLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 300,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试。' },
  });
  const authLimiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    // Keep production at 20 attempts; isolated integration tests create many temporary accounts.
    limit: config.nodeEnv === 'test' ? 100 : 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'AUTH_RATE_LIMITED', message: '登录或注册尝试过于频繁，请稍后再试。' },
  });
  app.use('/api', apiLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/register', authLimiter);

  const health = (req, res) => {
    const catalog = getModelCatalog();
    res.json({
      status: 'ok',
      service: 'NOVA API',
      version: '0.1.0',
      ai: {
        configured: catalog.configured,
        status: catalog.provider.status,
        provider: catalog.provider.id,
        model: catalog.defaultModelId,
      },
      timestamp: new Date().toISOString(),
    });
  };
  app.get('/api/v1/health', health);
  app.get('/api/health', health);

  const models = (req, res) => res.json(getModelCatalog());
  app.get('/api/v1/models', models);
  app.get('/api/models', models);

  const modelProbeLimiter = rateLimit({
    windowMs: 60 * 1000,
    limit: 5,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    keyGenerator: (req) => 'user:' + req.user.id,
    message: { error: 'MODEL_PROBE_RATE_LIMITED', message: '模型检查过于频繁，请稍后再试。' },
  });
  app.post('/api/v1/models/health', requireAuth, modelProbeLimiter, async (req, res, next) => {
    const modelId = typeof req.body?.modelId === 'string' ? req.body.modelId.trim() : '';
    if (!modelId || modelId.length > 300) {
      return res.status(400).json({ error: 'VALIDATION_ERROR', message: '请提供有效的 modelId。' });
    }
    try {
      res.json(await probeModel(modelId));
    } catch (error) {
      next(error);
    }
  });

  // /api/v1 is the canonical contract. /api remains as a compatibility alias.
  for (const prefix of ['/api/v1', '/api']) {
    app.use(prefix + '/auth', authRoutes);
    app.use(prefix + '/projects', projectContextRoutes);
    app.use(prefix + '/projects', projectRoutes);
    app.use(prefix + '/documents', documentRoutes);
    app.use(prefix + '/conversations', conversationRoutes);
    app.use(prefix + '/research', researchRoutes);
    app.use(prefix + '/admin', adminRoutes);
  }

  app.use('/api', (req, res) => res.status(404).json({
    error: 'API_NOT_FOUND',
    message: 'API 路由不存在。',
  }));
  app.use((error, req, res, next) => {
    if (res.headersSent) return next(error);
    if (error?.code && error?.status) return res.status(error.status).json({
      error: error.code,
      message: error.message,
      ...(error.requestId ? { requestId: error.requestId } : {}),
    });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: '请求内容过大。' });
    console.error('[NOVA API]', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器发生错误，请稍后重试。' });
  });
  return app;
}
