import { db } from '../db.js';

/**
 * Remove expired session rows. Called on login/registration and periodically by
 * the server process so the sessions table cannot grow without bound.
 */
export function purgeExpiredSessions() {
  const result = db.prepare("DELETE FROM sessions WHERE datetime(expires_at) <= CURRENT_TIMESTAMP").run();
  return result.changes;
}
