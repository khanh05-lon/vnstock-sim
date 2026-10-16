import crypto from 'node:crypto';

/**
 * TOTP (RFC 6238) — mã 6 số đổi mỗi 30 giây, tương thích Google Authenticator / Microsoft Authenticator.
 * Tự cài đặt bằng node:crypto (HMAC-SHA1) để không thêm thư viện.
 */

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
export const TOTP_PERIOD_SEC = 30;
export const TOTP_DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let out = '';
  let bits = 0;
  let value = 0;
  for (const byte of buf) {
    value = ((value << 8) | byte) & 0xffff;
    bits += 8;
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/[\s=-]/g, '').toUpperCase();
  const out: number[] = [];
  let bits = 0;
  let value = 0;
  for (const ch of clean) {
    const idx = B32.indexOf(ch);
    if (idx < 0) throw new Error('Chuỗi base32 không hợp lệ');
    value = ((value << 5) | idx) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** HOTP (RFC 4226) */
export function hotp(secret: Buffer, counter: number, digits = TOTP_DIGITS): string {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(counter));
  const h = crypto.createHmac('sha1', secret).update(msg).digest();
  const off = h[h.length - 1] & 0xf;
  const code = ((h[off] & 0x7f) << 24) | (h[off + 1] << 16) | (h[off + 2] << 8) | h[off + 3];
  return String(code % 10 ** digits).padStart(digits, '0');
}

export const totpStep = (ms = Date.now()) => Math.floor(ms / 1000 / TOTP_PERIOD_SEC);

export function totpCode(secretB32: string, ms = Date.now()): string {
  return hotp(base32Decode(secretB32), totpStep(ms));
}

/**
 * Kiểm tra mã TOTP, chấp nhận lệch ±window bước (đồng hồ điện thoại lệch vài chục giây).
 * Trả về bước thời gian của mã khớp (để chống dùng lại) hoặc null.
 */
export function verifyTotp(secretB32: string, code: string, ms = Date.now(), window = 1): number | null {
  const clean = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(clean)) return null;
  const secret = base32Decode(secretB32);
  const now = totpStep(ms);
  let matched: number | null = null;
  // So hết các bước (không thoát sớm) để thời gian phản hồi không lộ thông tin
  for (let w = -window; w <= window; w++) {
    const expect = hotp(secret, now + w);
    if (crypto.timingSafeEqual(Buffer.from(expect), Buffer.from(clean)) && matched == null) matched = now + w;
  }
  return matched;
}

/** Bí mật 160 bit (độ dài khuyến nghị của RFC 4226) */
export const generateTotpSecret = () => base32Encode(crypto.randomBytes(20));

export function otpauthUrl(secretB32: string, account: string, issuer = 'VNStock Sim'): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const q = new URLSearchParams({ secret: secretB32, issuer, algorithm: 'SHA1', digits: String(TOTP_DIGITS), period: String(TOTP_PERIOD_SEC) });
  return `otpauth://totp/${label}?${q.toString()}`;
}

/* ------------------------------ mã khôi phục ------------------------------ */

const RC_ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'; // bỏ ký tự dễ nhầm (i, l, o, 0, 1)

/** 10 mã dạng xxxx-xxxx, mỗi mã dùng 1 lần */
export function generateRecoveryCodes(n = 10): string[] {
  return Array.from({ length: n }, () => {
    const bytes = crypto.randomBytes(8);
    const s = [...bytes].map((b) => RC_ALPHABET[b % RC_ALPHABET.length]).join('');
    return `${s.slice(0, 4)}-${s.slice(4)}`;
  });
}

export const normalizeRecoveryCode = (code: string) => code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');

export const hashRecoveryCode = (code: string) => crypto.createHash('sha256').update(normalizeRecoveryCode(code)).digest('hex');

export const looksLikeRecoveryCode = (code: string) => normalizeRecoveryCode(code).length === 8 && !/^\d+$/.test(normalizeRecoveryCode(code));
