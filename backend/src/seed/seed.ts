import bcrypt from 'bcryptjs';
import { RULES } from '@vss/shared';
import type { Database, Queryable } from '../db';
import { log } from '../lib/logger';

/** Tạo tài khoản mới kèm vốn ảo ban đầu (USDT) */
export async function createUserAccount(tx: Queryable, email: string, passwordHash: string, fullName: string) {
  const user = await tx.one<{ id: string; email: string; full_name: string; created_at: string }>(
    'INSERT INTO users (email, password_hash, full_name) VALUES ($1, $2, $3) RETURNING id, email, full_name, created_at',
    [email, passwordHash, fullName],
  );
  await grantInitialCapital(tx, user!.id, 'Cấp vốn ảo khi mở tài khoản');
  return user!;
}

/** Cấp vốn ảo ban đầu: dùng khi mở tài khoản và khi đặt lại tài khoản (dữ liệu cũ đã được xoá trước đó) */
export async function grantInitialCapital(tx: Queryable, userId: string, note: string) {
  const usdt = RULES.initialUsdt;
  await tx.many(
    `INSERT INTO accounts (user_id, initial_usdt, contributed_usdt) VALUES ($1, $2, $2)
     ON CONFLICT (user_id) DO UPDATE SET initial_usdt = $2, contributed_usdt = $2, updated_at = now()`,
    [userId, usdt],
  );
  await tx.many(
    `INSERT INTO balances (user_id, asset, free) VALUES ($1, $2, $3)
     ON CONFLICT (user_id, asset) DO UPDATE SET free = $3, locked = 0, cost_usdt = 0, updated_at = now()`,
    [userId, RULES.quoteAsset, usdt],
  );
  await tx.many(`INSERT INTO ledger (user_id, asset, type, amount, balance_after, note) VALUES ($1, $2, 'RESET', $3, $3, $4)`, [
    userId,
    RULES.quoteAsset,
    usdt,
    note,
  ]);
}

/** Tài khoản demo dùng chung (chỉ dùng cho dev): 10.000 USDT, email coi như đã xác thực */
export async function seedDemoUser(db: Database, email: string, password: string): Promise<void> {
  if (!email || !password) return;
  const exists = await db.one('SELECT 1 FROM users WHERE email = $1', [email]);
  if (exists) {
    await db.many('UPDATE users SET email_verified_at = COALESCE(email_verified_at, now()) WHERE email = $1', [email]);
    return;
  }
  const hash = await bcrypt.hash(password, 10);
  await db.tx(async (tx) => {
    const user = await createUserAccount(tx, email, hash, 'Nhà đầu tư Demo');
    await tx.many('UPDATE users SET email_verified_at = now() WHERE id = $1', [user.id]);
  });
  log.info(`[seed] đã tạo tài khoản demo ${email}`);
}
