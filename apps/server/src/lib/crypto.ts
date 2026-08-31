import crypto from 'node:crypto';
import { config } from '../config.js';

const ALGO = 'aes-256-gcm';

function getKey(): Buffer {
  const hex = config.patEncryptionKey;
  if (hex.length >= 64) return Buffer.from(hex.slice(0, 64), 'hex');
  return crypto.createHash('sha256').update(hex || 'dev-key').digest();
}

export function encryptPat(plain: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGO, getKey(), iv);
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64');
}

export function decryptPat(ciphertext: string): string {
  const buf = Buffer.from(ciphertext, 'base64');
  const iv = buf.subarray(0, 12);
  const tag = buf.subarray(12, 28);
  const data = buf.subarray(28);
  const decipher = crypto.createDecipheriv(ALGO, getKey(), iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
}

export function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

export function generateCatToken(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function patHint(pat: string): string {
  return pat.length >= 4 ? `****${pat.slice(-4)}` : '****';
}

export function maskBucId(bucId: string): string {
  if (bucId.length <= 4) return '****';
  return `${bucId.slice(0, 2)}****${bucId.slice(-2)}`;
}
