import { Router } from 'express';
import { kycLevel1Schema, kycLevel2Schema } from '@vss/shared';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { ah } from '../lib/errors';
import type { KycService } from './service';

/** Xác minh danh tính của chính khách (/api/kyc). Gắn TRƯỚC tradingRoutes trong index.ts */
export function kycRoutes(kyc: KycService) {
  const r = Router();
  const uid = (req: unknown) => (req as AuthedRequest).user.id;

  r.get(
    '/kyc',
    requireAuth,
    ah(async (req, res) => res.json(await kyc.status(uid(req)))),
  );
  r.post(
    '/kyc/level1',
    requireAuth,
    ah(async (req, res) => res.json(await kyc.submit(uid(req), 1, kycLevel1Schema.parse(req.body)))),
  );
  r.post(
    '/kyc/level2',
    requireAuth,
    ah(async (req, res) => res.json(await kyc.submit(uid(req), 2, kycLevel2Schema.parse(req.body)))),
  );
  return r;
}
