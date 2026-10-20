import type { Router } from 'express';
import { z } from 'zod';
import {
  DEFAULT_SQUARE_RULES,
  SQUARE_RULES,
  moderateText,
  squareAppealDecisionSchema,
  squareBanSchema,
  squareHandleResetSchema,
  squareModNoteSchema,
  squareRemoveSchema,
  squareRulesPatchSchema,
} from '@vss/shared';
import { ah, badRequest } from '../lib/errors';
import { moderationExtra } from '../square/service';
import type { Approvals } from './approvals';
import { audit, need, uuid, type AdminDeps, type AdminRequest } from './common';

/**
 * Kiểm duyệt Cộng đồng (vai trò Kiểm duyệt nội dung — quyền square.moderate).
 * Kiểm duyệt viên chỉ thấy hồ sơ cộng đồng công khai (handle, nội dung, vi phạm), KHÔNG thấy email / số dư.
 * Cấm tay tối đa SQUARE_RULES.maxManualBanDays; cấm vĩnh viễn (SQUARE_BAN) và gỡ cấm dài (SQUARE_UNBAN) cần người thứ hai.
 */
export function mountSquareAdmin(r: Router, deps: AdminDeps, approvals: Approvals) {
  const { db, store } = deps;
  const square = deps.square;
  if (!square) return;

  const kindOf = (raw: string | undefined) => {
    if (raw === 'posts') return 'POST' as const;
    if (raw === 'comments') return 'COMMENT' as const;
    throw badRequest('TYPE', 'Loại nội dung không hợp lệ');
  };
  const idOf = (raw: string | undefined) => {
    const id = Number(raw);
    if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã không hợp lệ');
    return id;
  };
  const handleOf = async (userId: string) => (await db.one<{ handle: string }>('SELECT handle FROM square_profiles WHERE user_id = $1', [userId]))?.handle ?? userId;

  r.get('/square/stats', need('square.moderate'), ah(async (_req, res) => res.json(await square.stats())));

  r.get(
    '/square/queue',
    need('square.moderate'),
    ah(async (req, res) => {
      const { view } = z.object({ view: z.enum(['pending', 'reports', 'appeals']).default('pending') }).parse(req.query);
      res.json(await square.queue(view));
    }),
  );

  r.post(
    '/square/:type/:id/approve',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const type = kindOf(req.params.type);
      const id = idOf(req.params.id);
      const out = await square.approve(admin, type, id);
      await audit(db, admin, 'SQUARE_APPROVE', 'square', `${type}:${id}`, { handle: await handleOf(out.userId) });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/square/:type/:id/remove',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const type = kindOf(req.params.type);
      const id = idOf(req.params.id);
      const input = squareRemoveSchema.parse(req.body);
      const out = await square.remove(admin, type, id, input);
      await audit(db, admin, 'SQUARE_REMOVE', 'square', `${type}:${id}`, { handle: await handleOf(out.userId), ...input, strikes: out.strike?.count ?? null });
      res.json({ ok: true, strike: out.strike });
    }),
  );

  r.post(
    '/square/:type/:id/restore',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const type = kindOf(req.params.type);
      const id = idOf(req.params.id);
      const { note } = squareModNoteSchema.parse(req.body);
      const out = await square.restore(admin, type, id);
      await audit(db, admin, 'SQUARE_RESTORE', 'square', `${type}:${id}`, { handle: await handleOf(out.userId), note });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/square/reports/dismiss',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { targetType, targetId, note } = z
        .object({ targetType: z.enum(['POST', 'COMMENT', 'PROFILE']), targetId: z.string().trim().min(1).max(40), note: z.string().trim().min(3).max(300) })
        .strict()
        .parse(req.body);
      const out = await square.dismissReports(admin, targetType, targetId);
      await audit(db, admin, 'SQUARE_REPORT_DISMISS', 'square', `${targetType}:${targetId}`, { note, ...out });
      res.json({ ok: true, ...out });
    }),
  );

  r.post(
    '/square/:type/:id/appeal',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const type = kindOf(req.params.type);
      const id = idOf(req.params.id);
      const { accept, note } = squareAppealDecisionSchema.parse(req.body);
      const out = await square.decideAppeal(admin, type, id, accept, note);
      await audit(db, admin, accept ? 'SQUARE_APPEAL_ACCEPT' : 'SQUARE_APPEAL_REJECT', 'square', `${type}:${id}`, { handle: await handleOf(out.userId), note });
      res.json({ ok: true });
    }),
  );

  /* ---------------- người dùng ---------------- */

  r.get(
    '/square/users',
    need('square.moderate'),
    ah(async (req, res) => res.json(await square.modUsers(z.string().max(40).default('').parse(req.query.q ?? '')))),
  );
  r.get('/square/users/:id', need('square.moderate'), ah(async (req, res) => res.json(await square.modUser(uuid.parse(req.params.id)))));

  approvals.register('SQUARE_BAN', async (admin, req) => {
    const p = req.payload as { reason: string };
    await square.ban(req.target!, null, true, p.reason);
    await audit(db, admin, 'SQUARE_BAN', 'user', req.target, { permanent: true, reason: p.reason, approvalId: req.id });
    return { permanent: true };
  });
  approvals.register('SQUARE_UNBAN', async (admin, req) => {
    const p = req.payload as { note: string };
    await square.unban(req.target!, p.note);
    await audit(db, admin, 'SQUARE_UNBAN', 'user', req.target, { note: p.note, approvalId: req.id });
    return { unbanned: true };
  });

  r.post(
    '/square/users/:id/ban',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const userId = uuid.parse(req.params.id);
      const input = squareBanSchema.parse(req.body);
      const u = await square.modUser(userId);
      if (input.permanent) {
        if (u.banPermanent) throw badRequest('ALREADY', 'Người dùng đã bị cấm vĩnh viễn');
        const request = await approvals.create(admin, {
          kind: 'SQUARE_BAN',
          target: userId,
          payload: { handle: u.handle, reason: input.reason, activeStrikes: u.activeStrikes },
          summary: `Cấm vĩnh viễn @${u.handle} đăng bài Cộng đồng (${u.activeStrikes} vi phạm còn hiệu lực)`,
          reason: input.reason,
        });
        res.status(202).json({ ok: true, pending: true, request });
        return;
      }
      if (input.days! > SQUARE_RULES.maxManualBanDays)
        throw badRequest('BAN_TOO_LONG', `Cấm tay tối đa ${SQUARE_RULES.maxManualBanDays} ngày; dài hơn hãy đề xuất cấm vĩnh viễn`);
      const until = new Date(Date.now() + input.days! * 86_400_000);
      await square.ban(userId, until, false, input.reason);
      await audit(db, admin, 'SQUARE_BAN', 'user', userId, { handle: u.handle, days: input.days, reason: input.reason });
      res.json({ ok: true, until: until.toISOString() });
    }),
  );

  r.post(
    '/square/users/:id/unban',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const userId = uuid.parse(req.params.id);
      const { note } = squareModNoteSchema.parse(req.body);
      const u = await square.modUser(userId);
      if (!u.banned) throw badRequest('NOT_BANNED', 'Người dùng không bị cấm');
      const daysLeft = u.banUntil ? (new Date(u.banUntil).getTime() - Date.now()) / 86_400_000 : 0;
      if (u.banPermanent || daysLeft >= SQUARE_RULES.unbanApprovalDays) {
        const request = await approvals.create(admin, {
          kind: 'SQUARE_UNBAN',
          target: userId,
          payload: { handle: u.handle, note, permanent: u.banPermanent, banUntil: u.banUntil },
          summary: `Gỡ cấm đăng bài cho @${u.handle} (${u.banPermanent ? 'vĩnh viễn' : `còn ${Math.ceil(daysLeft)} ngày`})`,
          reason: note,
        });
        res.status(202).json({ ok: true, pending: true, request });
        return;
      }
      await square.unban(userId, note);
      await audit(db, admin, 'SQUARE_UNBAN', 'user', userId, { handle: u.handle, note });
      res.json({ ok: true });
    }),
  );

  r.post(
    '/square/users/:id/reset-handle',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const userId = uuid.parse(req.params.id);
      const { rule, note } = squareHandleResetSchema.parse(req.body);
      const out = await square.resetHandle(admin, userId, rule, note);
      await audit(db, admin, 'SQUARE_HANDLE_RESET', 'user', userId, { from: out.old, to: out.handle, rule, note, strikes: out.strike.count });
      res.json({ ok: true, handle: out.handle, strike: out.strike });
    }),
  );

  /* ---------------- quy tắc lọc ---------------- */

  r.get('/square/rules', need('square.moderate'), (_req, res) => {
    res.json({ rules: SQUARE_RULES, defaults: DEFAULT_SQUARE_RULES, overrides: store.squareRulesPatch });
  });

  r.put(
    '/square/rules',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const patch = squareRulesPatchSchema.parse(req.body);
      const before = { ...store.squareRulesPatch };
      await store.setSquareRules(patch);
      await audit(db, admin, 'SQUARE_RULES_SET', 'system', null, { before, patch });
      res.json({ rules: SQUARE_RULES, overrides: store.squareRulesPatch });
    }),
  );

  r.delete(
    '/square/rules',
    need('square.moderate'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      await store.setSquareRules(null);
      await audit(db, admin, 'SQUARE_RULES_RESET', 'system', null, {});
      res.json({ rules: SQUARE_RULES, overrides: store.squareRulesPatch });
    }),
  );

  /** Thử 1 câu với bộ lọc hiện tại (gồm từ quản trị thêm) */
  r.post(
    '/square/rules/test',
    need('square.moderate'),
    ah(async (req, res) => {
      const { text } = z.object({ text: z.string().max(2000) }).parse(req.body);
      res.json(moderateText(text, moderationExtra()));
    }),
  );
}
