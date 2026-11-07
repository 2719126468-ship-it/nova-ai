import { randomUUID } from 'node:crypto';

const MAX_ENTRIES = 200;
const counters = new Map();
const recent = [];

export function newRequestId() {
  return randomUUID();
}

/**
 * Count a failed request by its stable NOVA error code. Only metadata is kept:
 * no prompts, response bodies, API keys or provider base URLs.
 */
export function recordError({ code, status, route, requestId }) {
  const key = String(code || 'INTERNAL_ERROR').slice(0, 80);
  const entry = counters.get(key) || { code: key, count: 0, lastStatus: null, lastAt: null, routes: new Set() };
  entry.count += 1;
  entry.lastStatus = Number.isInteger(status) ? status : entry.lastStatus;
  entry.lastAt = new Date().toISOString();
  if (route) entry.routes.add(String(route).slice(0, 120));
  counters.set(key, entry);

  recent.unshift({
    requestId: requestId || null,
    code: key,
    status: Number.isInteger(status) ? status : null,
    route: route ? String(route).slice(0, 120) : null,
    at: entry.lastAt,
  });
  if (recent.length > MAX_ENTRIES) recent.length = MAX_ENTRIES;
  return entry;
}

export function errorSnapshot(limit = 25) {
  const totals = [...counters.values()]
    .map(({ code, count, lastStatus, lastAt, routes }) => ({
      code, count, lastStatus, lastAt, routes: [...routes].slice(0, 5),
    }))
    .sort((a, b) => b.count - a.count);
  return {
    since: 'process_start',
    totalErrors: totals.reduce((sum, item) => sum + item.count, 0),
    codes: totals,
    recent: recent.slice(0, Math.min(Math.max(limit, 1), MAX_ENTRIES)),
    note: '仅统计错误类别、状态码和路由；不保存提示词、回答正文、API Key 或 Provider 地址。',
  };
}

export function resetMonitoring() {
  counters.clear();
  recent.length = 0;
}
