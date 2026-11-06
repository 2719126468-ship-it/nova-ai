import { config } from '../config.js';

function createProviderError(status) {
  if (status === 429) {
    const error = new Error('模型服务当前受到限流，请稍后重试。');
    error.code = 'AI_PROVIDER_RATE_LIMITED';
    error.status = 429;
    return error;
  }
  if (status >= 500) {
    const error = new Error('模型服务暂时不可用，请稍后重试。');
    error.code = 'AI_PROVIDER_UNAVAILABLE';
    error.status = 502;
    return error;
  }
  const error = new Error('模型服务拒绝了本次请求，请检查服务端模型配置。');
  error.code = 'AI_PROVIDER_ERROR';
  error.status = 502;
  return error;
}

function createTimeoutError() {
  const error = new Error('模型请求超时，请稍后重试。');
  error.code = 'AI_TIMEOUT';
  error.status = 504;
  return error;
}

function createCancelledError() {
  const error = new Error('客户端已取消本次生成。');
  error.code = 'AI_REQUEST_CANCELLED';
  error.status = 499;
  return error;
}

async function withProviderRequest(messages, stream, externalSignal, consume) {
  if (!config.aiConfigured) throw new ProviderNotConfiguredError();

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.aiTimeoutMs);
  const abortExternal = () => controller.abort();

  if (externalSignal?.aborted) abortExternal();
  else externalSignal?.addEventListener('abort', abortExternal, { once: true });

  try {
    const response = await fetch(config.aiBaseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + config.aiApiKey,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify({ model: config.aiModel, messages, temperature: 0.7, stream }),
      signal: controller.signal,
    });

    if (!response.ok) throw createProviderError(response.status);
    return await consume(response);
  } catch (error) {
    if (timedOut) throw createTimeoutError();
    if (externalSignal?.aborted) throw createCancelledError();
    if (error?.name === 'AbortError') throw createTimeoutError();
    throw error;
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortExternal);
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super('AI 服务尚未配置。请在服务端环境变量中设置 AI_BASE_URL、AI_API_KEY 和 AI_MODEL。');
    this.code = 'AI_PROVIDER_NOT_CONFIGURED';
    this.status = 503;
  }
}

export async function createAssistantReply(messages, options = {}) {
  return withProviderRequest(messages, false, options.signal, async (response) => {
    const data = await response.json().catch(() => ({}));
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) {
      const error = new Error('模型服务未返回可用文本。');
      error.code = 'AI_EMPTY_RESPONSE';
      error.status = 502;
      throw error;
    }
    return content.trim();
  });
}

export async function streamAssistantReply(messages, options = {}) {
  const onDelta = typeof options.onDelta === 'function' ? options.onDelta : () => {};
  return withProviderRequest(messages, true, options.signal, async (response) => {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const data = await response.json().catch(() => ({}));
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) {
        const error = new Error('模型服务未返回可用文本。');
        error.code = 'AI_EMPTY_RESPONSE';
        error.status = 502;
        throw error;
      }
      onDelta(content);
      return content;
    }
    if (!response.body) {
      const error = new Error('模型服务未提供可读取的流式响应。');
      error.code = 'AI_STREAM_UNSUPPORTED';
      error.status = 502;
      throw error;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let content = '';
    let doneSignal = false;

    const consumeBlock = (block) => {
      const data = block.split(/\r?\n/)
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart())
        .join('\n');
      if (!data) return false;
      if (data === '[DONE]') return true;

      let payload;
      try {
        payload = JSON.parse(data);
      } catch {
        const error = new Error('模型服务返回了无法解析的流式数据。');
        error.code = 'AI_INVALID_STREAM';
        error.status = 502;
        throw error;
      }

      if (payload?.error) {
        const error = new Error('模型服务在生成过程中返回错误。');
        error.code = 'AI_PROVIDER_STREAM_ERROR';
        error.status = 502;
        throw error;
      }

      const rawDelta = payload?.choices?.[0]?.delta?.content;
      const delta = Array.isArray(rawDelta)
        ? rawDelta.map((part) => typeof part?.text === 'string' ? part.text : '').join('')
        : rawDelta;
      if (typeof delta === 'string' && delta.length) {
        content += delta;
        onDelta(delta);
      }
      return false;
    };

    try {
      while (!doneSignal) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let boundary;
        while ((boundary = /\r?\n\r?\n/.exec(buffer))) {
          const block = buffer.slice(0, boundary.index);
          buffer = buffer.slice(boundary.index + boundary[0].length);
          if (consumeBlock(block)) {
            doneSignal = true;
            await reader.cancel().catch(() => {});
            break;
          }
        }
      }

      buffer += decoder.decode();
      if (!doneSignal && buffer.trim()) consumeBlock(buffer);
    } finally {
      reader.releaseLock();
    }

    if (!content.trim()) {
      const error = new Error('模型服务未返回可用文本。');
      error.code = 'AI_EMPTY_RESPONSE';
      error.status = 502;
      throw error;
    }
    return content;
  });
}
