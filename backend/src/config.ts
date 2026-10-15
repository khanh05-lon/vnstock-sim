import 'dotenv/config';
import crypto from 'node:crypto';
import path from 'node:path';
import type { MarketMode } from '@vss/shared';

function int(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n)) throw new Error(`Biến môi trường ${name} không hợp lệ: ${raw}`);
  return n;
}

let jwtSecret = process.env.JWT_SECRET ?? '';
if (!jwtSecret || jwtSecret.startsWith('change-me')) {
  jwtSecret = crypto.randomBytes(32).toString('hex');
  console.warn('[config] JWT_SECRET chưa được đặt — dùng khoá tạm, token sẽ mất hiệu lực khi khởi động lại.');
}

const mode = (process.env.MARKET_MODE ?? 'SIMULATED_24_7') as MarketMode;
if (mode !== 'SIMULATED_24_7' && mode !== 'REAL_HOURS') {
  throw new Error(`MARKET_MODE không hợp lệ: ${mode}`);
}

export const config = {
  port: int('PORT', 4000),
  corsOrigin: (process.env.CORS_ORIGIN ?? 'http://localhost:5173').split(',').map((s) => s.trim()),
  jwtSecret,
  jwtExpiresIn: '7d',
  dataDir: path.resolve(process.cwd(), process.env.DATA_DIR ?? './data/pgdata'),
  marketMode: mode,
  settlementDays: int('SETTLEMENT_DAYS', 2),
  tickIntervalMs: int('TICK_INTERVAL_MS', 1000),
  demoEmail: process.env.DEMO_EMAIL ?? '',
  demoPassword: process.env.DEMO_PASSWORD ?? '',
};

export type AppConfig = typeof config;
