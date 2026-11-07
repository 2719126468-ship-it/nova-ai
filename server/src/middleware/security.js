import { config } from '../config.js';

const MUTATING = ['POST', 'PUT', 'PATCH', 'DELETE'];

/**
 * CSRF / origin gate.
 *
 * - Any supplied Origin must be allowlisted.
 * - The custom request header stays as a defence-in-depth marker for browsers.
 * - In production the Origin header is mandatory for state-changing requests,
 *   so a cross-site form POST without Origin cannot slip through (SEC-08).
 */
export function requireAppRequest(req, res, next) {
  if (!MUTATING.includes(req.method)) return next();
  const origin = req.get('origin');
  if (origin && !config.webOrigins.includes(origin)) {
    return res.status(403).json({ error: 'INVALID_ORIGIN', message: '请求来源未获授权。' });
  }
  if (!origin && config.nodeEnv === 'production') {
    return res.status(403).json({ error: 'MISSING_ORIGIN', message: '生产环境要求请求携带受信任的 Origin。' });
  }
  if (req.get('x-requested-with') !== 'NOVA-Web') {
    return res.status(403).json({ error: 'MISSING_REQUEST_HEADER', message: '请求校验失败。' });
  }
  next();
}

/**
 * Content-Security-Policy for the JSON API surface. The web client is served by
 * its own static host; that host must send the matching document policy listed
 * in docs/DEPLOYMENT.md.
 */
export const apiCspDirectives = {
  defaultSrc: ["'none'"],
  baseUri: ["'none'"],
  frameAncestors: ["'none'"],
  formAction: ["'none'"],
  objectSrc: ["'none'"],
  connectSrc: ["'self'"],
  imgSrc: ["'self'"],
  styleSrc: ["'self'"],
  scriptSrc: ["'self'"],
};

/** Document policy the static client host must serve alongside index.html. */
export const webDocumentCsp = [
  "default-src 'self'",
  "base-uri 'self'",
  "frame-ancestors 'none'",
  "object-src 'none'",
  "form-action 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self' https://fonts.gstatic.com data:",
  "style-src 'self' 'unsafe-inline' https://fonts.googleapis.com",
  "script-src 'self'",
  "connect-src 'self' " + config.webOrigins.join(' '),
].join('; ');
