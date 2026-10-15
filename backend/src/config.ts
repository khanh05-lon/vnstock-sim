import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import type { MarketMode } from '@vss/shared';
import { log } from './lib/logger';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Biến môi trường ${name} không hợp lệ: ${raw}`);
  return n;
}

function bool(name: string, fallback: boolean): boolean {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  return raw === '1' || raw.toLowerCase() === 'true';
}

const isProd = process.env.NODE_ENV === 'production';

let jwtSecret = process.env.JWT_SECRET ?? '';
if (!jwtSecret || jwtSecret.startsWith('change-me')) {
  if (isProd) throw new Error('NODE_ENV=production bắt buộc đặt JWT_SECRET (chuỗi ngẫu nhiên ≥ 32 ký tự, vd. `openssl rand -hex 32`)');
  jwtSecret = crypto.randomBytes(32).toString('hex');
  log.warn('[config] JWT_SECRET chưa được đặt — dùng khoá tạm, token sẽ mất hiệu lực khi khởi động lại.');
} else if (isProd && jwtSecret.length < 32) {
  throw new Error('JWT_SECRET quá ngắn cho production (cần ≥ 32 ký tự)');
}

/** Địa chỉ công khai của web, dùng để tạo link trong email (đặt lại mật khẩu) */
const publicUrl = (process.env.PUBLIC_URL ?? '').replace(/\/+$/, '');
if (isProd && !publicUrl) throw new Error('NODE_ENV=production bắt buộc đặt PUBLIC_URL (vd. https://vnstock.example.com)');

/** TRUST_PROXY: số proxy tin cậy đứng trước app (1 khi chạy sau Caddy/Nginx) để lấy đúng IP người dùng */
function trustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY ?? '';
  if (raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

const mode = (process.env.MARKET_MODE ?? 'SIMULATED_24_7') as MarketMode;
if (mode !== 'SIMULATED_24_7' && mode !== 'REAL_HOURS') {
  throw new Error(`MARKET_MODE không hợp lệ: ${mode}`);
}

const provider = process.env.MARKET_PROVIDER || 'mock';
if (provider !== 'mock' && provider !== 'vnstock') {
  throw new Error(`MARKET_PROVIDER không hợp lệ: ${provider} (mock | vnstock)`);
}
if (provider === 'vnstock' && mode !== 'REAL_HOURS') {
  log.warn('[config] MARKET_PROVIDER=vnstock nên đi cùng MARKET_MODE=REAL_HOURS — với SIMULATED_24_7, ngoài giờ giao dịch sẽ chạy giả lập.');
}

const smtpHost = process.env.SMTP_HOST ?? '';
const smtpPort = int('SMTP_PORT', 587);

export const config = {
  isProd,
  port: int('PORT', 4000),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  jwtSecret,
  jwtExpiresIn: '7d',
  /** Có DATABASE_URL → PostgreSQL thật; không có → PGlite nhúng tại DATA_DIR */
  databaseUrl: process.env.DATABASE_URL ?? '',
  dbPoolMax: int('DB_POOL_MAX', 10),
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR ?? './data/pgdata'),
  /** Tự chạy migration khi khởi động (đặt false nếu chạy `npm run migrate` riêng trước khi start) */
  migrateOnStart: bool('MIGRATE_ON_START', true),
  /** Thư mục frontend đã build để API phục vụ luôn (vd. ../frontend/dist); trống = không phục vụ */
  frontendDist: process.env.FRONTEND_DIST ? path.resolve(process.cwd(), process.env.FRONTEND_DIST) : '',
  publicUrl: publicUrl || 'http://localhost:5173',
  trustProxy: trustProxy(),
  rateLimit: {
    /** Số request /api tối đa mỗi phút cho 1 người dùng (hoặc 1 IP khi chưa đăng nhập) */
    apiPerMinute: int('RATE_LIMIT_API_PER_MIN', 600),
    /** Số lần đặt/sửa/huỷ lệnh tối đa mỗi phút cho 1 người dùng */
    ordersPerMinute: int('RATE_LIMIT_ORDERS_PER_MIN', 120),
  },
  /** SMTP gửi email; null → chỉ ghi link ra log */
  smtp: smtpHost
    ? {
        host: smtpHost,
        port: smtpPort,
        /** true = TLS ngay từ đầu (cổng 465); false = STARTTLS */
        secure: bool('SMTP_SECURE', smtpPort === 465),
        user: process.env.SMTP_USER ?? '',
        pass: process.env.SMTP_PASS ?? '',
      }
    : null,
  mailFrom: process.env.MAIL_FROM || 'VNStock Sim <no-reply@localhost>',
  marketMode: mode,
  /** mock: giá giả lập; vnstock: giá thật qua data-service (tự về giả lập khi nguồn lỗi) */
  marketProvider: provider as 'mock' | 'vnstock',
  vnstock: {
    url: process.env.VNSTOCK_URL || 'http://127.0.0.1:8001',
    pollMs: int('VNSTOCK_POLL_MS', 3000),
    staleMs: int('VNSTOCK_STALE_MS', 20_000),
    historyDays: int('VNSTOCK_HISTORY_DAYS', 500),
    maxRequestsPerMinute: int('VNSTOCK_MAX_RPM', 120),
  },
  settlementDays: int('SETTLEMENT_DAYS', 2),
  tickIntervalMs: int('TICK_INTERVAL_MS', 1000),
  demoEmail: process.env.DEMO_EMAIL ?? '',
  demoPassword: process.env.DEMO_PASSWORD ?? '',
};

export type AppConfig = typeof config;
