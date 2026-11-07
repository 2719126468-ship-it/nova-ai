import { db } from '../db.js';

const SENSITIVE_KEY = /(api[_-]?key|secret|token|password|authorization|cookie|encrypted|base[_-]?url|prompt|content)/i;
const MAX_STRING = 300;
const MAX_KEYS = 30;
const MAX_DEPTH = 4;

/**
 * Strip anything that must never be persisted in an audit trail: provider keys,
 * encrypted blobs, passwords, session tokens, base URLs and user content.
 */
export function sanitizeAuditMetadata(value, depth = 0) {
  if (value === null || value === undefined) return null;
  if (depth > MAX_DEPTH) return '[truncated]';
  if (Array.isArray(value)) {
    return value.slice(0, 20).map((item) => sanitizeAuditMetadata(item, depth + 1));
  }
  if (typeof value === 'object') {
    const result = {};
    for (const [key, item] of Object.entries(value).slice(0, MAX_KEYS)) {
      if (SENSITIVE_KEY.test(key)) continue;
      result[key] = sanitizeAuditMetadata(item, depth + 1);
    }
    return result;
  }
  if (typeof value === 'string') return value.slice(0, MAX_STRING);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  return null;
}

/**
 * Record a privileged action. Auditing must never break the request path, so a
 * write failure is logged and swallowed.
 */
export function recordAdminAction({ actorUserId = null, action, targetType, targetId = null, metadata = null }) {
  if (!action || !targetType) return null;
  try {
    const payload = metadata ? JSON.stringify(sanitizeAuditMetadata(metadata)) : null;
    const result = db.prepare(`
      INSERT INTO admin_audit_logs(actor_user_id,action,target_type,target_id,metadata_json)
      VALUES(?,?,?,?,?)
    `).run(
      Number.isSafeInteger(actorUserId) ? actorUserId : null,
      String(action).slice(0, 80),
      String(targetType).slice(0, 60),
      targetId === null || targetId === undefined ? null : String(targetId).slice(0, 120),
      payload,
    );
    return Number(result.lastInsertRowid);
  } catch (error) {
    console.error('[NOVA AUDIT] failed to record action', action, error?.code || error?.message);
    return null;
  }
}

export function listAuditLogs(limit = 50) {
  const rows = db.prepare(`
    SELECT a.id, a.actor_user_id AS actorUserId, u.email AS actorEmail, u.name AS actorName,
      a.action, a.target_type AS targetType, a.target_id AS targetId,
      a.metadata_json AS metadataJson, a.created_at AS createdAt
    FROM admin_audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    ORDER BY a.id DESC LIMIT ?
  `).all(limit);
  return rows.map(({ metadataJson, ...row }) => {
    let metadata = null;
    if (metadataJson) {
      try { metadata = JSON.parse(metadataJson); } catch { metadata = null; }
    }
    return { ...row, metadata };
  });
}
