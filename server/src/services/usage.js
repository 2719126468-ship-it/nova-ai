import { randomUUID } from 'node:crypto';
import { db } from '../db.js';

function normalizeTokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

export function startUsageRecord({ userId, providerId, modelId, operation }) {
  const requestId = randomUUID();
  const startedAt = Date.now();
  db.prepare(
    'INSERT INTO ai_usage (request_id,user_id,provider_id,model_id,operation,status) VALUES (?,?,?,?,?,?)',
  ).run(requestId, userId, providerId, modelId, operation, 'in_progress');
  return { requestId, startedAt };
}

export function finishUsageRecord(record, { status, usage = null, errorCode = null } = {}) {
  if (!record?.requestId) return;
  const inputTokens = normalizeTokenCount(usage?.inputTokens);
  const outputTokens = normalizeTokenCount(usage?.outputTokens);
  const totalTokens = normalizeTokenCount(usage?.totalTokens);
  const hasProviderUsage = inputTokens !== null || outputTokens !== null || totalTokens !== null;
  const durationMs = Math.max(0, Date.now() - record.startedAt);

  try {
    db.prepare(
      'UPDATE ai_usage SET status=?,error_code=?,duration_ms=?,input_tokens=?,output_tokens=?,total_tokens=?,usage_source=?,completed_at=CURRENT_TIMESTAMP WHERE request_id=? AND status=?',
    ).run(
      status,
      errorCode,
      durationMs,
      inputTokens,
      outputTokens,
      totalTokens,
      hasProviderUsage ? 'provider' : null,
      record.requestId,
      'in_progress',
    );
  } catch (error) {
    // Telemetry must not replace a user-facing completion/error with a second failure.
    console.error('[NOVA Usage] Unable to finalize usage record:', error?.code || 'DATABASE_ERROR');
  }
}
