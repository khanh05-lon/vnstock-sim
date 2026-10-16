import type { Request } from 'express';
import type { Server } from 'socket.io';
import { z } from 'zod';
import type { Database, Queryable } from '../db';
import { AppError } from '../lib/errors';
import type { Mailer } from '../lib/mailer';
import type { BinanceRest } from '../market/binance/rest';
import type { MarketService } from '../market/marketService';
import type { AlertMonitor } from '../ops/alerts';
import type { SpotEngine } from '../trading/engine';
import type { AdminStore } from './store';

export interface AdminDeps {
  db: Database;
  io: Server;
  market: MarketService;
  engine: SpotEngine;
  store: AdminStore;
  mailer: Mailer;
  /** Client Binance để lấy bộ lọc khi thêm cặp mới (null khi chạy giả lập) */
  rest?: BinanceRest | null;
  /** Giám sát & cảnh báo (không có trong test) */
  alerts?: AlertMonitor;
  /** Dọn dữ liệu của các tính năng khác khi 1 cặp bị gỡ khỏi sàn */
  onDelist?(symbol: string, reason: string): Promise<void>;
  /** Nạp lại trạng thái trong bộ nhớ của các tính năng khác sau khi khôi phục dữ liệu */
  onRestored?(): Promise<void>;
}

export interface AdminCtx {
  id: string;
  email: string;
}
export type AdminRequest = Request & { admin: AdminCtx };

export const forbidden = (msg: string) => new AppError(403, 'FORBIDDEN', msg);
export const uuid = z.string().uuid('Mã người dùng không hợp lệ');
export const reasonSchema = z.string().trim().min(3, 'Lý do tối thiểu 3 ký tự').max(200, 'Lý do tối đa 200 ký tự');
export const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ (YYYY-MM-DD)');
export const symbolParam = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{5,20}$/, 'Cặp giao dịch không hợp lệ');
export const assetParam = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,15}$/, 'Mã tài sản không hợp lệ');

/** Mọi thao tác quản trị đều ghi nhật ký (không sửa / xoá được qua ứng dụng) */
export async function audit(
  q: Queryable,
  admin: AdminCtx,
  action: string,
  targetType: string | null,
  targetId: string | null,
  detail: Record<string, unknown> = {},
) {
  await q.many(
    'INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, detail) VALUES ($1, $2, $3, $4, $5, $6::jsonb)',
    [admin.id, admin.email, action, targetType, targetId, JSON.stringify(detail)],
  );
}
