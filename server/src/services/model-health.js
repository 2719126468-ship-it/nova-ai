import { config } from '../config.js';
import { resolveModel } from './model-registry.js';

function result(status, code, message, modelId, durationMs) {
  return {
    modelId,
    status,
    code,
    message,
    checkedAt: new Date().toISOString(),
    durationMs,
  };
}

export async function probeModel(modelId) {
  const model = resolveModel(modelId);
  if (!model) {
    const error = new Error('所选模型未在服务端启用。');
    error.code = 'MODEL_NOT_FOUND';
    error.status = 404;
    throw error;
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeoutMs = Math.min(Math.max(config.aiTimeoutMs, 1000), 8000);
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(model.baseUrl + '/models', {
      method: 'GET',
      headers: {
        Authorization: 'Bearer ' + model.apiKey,
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;

    if (response.status === 401 || response.status === 403) {
      return result('unavailable', 'PROVIDER_AUTH_REJECTED', '上游拒绝了服务器端凭据，请检查 Provider 配置。', model.id, durationMs);
    }
    if (response.status === 429) {
      return result('degraded', 'PROVIDER_RATE_LIMITED', '上游当前受到限流，暂时无法确认模型状态。', model.id, durationMs);
    }
    if (response.status === 404 || response.status === 405) {
      return result('unknown', 'MODEL_LIST_UNSUPPORTED', 'Provider 未提供兼容的模型列表端点；连接状态保持未知。', model.id, durationMs);
    }
    if (response.status >= 500) {
      return result('unavailable', 'PROVIDER_SERVER_ERROR', '上游服务返回服务器错误。', model.id, durationMs);
    }
    if (!response.ok) {
      return result('degraded', 'PROVIDER_PROBE_REJECTED', '上游拒绝了模型目录检查请求。', model.id, durationMs);
    }

    const payload = await response.json().catch(() => null);
    if (!Array.isArray(payload?.data)) {
      return result('unknown', 'MODEL_LIST_UNRECOGNIZED', '上游响应成功，但未返回可识别的模型列表。', model.id, durationMs);
    }

    const modelFound = payload.data.some((entry) => entry && entry.id === model.upstreamModelId);
    if (!modelFound) {
      return result('unknown', 'MODEL_NOT_LISTED', 'Provider 可访问，但没有在模型目录中确认该模型 ID。', model.id, durationMs);
    }
    return result('healthy', 'MODEL_LIST_CONFIRMED', 'Provider 可访问，且模型 ID 已在上游目录中确认。', model.id, durationMs);
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (controller.signal.aborted || error?.name === 'AbortError') {
      return result('unavailable', 'PROVIDER_PROBE_TIMEOUT', '连接检查超时，请稍后重试。', model.id, durationMs);
    }
    return result('unavailable', 'PROVIDER_NETWORK_ERROR', '无法连接到上游 Provider，请检查网络和 API 地址。', model.id, durationMs);
  } finally {
    clearTimeout(timeout);
  }
}
