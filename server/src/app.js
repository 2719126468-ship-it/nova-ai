import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import cookieParser from 'cookie-parser';
import { rateLimit } from 'express-rate-limit';
import { config } from './config.js';
import { requireAppRequest } from './middleware/security.js';
import authRoutes from './routes/auth.js';
import projectRoutes from './routes/projects.js';
import conversationRoutes from './routes/conversations.js';
import researchRoutes from './routes/research.js';
import adminRoutes from './routes/admin.js';

function getModelCatalog() {
  if (!config.aiConfigured) {
    return {
      configured: false,
      defaultModelId: null,
      models: [],
      note: '尚未配置模型服务。模型密钥只从服务端环境变量读取。',
    };
  }

  return {
    configured: true,
    defaultModelId: config.aiModel,
    models: [{
      id: config.aiModel,
      name: config.aiModel,
      provider: 'openai-compatible',
      configured: true,
      enabled: true,
      selectable: true,
      status: 'unknown',
      statusLabel: 'NOT_CHECKED',
      capabilities: ['chat', 'text'],
      contextLimit: null,
    }],
    note: '配置完整不代表上游服务已连通；当前尚未执行主动健康检查。',
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
    allowedHeaders: ['Content-Type', 'X-Requested-With'],
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
    limit: 20,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: 'AUTH_RATE_LIMITED', message: '登录或注册尝试过于频繁，请稍后再试。' },
  });
  app.use('/api', apiLimiter);
  app.use('/api/auth/login', authLimiter);
  app.use('/api/auth/register', authLimiter);
  app.use('/api/v1/auth/login', authLimiter);
  app.use('/api/v1/auth/register', authLimiter);

  const health = (req, res) => res.json({
    status: 'ok',
    service: 'NOVA API',
    version: '0.1.0',
    ai: {
      configured: config.aiConfigured,
      provider: config.aiConfigured ? 'openai-compatible' : null,
      model: config.aiConfigured ? config.aiModel : null,
    },
    timestamp: new Date().toISOString(),
  });
  app.get('/api/v1/health', health);
  app.get('/api/health', health);

  const models = (req, res) => res.json(getModelCatalog());
  app.get('/api/v1/models', models);
  app.get('/api/models', models);

  // /api/v1 is the canonical contract. /api remains as a compatibility alias.
  for (const prefix of ['/api/v1', '/api']) {
    app.use(prefix + '/auth', authRoutes);
    app.use(prefix + '/projects', projectRoutes);
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
    if (error?.code && error?.status) return res.status(error.status).json({ error: error.code, message: error.message });
    if (error?.type === 'entity.too.large') return res.status(413).json({ error: 'PAYLOAD_TOO_LARGE', message: '请求内容过大。' });
    console.error('[NOVA API]', error);
    res.status(500).json({ error: 'INTERNAL_ERROR', message: '服务器发生错误，请稍后重试。' });
  });
  return app;
}
