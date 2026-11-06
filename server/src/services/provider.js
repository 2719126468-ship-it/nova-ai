import { config } from '../config.js';
import { resolveModel } from './model-registry.js';

export class ProviderRequestError extends Error {
  constructor(code, status, message, options = {}) {
    super(message);
    this.name = 'ProviderRequestError';
    this.code = code;
    this.status = status;
    this.retryable = Boolean(options.retryable);
    this.providerStatus = Number.isInteger(options.providerStatus) ? options.providerStatus : null;
  }
}

function createProviderHttpError(status) {
  if (status === 401 || status === 403) {
    return new ProviderRequestError('AI_PROVIDER_AUTH_FAILED', 502,
      '模型服务凭据无效或无权访问所选模型，请检查服务器端 Provider 配置。',
      { providerStatus: status });
  }
  if (status === 408 || status === 504) {
    return new ProviderRequestError('AI_TIMEOUT', 504, '模型服务处理请求超时，请稍后重试。',
      { retryable: true, providerStatus: status });
  }
  if (status === 429) {
    return new ProviderRequestError('AI_PROVIDER_RATE_LIMITED', 429, '模型服务当前受到限流，请稍后重试。',
      { retryable: true, providerStatus: status });
  }
  if (status >= 500) {
    return new ProviderRequestError('AI_PROVIDER_UNAVAILABLE', 502, '模型服务暂时不可用，请稍后重试。',
      { retryable: true, providerStatus: status });
  }
  return new ProviderRequestError('AI_PROVIDER_REJECTED', 502,
    '模型服务拒绝了本次请求，请检查模型名称、权限和请求配置。', { providerStatus: status });
}

function createTimeoutError() {
  return new ProviderRequestError('AI_TIMEOUT', 504, '模型请求超过配置的超时时间，请稍后重试。', {
    retryable: true,
  });
}

function createCancelledError() {
  return new ProviderRequestError('AI_REQUEST_CANCELLED', 499, '客户端已取消本次生成。');
}

function createInvalidResponseError() {
  return new ProviderRequestError('AI_INVALID_RESPONSE', 502, '模型服务返回了无法解析的响应。');
}

function createEmptyResponseError() {
  return new ProviderRequestError('AI_EMPTY_RESPONSE', 502, '模型服务未返回可用文本。');
}

function normalizeUsage(usage) {
  if (!usage || typeof usage !== 'object' || Array.isArray(usage)) return null;
  const readCount = (...values) => {
    for (const value of values) {
      if (Number.isSafeInteger(value) && value >= 0) return value;
    }
    return null;
  };
  const normalized = {
    inputTokens: readCount(usage.prompt_tokens, usage.input_tokens),
    outputTokens: readCount(usage.completion_tokens, usage.output_tokens),
    totalTokens: readCount(usage.total_tokens),
  };
  return Object.values(normalized).some((value) => value !== null) ? normalized : null;
}

function reportUsage(onUsage, payload) {
  if (typeof onUsage !== 'function') return;
  const usage = normalizeUsage(payload?.usage);
  if (usage) onUsage(usage);
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch {
    throw createInvalidResponseError();
  }
}

function resolveMaxTokensParameter(model) {
  const configured = model.maxTokensParameter || 'auto';
  if (configured === 'none') return null;
  if (configured === 'max_tokens' || configured === 'max_completion_tokens') return configured;

  const modelId = String(model.upstreamModelId || model.id || '').toLowerCase();
  return /^(gpt-5|o[1-9](?:-|$))/.test(modelId)
    ? 'max_completion_tokens'
    : 'max_tokens';
}

function isReasoningModel(model) {
  const modelId = String(model.upstreamModelId || model.id || '').toLowerCase();
  return /^(gpt-5|o[1-9](?:-|$))/.test(modelId);
}

async function withProviderRequest(messages, stream, externalSignal, consume, options = {}) {
  const model = resolveModel(options.modelId);
  if (!model) throw new ProviderNotConfiguredError();
  if (externalSignal?.aborted) throw createCancelledError();

  const controller = new AbortController();
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, config.aiTimeoutMs);
  const abortExternal = () => controller.abort();

  if (externalSignal) externalSignal.addEventListener('abort', abortExternal, { once: true });

  try {
    const response = await fetch(model.baseUrl + '/chat/completions', {
      method: 'POST',
      headers: {
        Authorization: 'Bearer ' + model.apiKey,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
      },
      body: JSON.stringify((() => {
        const body = {
          model: model.upstreamModelId,
          messages,
          stream,
        };
        if (!isReasoningModel(model)) body.temperature = 0.7;
        const outputLimit = options.maxOutputTokens;
        const limitParameter = resolveMaxTokensParameter(model);
        if (limitParameter && Number.isSafeInteger(outputLimit) && outputLimit > 0) {
          body[limitParameter] = outputLimit;
        }
        return body;
      })()),
      signal: controller.signal,
    });

    if (!response.ok) throw createProviderHttpError(response.status);
    return await consume(response, (payload) => reportUsage(options.onUsage, payload));
  } catch (error) {
    if (error instanceof ProviderRequestError) throw error;
    if (timedOut) throw createTimeoutError();
    if (externalSignal?.aborted) throw createCancelledError();
    if (error?.name === 'AbortError') throw createTimeoutError();
    throw new ProviderRequestError('AI_PROVIDER_UNREACHABLE', 502,
      '无法连接模型服务，请检查服务器网络和 Provider 地址。', { retryable: true });
  } finally {
    clearTimeout(timeout);
    externalSignal?.removeEventListener('abort', abortExternal);
  }
}

export class ProviderNotConfiguredError extends Error {
  constructor() {
    super('NOVA 尚未配置可用模型。请在服务端设置 AI_BASE_URL/AI_API_KEY/AI_MODEL，或配置 AI_PROVIDERS_JSON。');
    this.code = 'AI_PROVIDER_NOT_CONFIGURED';
    this.status = 503;
  }
}

export async function createAssistantReply(messages, options = {}) {
  return withProviderRequest(messages, false, options.signal, async (response, onUsage) => {
    const data = await readJsonResponse(response);
    onUsage(data);
    const content = data?.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw createEmptyResponseError();
    return content.trim();
  }, options);
}

export async function streamAssistantReply(messages, options = {}) {
  const onDelta = typeof options.onDelta === 'function' ? options.onDelta : () => {};
  return withProviderRequest(messages, true, options.signal, async (response, onUsage) => {
    const contentType = response.headers.get('content-type') || '';
    if (!contentType.toLowerCase().includes('text/event-stream')) {
      const data = await readJsonResponse(response);
      onUsage(data);
      const content = data?.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || !content.trim()) throw createEmptyResponseError();
      onDelta(content);
      return content;
    }

    if (!response.body) {
      throw new ProviderRequestError('AI_INVALID_STREAM', 502, '模型服务没有提供可读取的流式响应。');
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
        throw new ProviderRequestError('AI_INVALID_STREAM', 502, '模型服务返回了无法解析的流式数据。');
      }

      onUsage(payload);
      if (payload?.error) {
        throw new ProviderRequestError('AI_PROVIDER_STREAM_ERROR', 502, '模型服务在生成过程中返回错误。');
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

    if (!content.trim()) throw createEmptyResponseError();
    return content;
  }, options);
}
