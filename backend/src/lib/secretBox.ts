import crypto from 'node:crypto';
import { config } from '../config';

/**
 * Mã hoá bí mật lưu trong CSDL (vd. khoá TOTP) bằng AES-256-GCM với khoá DATA_ENCRYPTION_KEY.
 * Chưa đặt khoá → lưu dạng `plain:` (dev); production sẽ cảnh báo lúc khởi động.
 * Đổi / mất khoá → các bí mật cũ không giải mã được (người dùng phải bật lại 2FA).
 */
const key = config.dataEncryptionKey ? crypto.createHash('sha256').update(config.dataEncryptionKey).digest() : null;

export const encryptionEnabled = () => key != null;

export function sealSecret(plain: string): string {
  if (!key) return `plain:${plain}`;
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const ct = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()]);
  return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), ct.toString('base64url')].join(':');
}

export function openSecret(stored: string): string {
  if (stored.startsWith('plain:')) return stored.slice(6);
  const [ver, iv, tag, ct] = stored.split(':');
  if (ver !== 'v1' || !iv || !tag || !ct) throw new Error('Định dạng bí mật không hợp lệ');
  if (!key) throw new Error('Thiếu DATA_ENCRYPTION_KEY để giải mã bí mật đã lưu');
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
  decipher.setAuthTag(Buffer.from(tag, 'base64url'));
  return Buffer.concat([decipher.update(Buffer.from(ct, 'base64url')), decipher.final()]).toString('utf8');
}

/**
 * Mã băm HMAC của định danh nhạy cảm (số giấy tờ KYC) để dò trùng mà không lưu bản rõ.
 * Khoá: DATA_ENCRYPTION_KEY; dev chưa đặt khoá thì dùng khoá cố định (chỉ để dò trùng trong máy dev).
 */
export function hashIdentifier(value: string): string {
  const k = config.dataEncryptionKey || 'vncoin-dev-identifier-key';
  return crypto.createHmac('sha256', k).update(value.trim().toUpperCase()).digest('hex');
}
