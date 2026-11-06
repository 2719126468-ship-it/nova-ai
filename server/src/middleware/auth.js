import { db } from '../db.js';
import { hashToken, publicUser } from '../utils.js';

export function requireAuth(req, res, next) {
  const token = req.cookies?.nova_session;
  if (!token) return res.status(401).json({ error: 'UNAUTHENTICATED', message: '请先登录。' });
  const session = db.prepare(`
    SELECT s.id AS session_id, s.expires_at, u.*
    FROM sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND datetime(s.expires_at) > CURRENT_TIMESTAMP
  `).get(hashToken(token));
  if (!session) {
    res.clearCookie('nova_session', { path: '/api' });
    return res.status(401).json({ error: 'SESSION_EXPIRED', message: '登录状态已失效，请重新登录。' });
  }
  req.sessionId = session.session_id;
  req.user = publicUser(session);
  next();
}

export function requireAdmin(req, res, next) {
  if (req.user?.role !== 'admin') return res.status(403).json({ error: 'FORBIDDEN', message: '此页面仅对管理员开放。' });
  next();
}
