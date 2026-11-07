import { config } from '../config.js';
import { errorSnapshot } from './monitoring.js';

const MAX_HISTORY = 50;
const history = [];
const lastSentAt = new Map();

function webhookConfigured() {
  return typeof config.alertWebhookUrl === 'string' && /^https?:\/\//.test(config.alertWebhookUrl);
}

/**
 * Build a webhook payload that contains metadata only: error codes, counts,
 * statuses, routes and the process uptime. Prompts, response bodies, provider
 * keys and base URLs never leave the server through this path.
 */
export function buildAlertPayload({ code, entry, windowMs }) {
  return {
    service: 'NOVA API',
    severity: 'error',
    code,
    count: entry?.count ?? 0,
    lastStatus: entry?.lastStatus ?? null,
    lastAt: entry?.lastAt ?? new Date().toISOString(),
    routes: (entry?.routes ? [...entry.routes] : []).slice(0, 5),
    windowSeconds: Math.round(windowMs / 1000),
    uptimeSeconds: Math.round(process.uptime()),
    note: 'Metadata only: no prompts, response text, API keys or provider base URLs.',
  };
}

async function postWebhook(url, payload, timeoutMs = 5000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'NOVA-Alert/1.0' },
      body: JSON.stringify(payload),
      signal: controller.signal,
      redirect: 'error',
    });
    return { ok: response.ok, status: response.status };
  } catch (error) {
    return { ok: false, status: 0, error: error?.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR' };
  } finally {
    clearTimeout(timer);
  }
}

function record(delivery) {
  history.unshift({ ...delivery, at: new Date().toISOString() });
  if (history.length > MAX_HISTORY) history.length = MAX_HISTORY;
}

/**
 * Decide whether a fresh error should page someone. Threshold + cooldown are
 * both required so a single burst cannot flood the webhook, and a code that
 * already alerted stays quiet until the cooldown elapses.
 */
export function shouldAlert(code) {
  const threshold = Number.isInteger(config.alertErrorThreshold) ? config.alertErrorThreshold : 5;
  const cooldownMs = Number.isInteger(config.alertCooldownMs) ? config.alertCooldownMs : 10 * 60 * 1000;
  const snapshot = errorSnapshot(1);
  const entry = snapshot.codes.find((item) => item.code === code);
  if (!entry || entry.count < threshold) return false;
  const last = lastSentAt.get(code) || 0;
  return Date.now() - last >= cooldownMs;
}

/**
 * Fire-and-forget alert. Never awaited by the request path and never throws.
 */
export function maybeAlert(code) {
  if (!webhookConfigured()) return null;
  if (!shouldAlert(code)) return null;
  const snapshot = errorSnapshot(1);
  const entry = snapshot.codes.find((item) => item.code === code);
  if (!entry) return null;
  lastSentAt.set(code, Date.now());
  const payload = buildAlertPayload({ code, entry, windowMs: config.alertCooldownMs });
  postWebhook(config.alertWebhookUrl, payload).then((result) => {
    record({ code, status: result.status, ok: result.ok, error: result.error || null });
    if (!result.ok) console.error('[NOVA ALERT] webhook delivery failed', result.status, result.error || '');
  }).catch(() => {});
  return payload;
}

export async function sendTestAlert() {
  if (!webhookConfigured()) {
    const error = new Error('尚未配置 ALERT_WEBHOOK_URL，无法发送测试告警。');
    error.code = 'ALERT_WEBHOOK_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  const payload = buildAlertPayload({
    code: 'ALERT_TEST',
    entry: { count: 0, lastStatus: null, lastAt: new Date().toISOString(), routes: [] },
    windowMs: config.alertCooldownMs,
  });
  const result = await postWebhook(config.alertWebhookUrl, payload);
  record({ code: 'ALERT_TEST', status: result.status, ok: result.ok, error: result.error || null });
  return { configured: true, delivered: result.ok, status: result.status, error: result.error || null };
}

export function alertState() {
  return {
    configured: webhookConfigured(),
    threshold: config.alertErrorThreshold,
    cooldownSeconds: Math.round(config.alertCooldownMs / 1000),
    recent: history.slice(0, 20),
    note: '告警只发送错误码、次数、状态码、路由与运行时长；不包含提示词、回答正文、密钥或 Provider 地址。',
  };
}

export function resetAlertState() {
  history.length = 0;
  lastSentAt.clear();
}
