import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import { config } from '../config.js';

function encryptionKey() {
  if (!config.providerEncryptionKey) {
    const error = new Error('管理员 Provider 管理需要在服务器配置 PROVIDER_ENCRYPTION_KEY。');
    error.code = 'PROVIDER_ENCRYPTION_NOT_CONFIGURED';
    error.status = 503;
    throw error;
  }
  return createHash('sha256').update(config.providerEncryptionKey, 'utf8').digest();
}

export function encryptProviderSecret(secret) {
  if (typeof secret !== 'string' || !secret.trim()) {
    const error = new Error('Provider API 密钥不能为空。');
    error.code = 'PROVIDER_SECRET_REQUIRED';
    error.status = 400;
    throw error;
  }

  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', encryptionKey(), iv);
  const encrypted = Buffer.concat([
    cipher.update(secret.trim(), 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();

  return [
    'v1',
    iv.toString('base64url'),
    tag.toString('base64url'),
    encrypted.toString('base64url'),
  ].join('.');
}

export function decryptProviderSecret(payload) {
  try {
    const [version, ivValue, tagValue, encryptedValue, extra] = String(payload || '').split('.');
    if (version !== 'v1' || !ivValue || !tagValue || !encryptedValue || extra !== undefined) {
      throw new Error('Unsupported provider secret format.');
    }

    const decipher = createDecipheriv(
      'aes-256-gcm',
      encryptionKey(),
      Buffer.from(ivValue, 'base64url'),
    );
    decipher.setAuthTag(Buffer.from(tagValue, 'base64url'));
    const decrypted = Buffer.concat([
      decipher.update(Buffer.from(encryptedValue, 'base64url')),
      decipher.final(),
    ]);
    return decrypted.toString('utf8');
  } catch (cause) {
    if (cause?.code === 'PROVIDER_ENCRYPTION_NOT_CONFIGURED') throw cause;
    const error = new Error('无法解密 Provider 凭据；请确认 PROVIDER_ENCRYPTION_KEY 与创建时一致。');
    error.code = 'PROVIDER_SECRET_DECRYPT_FAILED';
    error.status = 500;
    error.cause = cause;
    throw error;
  }
}
