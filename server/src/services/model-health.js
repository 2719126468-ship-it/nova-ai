import { config } from '../config.js';
import { db } from '../db.js';
import { getPrivateProvider, resolveModel } from './model-registry.js';

function result(status, code, message, modelId, durationMs, contextWindow = null) {
  return {
    modelId,
    status,
    code,
    message,
    checkedAt: new Date().toISOString(),
    durationMs,
    contextWindow,
  };
}

function readProviderContextWindow(entry) {
  const fields = [
    'context_length',
    'context_window',
    'max_context_length',
    'max_model_len',
    'contextLength',
    'contextWindow',
    'maxContextLength',
    'maxModelLen',
  ];
  for (const field of fields) {
    const raw = entry?.[field];
    const value = typeof raw === 'number' ? raw
      : (typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw) : null);
    if (Number.isSafeInteger(value) && value > 0 && value <= 10000000) return value;
  }
  return null;
}

function storeSnapshot(providerId, upstreamModelId, probe) {
  try {
    if (probe.code === 'MODEL_NOT_FOUND' || probe.code === 'MODEL_LIST_UNSUPPORTED') {
      db.prepare('DELETE FROM model_health_snapshots WHERE provider_id=? AND upstream_model_id=?')
        .run(providerId, upstreamModelId);
      return;
    }
    db.prepare(`
      INSERT INTO model_health_snapshots(provider_id,upstream_model_id,status,code,duration_ms,checked_at)
      VALUES(?,?,?,?,?,?)
      ON CONFLICT(provider_id,upstream_model_id) DO UPDATE SET
        status=excluded.status,
        code=excluded.code,
        duration_ms=excluded.duration_ms,
        checked_at=excluded.checked_at
    `).run(
      providerId,
      upstreamModelId,
      probe.status,
      probe.code || null,
      Number.isInteger(probe.durationMs) ? probe.durationMs : null,
      probe.checkedAt || new Date().toISOString(),
    );
  } catch (error) {
    console.error('[NOVA HEALTH] failed to store snapshot', error?.code || error?.message);
  }
}

/**
 * Read-only model discovery for one provider. Uses the same credentials and
 * timeout policy as the health probe; it never generates a completion and never
 * returns the provider key to the caller's API response.
 */
export async function discoverProviderModels(providerId) {
  const provider = getPrivateProvider(providerId);
  if (!provider) {
    const error = new Error('Provider 不存在或不可管理。');
    error.code = 'PROVIDER_NOT_FOUND';
    error.status = 404;
    throw error;
  }
  if (!provider.configured) {
    const error = new Error('该 Provider 尚未配置完整的基础地址或密钥。');
    error.code = 'PROVIDER_NOT_CONFIGURED';
    error.status = 409;
    throw error;
  }

  const controller = new AbortController();
  const startedAt = Date.now();
  const timeout = setTimeout(() => controller.abort(), Math.min(Math.max(config.aiTimeoutMs, 1000), 8000));
  try {
    const response = await fetch(provider.baseUrl + '/models', {
      method: 'GET',
      headers: { Authorization: 'Bearer ' + provider.apiKey, Accept: 'application/json' },
      signal: controller.signal,
    });
    const durationMs = Date.now() - startedAt;
    if (response.status === 401 || response.status === 403) {
      return { providerId, status: 'unavailable', code: 'PROVIDER_AUTH_REJECTED', message: '上游拒绝了服务器端凭据。', durationMs, models: [] };
    }
    if (response.status === 404 || response.status === 405) {
      return { providerId, status: 'unknown', code: 'MODEL_LIST_UNSUPPORTED', message: 'Provider 未提供兼容的模型列表端点。', durationMs, models: [] };
    }
    if (!response.ok) {
      return { providerId, status: 'unavailable', code: 'PROVIDER_DISCOVERY_FAILED', message: '上游拒绝了模型发现请求（HTTP ' + response.status + '）。', durationMs, models: [] };
    }
    const payload = await response.json().catch(() => null);
    if (!Array.isArray(payload?.data)) {
      return { providerId, status: 'unknown', code: 'MODEL_LIST_UNRECOGNIZED', message: '上游未返回可识别的模型列表。', durationMs, models: [] };
    }
    const configured = new Set(provider.models.map((model) => model.upstreamModelId));
    const models = payload.data
      .filter((entry) => entry && typeof entry.id === 'string' && entry.id.trim() && entry.id.length <= 200)
      .map((entry) => ({
        id: entry.id.trim(),
        contextLimit: readProviderContextWindow(entry),
        alreadyConfigured: configured.has(entry.id.trim()),
      }))
      .slice(0, 500);
    return { providerId, status: 'healthy', code: 'MODEL_LIST_CONFIRMED', message: '已读取上游模型目录。', durationMs, models };
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    const timedOut = controller.signal.aborted || error?.name === 'AbortError';
    return {
      providerId,
      status: 'unavailable',
      code: timedOut ? 'PROVIDER_PROBE_TIMEOUT' : 'PROVIDER_NETWORK_ERROR',
      message: timedOut ? '模型发现请求超时。' : '无法连接到上游 Provider。',
      durationMs,
      models: [],
    };
  } finally {
    clearTimeout(timeout);
  }
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
  const finish = (probe) => {
    storeSnapshot(model.providerId, model.upstreamModelId, probe);
    return probe;
  };
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
      return finish(result('unavailable', 'PROVIDER_AUTH_REJECTED', '上游拒绝了服务器端凭据，请检查 Provider 配置。', model.id, durationMs));
    }
    if (response.status === 429) {
      return finish(result('degraded', 'PROVIDER_RATE_LIMITED', '上游当前受到限流，暂时无法确认模型状态。', model.id, durationMs));
    }
    if (response.status === 404 || response.status === 405) {
      return finish(result('unknown', 'MODEL_LIST_UNSUPPORTED', 'Provider 未提供兼容的模型列表端点；连接状态保持未知。', model.id, durationMs));
    }
    if (response.status >= 500) {
      return finish(result('unavailable', 'PROVIDER_SERVER_ERROR', '上游服务返回服务器错误。', model.id, durationMs));
    }
    if (!response.ok) {
      return finish(result('degraded', 'PROVIDER_PROBE_REJECTED', '上游拒绝了模型目录检查请求。', model.id, durationMs));
    }

    const payload = await response.json().catch(() => null);
    if (!Array.isArray(payload?.data)) {
      return finish(result('unknown', 'MODEL_LIST_UNRECOGNIZED', '上游响应成功，但未返回可识别的模型列表。', model.id, durationMs));
    }

    const matchedModel = payload.data.find((entry) => entry && entry.id === model.upstreamModelId);
    if (!matchedModel) {
      db.prepare('DELETE FROM model_context_windows WHERE provider_id=? AND upstream_model_id=?')
        .run(model.providerId, model.upstreamModelId);
      return finish(result('unknown', 'MODEL_NOT_LISTED', 'Provider 可访问，但没有在模型目录中确认该模型 ID。', model.id, durationMs));
    }
    const reportedContextTokens = readProviderContextWindow(matchedModel);
    let contextWindow = null;
    if (reportedContextTokens) {
      const checkedAt = new Date().toISOString();
      db.prepare(`
        INSERT INTO model_context_windows(provider_id,upstream_model_id,context_tokens,source,checked_at)
        VALUES(?,?,?,'provider_reported',?)
        ON CONFLICT(provider_id,upstream_model_id) DO UPDATE SET
          context_tokens=excluded.context_tokens,
          source=excluded.source,
          checked_at=excluded.checked_at
      `).run(model.providerId, model.upstreamModelId, reportedContextTokens, checkedAt);
      contextWindow = {
        tokens: reportedContextTokens,
        source: 'provider_reported',
        checkedAt,
      };
    } else {
      db.prepare('DELETE FROM model_context_windows WHERE provider_id=? AND upstream_model_id=?')
        .run(model.providerId, model.upstreamModelId);
    }
    return finish(result('healthy', 'MODEL_LIST_CONFIRMED', 'Provider 可访问，且模型 ID 已在上游目录中确认。', model.id, durationMs, contextWindow));
  } catch (error) {
    const durationMs = Date.now() - startedAt;
    if (controller.signal.aborted || error?.name === 'AbortError') {
      return finish(result('unavailable', 'PROVIDER_PROBE_TIMEOUT', '连接检查超时，请稍后重试。', model.id, durationMs));
    }
    return finish(result('unavailable', 'PROVIDER_NETWORK_ERROR', '无法连接到上游 Provider，请检查网络和 API 地址。', model.id, durationMs));
  } finally {
    clearTimeout(timeout);
  }
}