import type { Server } from 'socket.io';
import type { Queryable } from '../db';
import { log } from '../lib/logger';
import type { AdminStore } from './store';

/**
 * Dừng khẩn quá hạn mà chưa có người thứ hai xác nhận → tự mở lại sàn (1 người không giữ sàn dừng mãi được).
 * Gọi định kỳ (installAdmin) và mỗi lần xem trạng thái thị trường ở trang quản trị.
 */
export async function expireEmergencyIfDue(deps: { db: Queryable; store: AdminStore; io: Server }, now = Date.now()): Promise<boolean> {
  const e = deps.store.emergency;
  if (!e || Date.parse(e.expiresAt) > now) return false;
  await deps.store.setHalt(false, '');
  await deps.db.many(
    `INSERT INTO admin_audit_log (admin_id, admin_email, action, target_type, target_id, detail)
     VALUES (NULL, 'Hệ thống', 'TRADING_EMERGENCY_EXPIRED', 'market', NULL, $1::jsonb)`,
    [JSON.stringify({ startedBy: e.by, reason: e.reason, at: e.at, expiresAt: e.expiresAt })],
  );
  deps.io.emit('system', deps.store.status());
  log.warn('[admin] dừng khẩn hết hạn không có người xác nhận — đã tự mở lại sàn', { startedBy: e.by, reason: e.reason });
  return true;
}
