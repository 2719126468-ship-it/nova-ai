import { config } from '../config.js';

export function requireAppRequest(req, res, next) {
  if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !config.webOrigins.includes(origin)) {
    return res.status(403).json({ error: 'INVALID_ORIGIN', message: '请求来源未获授权。' });
  }
  if (req.get('x-requested-with') !== 'NOVA-Web') {
    return res.status(403).json({ error: 'MISSING_REQUEST_HEADER', message: '请求校验失败。' });
  }
  next();
}
