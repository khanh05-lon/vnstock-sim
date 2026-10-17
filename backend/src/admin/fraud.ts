import type { Router } from 'express';
import { z } from 'zod';
import { FRAUD_RULES, type FraudAccount, type FraudReport, type UserRole } from '@vss/shared';
import { ah, badRequest, notFound } from '../lib/errors';
import { audit, need, reasonSchema, uuid, type AdminDeps, type AdminRequest } from './common';

interface AccountRow {
  id: string;
  email: string;
  role: UserRole;
  status: string;
  leaderboard_banned_at: Date | null;
  leaderboard_ban_reason: string | null;
}

const toAccount = (u: AccountRow): FraudAccount => ({ id: u.id, email: u.email, role: u.role, status: u.status, leaderboardBanned: !!u.leaderboard_banned_at });
const iso = (d: Date | string) => new Date(d).toISOString();

/**
 * Giám sát gian lận bảng xếp hạng (Rủi ro & giám sát, Kiểm toán xem; Rủi ro / Quản trị hệ thống xử lý):
 *  - nhiều tài khoản đăng nhập cùng 1 IP (nghi 1 người nhiều tài khoản)
 *  - tự đặt lại tài khoản liên tục (làm lại tới khi kết quả đẹp)
 *  - đặt / huỷ lệnh dồn dập
 * Bảng xếp hạng vốn đã loại tài khoản nhân viên; ở đây loại thêm tài khoản gian lận (có lý do, ghi nhật ký).
 */
export function mountFraud(r: Router, deps: AdminDeps) {
  const { db } = deps;

  const accounts = async (ids: string[]) => {
    if (!ids.length) return new Map<string, AccountRow>();
    const rows = await db.many<AccountRow>(
      `SELECT id, email, role, status, leaderboard_banned_at, leaderboard_ban_reason FROM users WHERE id = ANY($1::uuid[])`,
      [ids],
    );
    return new Map(rows.map((u) => [u.id, u]));
  };

  r.get(
    '/fraud',
    need('risk.monitor'),
    ah(async (_req, res) => {
      const R = FRAUD_RULES;
      const sameIp = await db.many<{ ip: string; users: string[]; last: Date }>(
        `SELECT ip, array_agg(DISTINCT user_id::text) AS users, max(created_at) AS last
         FROM auth_events
         WHERE user_id IS NOT NULL AND ip IS NOT NULL AND event IN ('LOGIN_OK', 'REGISTER')
           AND created_at > now() - make_interval(days => $1::int)
         GROUP BY ip HAVING count(DISTINCT user_id) >= $2::int
         ORDER BY count(DISTINCT user_id) DESC, max(created_at) DESC LIMIT 50`,
        [R.windowDays, R.sameIpMin],
      );
      const resets = await db.many<{ user_id: string; n: number; last: Date }>(
        `SELECT user_id::text AS user_id, count(*)::int AS n, max(created_at) AS last FROM auth_events
         WHERE event = 'ACCOUNT_RESET' AND user_id IS NOT NULL AND created_at > now() - make_interval(days => $1::int)
         GROUP BY user_id HAVING count(*) >= $2::int ORDER BY count(*) DESC LIMIT 50`,
        [R.windowDays, R.resetMin],
      );
      const spam = await db.many<{ user_id: string; placed: number; cancelled: number }>(
        `SELECT user_id::text AS user_id,
                count(*) FILTER (WHERE event = 'PLACE')::int AS placed,
                count(*) FILTER (WHERE event = 'CANCEL')::int AS cancelled
         FROM order_events WHERE created_at > now() - make_interval(mins => $1::int)
         GROUP BY user_id
         HAVING count(*) FILTER (WHERE event = 'PLACE') >= $2::int
             OR (count(*) FILTER (WHERE event = 'PLACE') >= $3::int
                 AND count(*) FILTER (WHERE event = 'CANCEL') >= $4::float8 * count(*) FILTER (WHERE event = 'PLACE'))
         ORDER BY count(*) DESC LIMIT 50`,
        [R.spamWindowMin, R.spamPlaceMin, R.spamCancelMinPlaces, R.spamCancelRatio],
      );
      const banned = await db.many<AccountRow>(
        `SELECT id, email, role, status, leaderboard_banned_at, leaderboard_ban_reason FROM users
         WHERE leaderboard_banned_at IS NOT NULL ORDER BY leaderboard_banned_at DESC LIMIT 200`,
      );
      const by = await accounts([...new Set([...sameIp.flatMap((g) => g.users), ...resets.map((x) => x.user_id), ...spam.map((x) => x.user_id)])]);
      const acc = (id: string) => by.get(id);
      const report: FraudReport = {
        generatedAt: new Date().toISOString(),
        sameIp: sameIp.map((g) => ({ ip: g.ip, accounts: g.users.flatMap((id) => (acc(id) ? [toAccount(acc(id)!)] : [])), lastSeen: iso(g.last) })),
        frequentResets: resets.flatMap((x) => (acc(x.user_id) ? [{ account: toAccount(acc(x.user_id)!), resets: x.n, last: iso(x.last) }] : [])),
        orderSpam: spam.flatMap((x) =>
          acc(x.user_id)
            ? [{ account: toAccount(acc(x.user_id)!), placed: x.placed, cancelled: x.cancelled, cancelRatio: x.placed ? Math.round((x.cancelled / x.placed) * 100) / 100 : 0 }]
            : [],
        ),
        banned: banned.map((u) => ({ ...toAccount(u), reason: u.leaderboard_ban_reason, at: u.leaderboard_banned_at ? iso(u.leaderboard_banned_at) : null })),
      };
      res.json(report);
    }),
  );

  /** Loại / đưa lại tài khoản vào bảng xếp hạng (bắt buộc lý do, ghi nhật ký) */
  r.post(
    '/users/:id/leaderboard',
    need('users.lock'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = uuid.parse(req.params.id);
      const { banned, reason } = z.object({ banned: z.boolean(), reason: reasonSchema }).strict().parse(req.body);
      if (id === admin.id) throw badRequest('SELF', 'Không tự xử lý tài khoản của mình');
      const u = await db.one<AccountRow>('SELECT id, email, role, status, leaderboard_banned_at, leaderboard_ban_reason FROM users WHERE id = $1', [id]);
      if (!u) throw notFound('Không tìm thấy người dùng');
      if (!!u.leaderboard_banned_at === banned) throw badRequest('NO_CHANGE', banned ? 'Tài khoản đã bị loại khỏi bảng xếp hạng' : 'Tài khoản đang có trên bảng xếp hạng');
      await db.tx(async (tx) => {
        await tx.many(
          banned
            ? 'UPDATE users SET leaderboard_banned_at = now(), leaderboard_ban_reason = $2 WHERE id = $1'
            : 'UPDATE users SET leaderboard_banned_at = NULL, leaderboard_ban_reason = NULL WHERE id = $1',
          banned ? [id, reason] : [id],
        );
        await audit(tx, admin, banned ? 'LEADERBOARD_BAN' : 'LEADERBOARD_UNBAN', 'user', id, { email: u.email, reason });
      });
      res.json({ ok: true });
    }),
  );
}
