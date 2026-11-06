import { createHash, randomBytes } from 'node:crypto';

export const hashToken = (token) => createHash('sha256').update(token).digest('hex');
export const createSessionToken = () => randomBytes(32).toString('base64url');
export const isPositiveId = (value) => /^\d+$/.test(String(value)) && Number(value) > 0;
export const publicUser = (user) => ({
  id: user.id,
  email: user.email,
  name: user.name,
  role: user.role,
  createdAt: user.created_at,
});
