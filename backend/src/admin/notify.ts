import { rolesWith, type Permission } from '@vss/shared';
import type { Queryable } from '../db';
import type { EmailContent } from '../lib/emails';
import type { Mailer } from '../lib/mailer';
import { sendLater } from '../routes/auth';

export interface StaffContact {
  id: string;
  email: string;
  full_name: string;
}

/** Nhân viên đang hoạt động có quyền này (trừ những người trong `except`) */
export async function staffWith(q: Queryable, perm: Permission, except: (string | null | undefined)[] = []): Promise<StaffContact[]> {
  const skip = except.filter((x): x is string => !!x);
  return q.many<StaffContact>(
    `SELECT id, email, full_name FROM users
     WHERE role = ANY($1::text[]) AND status = 'ACTIVE' AND NOT (id = ANY($2::uuid[]))
     ORDER BY email`,
    [rolesWith(perm), skip],
  );
}

/** Gửi email cho mọi nhân viên có quyền `perm` (không chặn luồng chính; lỗi gửi chỉ ghi log) */
export async function notifyStaff(
  q: Queryable,
  mailer: Mailer | undefined,
  perm: Permission,
  except: (string | null | undefined)[],
  make: (name: string) => EmailContent,
  ctx: Record<string, unknown> = {},
): Promise<string[]> {
  if (!mailer) return [];
  const list = await staffWith(q, perm, except);
  for (const s of list) sendLater(mailer, s.email, make(s.full_name), { ...ctx, notify: perm, userId: s.id });
  return list.map((s) => s.email);
}
