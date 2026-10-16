import { Router } from 'express';
import { z } from 'zod';
import { priceAlertSchema } from '@vss/shared';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { ah, badRequest } from '../lib/errors';
import type { PriceAlertService } from '../trading/priceAlerts';

/** Cảnh báo giá của người dùng */
export function alertRoutes(alerts: PriceAlertService) {
  const r = Router();
  r.use('/alerts', requireAuth);

  r.get(
    '/alerts',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { scope, symbol } = z
        .object({ scope: z.enum(['active', 'all']).default('all'), symbol: z.string().trim().toUpperCase().optional() })
        .parse(req.query);
      res.json(await alerts.list(user.id, scope, symbol || undefined));
    }),
  );

  r.post(
    '/alerts',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.status(201).json(await alerts.create(user.id, priceAlertSchema.parse(req.body)));
    }),
  );

  r.delete(
    '/alerts/:id',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const id = Number(req.params.id);
      if (!Number.isInteger(id) || id <= 0) throw badRequest('ID', 'Mã cảnh báo không hợp lệ');
      res.json(await alerts.cancel(user.id, id));
    }),
  );

  return r;
}
