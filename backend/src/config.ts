import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';

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
if (isProd && !publicUrl) throw new Error('NODE_ENV=production bắt buộc đặt PUBLIC_URL (vd. https://vncoin.example.com)');

/** TRUST_PROXY: số proxy tin cậy đứng trước app (1 khi chạy sau Caddy/Nginx) để lấy đúng IP người dùng */
function trustProxy(): boolean | number | string {
  const raw = process.env.TRUST_PROXY ?? '';
  if (raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true') return true;
  return /^\d+$/.test(raw) ? Number(raw) : raw;
}

/** binance: dữ liệu thật từ Binance (tự chuyển giả lập khi mất kết nối); sim: chỉ giả lập (offline / test) */
const feed = process.env.MARKET_FEED || 'binance';
if (feed !== 'binance' && feed !== 'sim') {
  throw new Error(`MARKET_FEED không hợp lệ: ${feed} (binance | sim)`);
}

const smtpHost = process.env.SMTP_HOST ?? '';
const smtpPort = int('SMTP_PORT', 587);

/** Khoá mã hoá bí mật lưu trong CSDL (khoá 2FA). Đổi khoá → người dùng phải bật lại 2FA */
const dataEncryptionKey = process.env.DATA_ENCRYPTION_KEY ?? '';
if (dataEncryptionKey && dataEncryptionKey.length < 32) throw new Error('DATA_ENCRYPTION_KEY quá ngắn (cần ≥ 32 ký tự, vd. `openssl rand -hex 32`)');
if (isProd && !dataEncryptionKey) log.warn('[config] chưa đặt DATA_ENCRYPTION_KEY — khoá 2FA sẽ được lưu không mã hoá trong CSDL');

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
  /** Thư mục bản sao lưu tự động (vd. trước khi khôi phục dữ liệu) */
  backupDir: path.resolve(process.cwd(), process.env.BACKUP_DIR ?? './data/backups'),
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
  mailFrom: process.env.MAIL_FROM || 'VNCoin <no-reply@localhost>',
  /** Token đọc /api/metrics (Prometheus). Trống: dev mở tự do, production tắt endpoint */
  metricsToken: process.env.METRICS_TOKEN ?? '',
  /** Cảnh báo vận hành: email nhận (phân tách dấu phẩy) và webhook (Slack / Discord / Telegram) */
  alertEmails: (process.env.ALERT_EMAILS ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean),
  alertWebhookUrl: process.env.ALERT_WEBHOOK_URL ?? '',
  alertThresholds: {
    eventLoopMs: int('ALERT_EVENT_LOOP_MS', 500),
    p95Ms: int('ALERT_P95_MS', 2000),
    rssMb: int('ALERT_RSS_MB', 1500),
    dbSlowMs: int('ALERT_DB_SLOW_MS', 1000),
    errorRate: int('ALERT_ERROR_RATE_PCT', 5) / 100,
  },
  /** Bắt buộc xác thực email trước khi được đặt lệnh */
  requireEmailVerification: bool('REQUIRE_EMAIL_VERIFICATION', false),
  /** Nhân viên (quản trị, CSKH) phải bật xác thực 2 lớp mới vào được khu vực nhân viên — mặc định bật ở production */
  requireStaff2fa: bool('REQUIRE_STAFF_2FA', isProd),
  /** Điều chỉnh số dư có giá trị từ mức này (USDT) trở lên phải có quản trị viên thứ hai duyệt */
  adjustApprovalUsdt: Number(process.env.ADJUST_APPROVAL_USDT ?? 1000),
  dataEncryptionKey,
  marketFeed: feed as 'binance' | 'sim',
  binance: {
    /** REST công khai (thử lần lượt, cách nhau dấu phẩy) */
    restUrls: (process.env.BINANCE_REST_URLS || 'https://data-api.binance.vision,https://api.binance.com')
      .split(',')
      .map((s) => s.trim().replace(/\/+$/, ''))
      .filter(Boolean),
    wsUrl: process.env.BINANCE_WS_URL || 'wss://data-stream.binance.vision',
    /** Mất dữ liệu thật quá lâu thì chuyển sang giả lập */
    simAfterMs: int('BINANCE_SIM_AFTER_MS', 5000),
  },
  /** Chu kỳ khớp lệnh và phát dữ liệu cho client */
  flushMs: int('MARKET_FLUSH_MS', 200),
  demoEmail: process.env.DEMO_EMAIL ?? '',
  demoPassword: process.env.DEMO_PASSWORD ?? '',
};

export type AppConfig = typeof config;
