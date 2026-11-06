import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const defaultDb = path.resolve(here, '../data/nova.sqlite');

export const config = {
  nodeEnv: process.env.NODE_ENV || 'development',
  port: Number(process.env.PORT || 4000),
  webOrigins: (process.env.WEB_ORIGIN || 'http://localhost:5173').split(',').map((origin) => origin.trim()).filter(Boolean),
  sessionSecret: process.env.SESSION_SECRET || '',
  dbPath: process.env.DB_PATH ? path.resolve(process.cwd(), process.env.DB_PATH) : defaultDb,
  aiBaseUrl: (process.env.AI_BASE_URL || '').replace(/\/+$/, ''),
  aiApiKey: process.env.AI_API_KEY || '',
  aiModel: process.env.AI_MODEL || '',
  aiProvidersJson: process.env.AI_PROVIDERS_JSON || '',
  aiDefaultModelId: process.env.AI_DEFAULT_MODEL || '',
  providerEncryptionKey: process.env.PROVIDER_ENCRYPTION_KEY || '',
  aiTimeoutMs: Number(process.env.AI_TIMEOUT_MS || 60000),
  aiMaxContextChars: Number(process.env.AI_MAX_CONTEXT_CHARS || 40000),
  aiContextOutputReserve: Number(process.env.AI_CONTEXT_OUTPUT_RESERVE || 2048),
  aiContextSafetyMarginPercent: Number(process.env.AI_CONTEXT_SAFETY_MARGIN_PERCENT || 10),
  sessionDays: 7,
  get aiConfiguredLegacy() { return Boolean(this.aiBaseUrl && this.aiApiKey && this.aiModel); },
  get aiConfigured() { return Boolean(this.aiProvidersJson.trim() || this.aiConfiguredLegacy); },
};

export function assertConfig() {
  if (config.sessionSecret.length < 32) {
    throw new Error('SESSION_SECRET must contain at least 32 characters. Copy .env.example and set a strong random value.');
  }
  if (!Number.isInteger(config.port) || config.port < 1 || config.port > 65535) {
    throw new Error('PORT must be a valid TCP port.');
  }
  if (config.providerEncryptionKey && config.providerEncryptionKey.length < 32) {
    throw new Error('PROVIDER_ENCRYPTION_KEY must contain at least 32 characters when configured.');
  }
  if (!Number.isInteger(config.aiContextOutputReserve) || config.aiContextOutputReserve < 128 || config.aiContextOutputReserve > 100000) {
    throw new Error('AI_CONTEXT_OUTPUT_RESERVE must be an integer between 128 and 100000.');
  }
  if (!Number.isInteger(config.aiContextSafetyMarginPercent) || config.aiContextSafetyMarginPercent < 0 || config.aiContextSafetyMarginPercent > 30) {
    throw new Error('AI_CONTEXT_SAFETY_MARGIN_PERCENT must be an integer between 0 and 30.');
  }
  if (!Number.isInteger(config.aiMaxContextChars) || config.aiMaxContextChars < 512 || config.aiMaxContextChars > 200000) {
    throw new Error('AI_MAX_CONTEXT_CHARS must be an integer between 512 and 200000.');
  }
}
