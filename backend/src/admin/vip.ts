import type { Router } from 'express';
import { DEFAULT_VIP_RULES, VIP_RULES, vipRulesPatchSchema } from '@vss/shared';
import { ah, notFound } from '../lib/errors';
import { feeTable } from '../trading/vip';
import { audit, need, type AdminDeps, type AdminRequest } from './common';

/** Cấp VIP phí: Vận hành thị trường chỉnh hệ số ngưỡng (market.manage) và tính lại cấp ngay; ai vào quản trị cũng xem được */
export function mountVipAdmin(r: Router, deps: AdminDeps) {
  const { db, store, vip } = deps;

  r.get('/vip/rules', need('admin.view'), (_req, res) => {
    res.json({ rules: VIP_RULES, defaults: DEFAULT_VIP_RULES, overrides: store.vipRulesPatch, tiers: feeTable() });
  });

  r.put(
    '/vip/rules',
    need('market.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const patch = vipRulesPatchSchema.parse(req.body);
      const before = { ...store.vipRulesPatch };
      await store.setVipRules(patch);
      await audit(db, admin, 'VIP_RULES_SET', 'system', null, { before, patch });
      res.json({ rules: VIP_RULES, overrides: store.vipRulesPatch, tiers: feeTable() });
    }),
  );

  r.delete(
    '/vip/rules',
    need('market.manage'),
    ah(async (req, res) => {
      await store.setVipRules(null);
      await audit(db, (req as AdminRequest).admin, 'VIP_RULES_RESET', 'system', null, {});
      res.json({ rules: VIP_RULES, overrides: store.vipRulesPatch, tiers: feeTable() });
    }),
  );

  /** Tính lại cấp VIP ngay (thường hệ thống tự tính 00:00 UTC) — dùng sau khi đổi hệ số ngưỡng */
  r.post(
    '/vip/recompute',
    need('market.manage'),
    ah(async (req, res) => {
      if (!vip) throw notFound('Chưa bật cấp VIP');
      const changed = await vip.recomputeAll();
      await audit(db, (req as AdminRequest).admin, 'VIP_RECOMPUTE', 'system', null, { changed });
      res.json({ changed });
    }),
  );
}
