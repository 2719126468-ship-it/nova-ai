import { config } from '../config.js';

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super('AI 服务尚未配置。请在服务端环境变量中设置 AI_BASE_URL、AI_API_KEY 和 AI_MODEL。');
    this.code = 'AI_PROVIDER_NOT_CONFIGURED';
    this.status = 503;
  }
}

function providerResponseError(data, status) {
  const error = new Error(data?.error?.message || '模型服务暂时无法完成请求。');
  error.code = 'AI_PROVIDER_ERROR';
  error.status = 502;
  error.providerStatus = status;
  return error;
}

function assistantContent(data) {
  const content = data?.choices?.[0]?.message?.content;
  return typeof content === 'string' ? content.trim() : '';
}

export async function createAssistantReply(messages) {
  if (!config.aiConfigured) throw new ProviderNotConfiguredError();
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), config.aiTimeoutMs);
  try {
    const response = await fetch(config.aiBaseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.aiApiKey,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ model: config.aiModel, messages, temperature: 0.7 }),
      signal: controller.signal,
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw providerResponseError(data, response.status);
    const content = assistantContent(data);
    if (!content) {
      const error = new Error('模型服务未返回可用文本。');
      error.code = 'AI_EMPTY_RESPONSE';
      error.status = 502;
      throw error;
    }
    return content;
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

/** Stream text deltas from an OpenAI-compatible Chat Completions endpoint. */
export async function* createAssistantStream(messages, { signal } = {}) {
  if (!config.aiConfigured) throw new ProviderNotConfiguredError();

  const controller = new AbortController();
  let timedOut = false;
  const abortFromCaller = () => controller.abort(signal?.reason);
  if (signal?.aborted) abortFromCaller();
  else signal?.addEventListener('abort', abortFromCaller, { once: true });

  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.aiTimeoutMs);

  try {
    const response = await fetch(config.aiBaseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.aiApiKey,
        'Content-Type': 'application/json',
        Accept: 'text/event-stream, application/json',
      },
      body: JSON.stringify({ model: config.aiModel, messages, temperature: 0.7, stream: true }),
      signal: controller.signal,
    });

    if (!response.ok) {
      const data = await response.json().catch(() => ({}));
      throw providerResponseError(data, response.status);
    }

    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const data = await response.json().catch(() => ({}));
      const content = assistantContent(data);
      if (!content) {
        const error = new Error('模型服务未返回可用文本。');
        error.code = 'AI_EMPTY_RESPONSE';
        error.status = 502;
        throw error;
      }
      yield content;
      return;
    }

    if (!response.body) {
      const error = new Error('模型服务没有提供可读取的流式响应。');
      error.code = 'AI_STREAM_UNAVAILABLE';
      error.status = 502;
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let finished = false;
    const parseLine = (rawLine) => {
      const line = rawLine.replace(/\r$/, '').trim();
      if (!line.startsWith('data:')) return { content: '' };
      const payload = line.slice(5).trim();
      if (!payload) return { content: '' };
      if (payload === '[DONE]') return { done: true, content: '' };
      let data;
      try {
        data = JSON.parse(payload);
      } catch {
        const error = new Error('模型服务返回了无法解析的流式数据。');
        error.code = 'AI_STREAM_INVALID';
        error.status = 502;
        throw error;
      }
      const content = data?.choices?.[0]?.delta?.content;
      return { content: typeof content === 'string' ? content : '' };
    };

    try {
      while (!finished) {
        const result = await reader.read();
        buffer += decoder.decode(result.value || new Uint8Array(), { stream: !result.done });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const item = parseLine(line);
          if (item.done) {
            finished = true;
            break;
          }
          if (item.content) yield item.content;
        }
        if (result.done) {
          if (buffer) {
            const item = parseLine(buffer);
            if (item.content) yield item.content;
          }
          break;
        }
      }
    } finally {
      reader.releaseLock();
    }
  } catch (error) {
    if (timedOut) {
      const timeoutError = new Error('模型请求超时，请稍后重试。');
      timeoutError.code = 'AI_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    if (signal?.aborted) {
      const abortError = new Error('生成已取消。');
      abortError.name = 'AbortError';
      abortError.code = 'AI_REQUEST_ABORTED';
      abortError.status = 499;
      throw abortError;
    }
    if (error.name === 'AbortError') {
      const timeoutError = new Error('模型请求超时，请稍后重试。');
      timeoutError.code = 'AI_TIMEOUT';
      timeoutError.status = 504;
      throw timeoutError;
    }
    throw error;
  } finally {
    clearTimeout(timeout);
    signal?.removeEventListener('abort', abortFromCaller);
  }
}
