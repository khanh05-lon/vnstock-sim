import { Router } from 'express';
import { privacyDeleteSchema } from '@vss/shared';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { ah, badRequest } from '../lib/errors';
import type { PrivacyService } from './service';

/** Quyền của chủ thể dữ liệu (/api/privacy/*): tải dữ liệu cá nhân, yêu cầu xoá tài khoản. Gắn TRƯỚC tradingRoutes */
export function privacyRoutes(privacy: PrivacyService) {
  const r = Router();
  const uid = (req: unknown) => (req as AuthedRequest).user.id;

  r.get(
    '/privacy/export',
    requireAuth,
    ah(async (req, res) => {
      const data = await privacy.exportData(uid(req));
      res.setHeader('Content-Disposition', `attachment; filename="vncoin-du-lieu-ca-nhan-${new Date().toISOString().slice(0, 10)}.json"`);
      res.json(data);
    }),
  );
  r.get(
    '/privacy/requests',
    requireAuth,
    ah(async (req, res) => res.json(await privacy.myRequests(uid(req)))),
  );
  r.post(
    '/privacy/requests',
    requireAuth,
    ah(async (req, res) => res.json(await privacy.requestDelete(uid(req), privacyDeleteSchema.parse(req.body).reason))),
  );
  r.delete(
    '/privacy/requests/:id',
    requireAuth,
    ah(async (req, res) => {
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã yêu cầu không hợp lệ');
      await privacy.cancel(uid(req), id);
      res.json({ ok: true });
    }),
  );
  return r;
}
