import { Router } from 'express';
import { z } from 'zod';
import type { CorporateService } from '../corporate/service';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { ah, badRequest } from '../lib/errors';

/** Sự kiện quyền: lịch công khai, quyền của nhà đầu tư, đăng ký mua cổ phiếu phát hành thêm */
export function corporateRoutes(corp: CorporateService) {
  const r = Router();

  r.get(
    '/corporate-actions',
    ah(async (req, res) => {
      const q = z
        .object({ symbol: z.string().trim().toUpperCase().max(10).optional(), upcoming: z.enum(['0', '1']).optional() })
        .parse(req.query);
      res.json(await corp.list({ symbol: q.symbol || undefined, upcoming: q.upcoming === '1', limit: 100 }));
    }),
  );

  r.get(
    '/entitlements',
    requireAuth,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await corp.entitlements(user.id));
    }),
  );

  r.post(
    '/corporate-actions/:id/subscribe',
    requireAuth,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã sự kiện không hợp lệ');
      const { qty } = z.object({ qty: z.number().int().positive() }).strict().parse(req.body);
      res.json(await corp.subscribe(user.id, id, qty));
    }),
  );

  return r;
}
