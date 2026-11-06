import { config } from '../config.js';

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super('AI 服务尚未配置。请在服务端环境变量中设置 AI_BASE_URL、AI_API_KEY 和 AI_MODEL。');
    this.code = 'AI_PROVIDER_NOT_CONFIGURED';
    this.status = 503;
  }
}

export async function createAssistantReply(messages) {
  if (!config.aiConfigured) throw new ProviderNotConfiguredError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiTimeoutMs);
  try {
    const response = await fetch(`${config.aiBaseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.aiApiKey}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.aiModel, messages, temperature: 0.7 }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data?.error?.message || `模型服务返回 HTTP ${response.status}`);
      error.code = 'AI_PROVIDER_ERROR';
      error.status = 502;
      throw error;
    }
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const error = new Error('模型服务未返回可用文本。');
      error.code = 'AI_EMPTY_RESPONSE';
      error.status = 502;
      throw error;
    }
    return content.trim();
  } catch (error) {
    if (error.name === 'AbortError') {
      const timeoutError = new Error('模型请求超时，请稍后重试。');
      timeoutError.code = 'AI_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}
