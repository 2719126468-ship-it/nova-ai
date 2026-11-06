import { Router } from 'express';
import bcrypt from 'bcryptjs';
import { z } from 'zod';
import { db } from '../db.js';
import { config } from '../config.js';
import { requireAuth } from '../middleware/auth.js';
import { createSessionToken, hashToken, publicUser } from '../utils.js';

const router = Router();
const registerSchema = z.object({
  email: z.string().trim().email().max(254),
  password: z.string().min(10).max(72),
  name: z.string().trim().min(1).max(60),
});
const loginSchema = z.object({ email: z.string().trim().email().max(254), password: z.string().min(1).max(72) });
const profileSchema = z.object({ name: z.string().trim().min(1).max(60) });
const passwordSchema = z.object({ currentPassword: z.string().min(1).max(72), newPassword: z.string().min(10).max(72) });

function setSession(res, token) {
  res.cookie('nova_session', token, {
    httpOnly: true,
    secure: config.nodeEnv === 'production',
    sameSite: 'strict',
    path: '/api',
    maxAge: config.sessionDays * 24 * 60 * 60 * 1000,
  });
}
function createSession(userId) {
  const token = createSessionToken();
  const expiresAt = new Date(Date.now() + config.sessionDays * 86400000).toISOString();
  db.prepare('INSERT INTO sessions(user_id,token_hash,expires_at) VALUES(?,?,?)').run(userId, hashToken(token), expiresAt);
  return token;
}

router.post('/register', async (req, res, next) => {
  try {
    const parsed = registerSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '请填写有效邮箱、姓名和至少 10 位密码。', details: parsed.error.flatten() });
    const { email, password, name } = parsed.data;
    const existing = db.prepare('SELECT id FROM users WHERE email=?').get(email.toLowerCase());
    if (existing) return res.status(409).json({ error: 'EMAIL_EXISTS', message: '该邮箱已注册。' });
    const passwordHash = await bcrypt.hash(password, 12);
    const result = db.prepare('INSERT INTO users(email,password_hash,name) VALUES(?,?,?)').run(email.toLowerCase(), passwordHash, name);
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(result.lastInsertRowid);
    setSession(res, createSession(user.id));
    res.status(201).json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

router.post('/login', async (req, res, next) => {
  try {
    const parsed = loginSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '请输入有效邮箱和密码。' });
    const user = db.prepare('SELECT * FROM users WHERE email=?').get(parsed.data.email.toLowerCase());
    if (!user || !(await bcrypt.compare(parsed.data.password, user.password_hash))) {
      return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '邮箱或密码不正确。' });
    }
    setSession(res, createSession(user.id));
    res.json({ user: publicUser(user) });
  } catch (error) { next(error); }
});

router.post('/logout', requireAuth, (req, res) => {
  db.prepare('DELETE FROM sessions WHERE id=?').run(req.sessionId);
  res.clearCookie('nova_session', { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/api' });
  res.json({ success: true });
});

router.get('/me', requireAuth, (req, res) => res.json({ user: req.user }));

router.patch('/me', requireAuth, (req, res) => {
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '姓名长度需要在 1–60 个字符之间。' });
  db.prepare('UPDATE users SET name=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(parsed.data.name, req.user.id);
  const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
  res.json({ user: publicUser(user) });
});

router.patch('/password', requireAuth, async (req, res, next) => {
  try {
    const parsed = passwordSchema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'VALIDATION_ERROR', message: '新密码至少需要 10 位。' });
    const user = db.prepare('SELECT * FROM users WHERE id=?').get(req.user.id);
    if (!(await bcrypt.compare(parsed.data.currentPassword, user.password_hash))) {
      return res.status(400).json({ error: 'PASSWORD_MISMATCH', message: '当前密码不正确。' });
    }
    const hash = await bcrypt.hash(parsed.data.newPassword, 12);
    db.prepare('UPDATE users SET password_hash=?,updated_at=CURRENT_TIMESTAMP WHERE id=?').run(hash, req.user.id);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(req.user.id);
    res.clearCookie('nova_session', { httpOnly: true, secure: config.nodeEnv === 'production', sameSite: 'strict', path: '/api' });
    res.json({ success: true, message: '密码已更新，请重新登录。' });
  } catch (error) { next(error); }
});

export default router;
