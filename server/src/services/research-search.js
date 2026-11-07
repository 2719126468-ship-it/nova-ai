import { createHash } from 'node:crypto';
import { config } from '../config.js';

const BRAVE_SEARCH_ENDPOINT = 'https://api.search.brave.com/res/v1/web/search';
const MAX_RESPONSE_BYTES = 1_500_000;
const DEFAULT_TIMEOUT_MS = 12000;

export class ResearchSearchError extends Error {
  constructor(code, status, message) {
    super(message);
    this.name = 'ResearchSearchError';
    this.code = code;
    this.status = status;
  }
}

function searchError(code, status, message) {
  return new ResearchSearchError(code, status, message);
}

function resolveProvider() {
  const selected = config.researchSearchProvider
    || (config.researchSearchUrl ? 'searxng' : config.braveSearchApiKey ? 'brave' : '');
  if (!selected) {
    throw searchError(
      'RESEARCH_SEARCH_NOT_CONFIGURED',
      503,
      'NOVA Research 尚未配置真实搜索服务。请联系管理员配置 SearXNG，或在服务器设置 BRAVE_SEARCH_API_KEY。',
    );
  }
  if (selected === 'searxng' && !config.researchSearchUrl) {
    throw searchError('RESEARCH_SEARCH_NOT_CONFIGURED', 503, '服务器尚未设置 RESEARCH_SEARCH_URL。');
  }
  if (selected === 'brave' && !config.braveSearchApiKey) {
    throw searchError('RESEARCH_SEARCH_NOT_CONFIGURED', 503, '服务器尚未设置 BRAVE_SEARCH_API_KEY。');
  }
  if (!['searxng', 'brave'].includes(selected)) {
    throw searchError('RESEARCH_SEARCH_NOT_CONFIGURED', 503, '服务器配置了不支持的 Research 搜索 Provider。');
  }
  return selected;
}

function searxngEndpoint() {
  let base;
  try {
    base = new URL(config.researchSearchUrl);
  } catch {
    throw searchError('RESEARCH_SEARCH_CONFIG_INVALID', 503, 'RESEARCH_SEARCH_URL 不是有效的绝对 URL。');
  }
  if (!base.hostname || base.username || base.password || base.search || base.hash
    || !['https:', 'http:'].includes(base.protocol)
    || (config.nodeEnv === 'production' && base.protocol !== 'https:')) {
    throw searchError('RESEARCH_SEARCH_CONFIG_INVALID', 503, 'SearXNG 地址必须是无账号信息的 HTTPS 基础 URL；仅开发/测试环境允许 HTTP。');
  }
  const path = base.pathname.replace(/\/+$/, '');
  base.pathname = path.endsWith('/search') ? path : path + '/search';
  base.search = '';
  base.hash = '';
  return base;
}

async function readJsonLimited(response) {
  if (!response.body?.getReader) {
    throw searchError('RESEARCH_SEARCH_INVALID_RESPONSE', 502, '搜索服务返回了无法读取的响应。');
  }
  const declaredLength = Number(response.headers.get('content-length'));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_RESPONSE_BYTES) {
    throw searchError('RESEARCH_SEARCH_RESPONSE_TOO_LARGE', 502, '搜索服务响应超过允许的大小。');
  }
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > MAX_RESPONSE_BYTES) {
        await reader.cancel();
        throw searchError('RESEARCH_SEARCH_RESPONSE_TOO_LARGE', 502, '搜索服务响应超过允许的大小。');
      }
      chunks.push(Buffer.from(part.value));
    }
  } finally {
    reader.releaseLock();
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw searchError('RESEARCH_SEARCH_INVALID_RESPONSE', 502, '搜索服务没有返回有效 JSON。');
  }
}

function mapHttpError(status) {
  if (status === 429) {
    return searchError('RESEARCH_SEARCH_UPSTREAM_RATE_LIMITED', 429, '搜索服务当前受到限流，请稍后再试。');
  }
  if (status === 401 || status === 403) {
    return searchError('RESEARCH_SEARCH_UPSTREAM_AUTH_FAILED', 502, '搜索服务认证失败或未开放 JSON API，请联系管理员检查配置。');
  }
  return searchError('RESEARCH_SEARCH_UPSTREAM_UNAVAILABLE', 502, '搜索服务暂时不可用（HTTP ' + status + '）。');
}

async function requestJson(url, options) {
  const configuredTimeout = Number(config.researchSearchTimeoutMs);
  const timeoutMs = Number.isInteger(configuredTimeout) && configuredTimeout >= 1000 && configuredTimeout <= 30000
    ? configuredTimeout
    : DEFAULT_TIMEOUT_MS;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      ...options,
      signal: controller.signal,
      redirect: 'error',
    });
    if (!response.ok) throw mapHttpError(response.status);
    return await readJsonLimited(response);
  } catch (cause) {
    if (cause instanceof ResearchSearchError) throw cause;
    if (controller.signal.aborted || cause?.name === 'AbortError' || cause?.name === 'TimeoutError') {
      throw searchError('RESEARCH_SEARCH_TIMEOUT', 504, '搜索服务响应超时，请稍后重试。');
    }
    throw searchError('RESEARCH_SEARCH_NETWORK_ERROR', 502, '无法连接搜索服务，请检查服务地址或网络。');
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeSources(results, provider) {
  if (!Array.isArray(results)) {
    throw searchError('RESEARCH_SEARCH_INVALID_RESPONSE', 502, '搜索服务没有返回可识别的结果列表。');
  }
  const seen = new Set();
  const sources = [];
  for (const item of results) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
    let parsed;
    try {
      parsed = new URL(typeof item.url === 'string' ? item.url : '');
    } catch {
      continue;
    }
    if (!['https:', 'http:'].includes(parsed.protocol) || !parsed.hostname || parsed.username || parsed.password) continue;
    const url = parsed.toString();
    if (seen.has(url)) continue;
    seen.add(url);
    const title = typeof item.title === 'string' ? item.title.trim().slice(0, 300) : '';
    if (!title) continue;
    const snippet = typeof item.snippet === 'string'
      ? item.snippet.trim().slice(0, 2000)
      : typeof item.content === 'string'
        ? item.content.trim().slice(0, 2000)
        : typeof item.description === 'string'
          ? item.description.trim().slice(0, 2000)
          : '';
    const publishedAt = typeof item.publishedAt === 'string'
      ? item.publishedAt.slice(0, 100)
      : typeof item.publishedDate === 'string'
        ? item.publishedDate.slice(0, 100)
        : typeof item.page_age === 'string'
          ? item.page_age.slice(0, 100)
          : typeof item.page_fetched === 'string'
            ? item.page_fetched.slice(0, 100)
            : null;
    const engines = Array.isArray(item.engines)
      ? [...new Set(item.engines.filter((engine) => typeof engine === 'string').map((engine) => engine.slice(0, 60)))].slice(0, 8)
      : [];
    sources.push({
      id: createHash('sha256').update(url).digest('hex').slice(0, 16),
      title,
      url,
      domain: parsed.hostname,
      snippet,
      publishedAt,
      engines,
      provider,
    });
    if (sources.length >= 10) break;
  }
  return sources;
}

export async function searchWeb(rawQuery, requestedCount = 8) {
  const query = typeof rawQuery === 'string' ? rawQuery.trim() : '';
  if (query.length < 2 || query.length > 300) {
    throw searchError('VALIDATION_ERROR', 400, '搜索关键词必须为 2–300 个字符。');
  }
  const count = Number.isInteger(requestedCount) ? Math.min(Math.max(requestedCount, 1), 10) : 8;
  const provider = resolveProvider();
  let payload;
  let moreResultsAvailable = false;

  if (provider === 'searxng') {
    const url = searxngEndpoint();
    url.searchParams.set('q', query);
    url.searchParams.set('format', 'json');
    url.searchParams.set('safesearch', '2');
    url.searchParams.set('pageno', '1');
    url.searchParams.set('language', 'all');
    payload = await requestJson(url, { method: 'GET', headers: { Accept: 'application/json' } });
    moreResultsAvailable = Boolean(payload?.query?.more_results_available);
    const sources = normalizeSources(payload?.results, provider).slice(0, count);
    return { query, provider, retrievedAt: new Date().toISOString(), sources, moreResultsAvailable };
  }

  const url = new URL(BRAVE_SEARCH_ENDPOINT);
  url.searchParams.set('q', query);
  url.searchParams.set('count', String(count));
  url.searchParams.set('safesearch', 'strict');
  payload = await requestJson(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
      'X-Subscription-Token': config.braveSearchApiKey,
    },
  });
  moreResultsAvailable = Boolean(payload?.query?.more_results_available);
  const results = payload?.web?.results?.map((item) => ({
    title: item?.title,
    url: item?.url,
    description: item?.description,
    page_age: item?.page_age,
    page_fetched: item?.page_fetched,
  }));
  const sources = normalizeSources(results, provider).slice(0, count);
  return { query, provider, retrievedAt: new Date().toISOString(), sources, moreResultsAvailable };
}
