import { config } from '../config.js';

const PROVIDER_ID_PATTERN = /^[a-zA-Z0-9_-]{1,64}$/;

function parseProviderConfig(raw) {
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function normalizeProvider(provider) {
  if (!provider || typeof provider !== 'object' || Array.isArray(provider)) return null;
  if (typeof provider.id !== 'string' || !PROVIDER_ID_PATTERN.test(provider.id)) return null;

  const id = provider.id;
  const name = typeof provider.name === 'string' && provider.name.trim() ? provider.name.trim().slice(0, 120) : id;
  const baseUrl = typeof provider.baseUrl === 'string' ? provider.baseUrl.trim().replace(/\/+$/, '') : '';
  const apiKey = typeof provider.apiKey === 'string' ? provider.apiKey.trim() : '';
  let validBaseUrl = false;

  try {
    const url = new URL(baseUrl);
    validBaseUrl = Boolean(url.hostname)
      && !url.username
      && !url.password
      && (url.protocol === 'https:' || (config.nodeEnv !== 'production' && url.protocol === 'http:'));
  } catch {
    validBaseUrl = false;
  }

  const rawModels = Array.isArray(provider.models) ? provider.models : [];
  const seenModelIds = new Set();
  const models = [];

  for (const model of rawModels) {
    if (!model || typeof model !== 'object' || Array.isArray(model)) continue;
    if (typeof model.id !== 'string' || !model.id.trim() || model.id.length > 200) continue;
    const upstreamModelId = model.id.trim();
    if (seenModelIds.has(upstreamModelId)) continue;
    seenModelIds.add(upstreamModelId);

    models.push({
      upstreamModelId,
      id: id + ':' + upstreamModelId,
      name: typeof model.name === 'string' && model.name.trim() ? model.name.trim().slice(0, 120) : upstreamModelId,
      enabled: provider.enabled !== false && model.enabled !== false,
      capabilities: Array.isArray(model.capabilities)
        ? [...new Set(model.capabilities.filter((item) => typeof item === 'string' && item.length <= 40))].slice(0, 20)
        : ['chat', 'text'],
      contextLimit: Number.isSafeInteger(model.contextLimit) && model.contextLimit > 0 ? model.contextLimit : null,
    });
  }

  return {
    id,
    name,
    baseUrl,
    apiKey,
    configured: Boolean(validBaseUrl && apiKey),
    models,
  };
}

function loadPrivateProviders() {
  if (config.aiProvidersJson.trim()) {
    const parsed = parseProviderConfig(config.aiProvidersJson);
    if (!parsed) return { providers: [], configurationError: 'AI_PROVIDERS_JSON_INVALID' };

    const providers = [];
    const seenProviderIds = new Set();
    for (const entry of parsed) {
      const provider = normalizeProvider(entry);
      if (!provider || seenProviderIds.has(provider.id)) continue;
      seenProviderIds.add(provider.id);
      providers.push(provider);
    }
    return { providers, configurationError: null };
  }

  if (config.aiConfiguredLegacy) {
    return {
      providers: [{
        id: 'openai-compatible',
        name: 'OpenAI-compatible provider',
        baseUrl: config.aiBaseUrl,
        apiKey: config.aiApiKey,
        configured: true,
        models: [{
          id: config.aiModel,
          upstreamModelId: config.aiModel,
          name: config.aiModel,
          enabled: true,
          capabilities: ['chat', 'text'],
          contextLimit: null,
        }],
      }],
      configurationError: null,
    };
  }

  return { providers: [], configurationError: null };
}

function buildCatalog(privateProviders, configurationError) {
  const models = privateProviders.flatMap((provider) => provider.models.map((model) => ({
    id: model.id,
    name: model.name,
    provider: provider.id,
    providerName: provider.name,
    configured: provider.configured,
    enabled: model.enabled,
    selectable: provider.configured && model.enabled,
    status: 'unknown',
    statusLabel: provider.configured ? 'NOT_CHECKED' : 'NOT_CONFIGURED',
    capabilities: model.capabilities,
    contextLimit: model.contextLimit,
  })));

  const requestedDefault = config.aiDefaultModelId || config.aiModel;
  const defaultModel = models.find((model) => model.id === requestedDefault && model.selectable)
    || models.find((model) => model.selectable);

  // This is the only provider representation allowed to leave the server.
  const providers = privateProviders.map((provider) => ({
    id: provider.id,
    name: provider.name,
    configured: provider.configured,
    health: 'unknown',
    status: provider.configured ? 'configured_unverified' : 'not_configured',
    modelCount: provider.models.length,
  }));

  return {
    configured: models.some((model) => model.selectable),
    configurationError,
    defaultModelId: defaultModel?.id || null,
    providers,
    models,
  };
}

export function getModelRegistry() {
  const { providers, configurationError } = loadPrivateProviders();
  return buildCatalog(providers, configurationError);
}

export function resolveModel(modelId) {
  const { providers } = loadPrivateProviders();
  const catalog = buildCatalog(providers, null);
  const selected = modelId
    ? catalog.models.find((model) => model.id === modelId && model.selectable)
    : catalog.models.find((model) => model.id === catalog.defaultModelId && model.selectable);
  if (!selected) return null;

  const provider = providers.find((item) => item.id === selected.provider);
  const model = provider?.models.find((item) => item.id === selected.id);
  if (!provider?.configured || !model || !model.enabled) return null;

  return {
    id: selected.id,
    providerId: provider.id,
    baseUrl: provider.baseUrl,
    apiKey: provider.apiKey,
    upstreamModelId: model.upstreamModelId,
    name: model.name,
  };
}
