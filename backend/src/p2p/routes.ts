import { Router } from 'express';
import { z } from 'zod';
import {
  P2P_ASSETS,
  P2P_RULES,
  appealSchema,
  bankTransferSchema,
  createAdSchema,
  p2pMessageSchema,
  paymentMethodSchema,
  placeP2POrderSchema,
  updateAdSchema,
  type P2PConfigDTO,
} from '@vss/shared';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { ah, badRequest } from '../lib/errors';
import type { BankService } from './bank';
import type { P2PService } from './service';

const idOf = (raw: string | undefined, what = 'đơn') => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', `Mã ${what} không hợp lệ`);
  return id;
};
const uid = (req: unknown) => (req as AuthedRequest).user.id;

/**
 * API chợ P2P cho người dùng (/api/p2p/*) và ngân hàng giả lập (/api/bank/*).
 * Gắn TRƯỚC tradingRoutes trong index.ts. Danh sách quảng cáo và cấu hình là công khai, còn lại cần đăng nhập.
 */
export function p2pRoutes(p2p: P2PService, bank: BankService) {
  const r = Router();

  /* ---------------- công khai ---------------- */

  r.get('/p2p/config', (_req, res) => {
    const body: P2PConfigDTO = { rules: P2P_RULES, assets: P2P_ASSETS, refPrices: p2p.refPrices() };
    res.json(body);
  });

  r.get(
    '/p2p/ads',
    ah(async (req, res) => {
      const f = z
        .object({
          side: z.enum(['BUY', 'SELL']).default('BUY'),
          asset: z.enum(P2P_ASSETS).default('USDT'),
          fiatAmount: z
            .string()
            .regex(/^\d+$/)
            .optional(),
          bank: z.string().trim().max(40).optional(),
        })
        .parse(req.query);
      res.json(await p2p.listAds(f));
    }),
  );

  /* ---------------- thương nhân ---------------- */

  r.get(
    '/p2p/merchant',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.myMerchant(uid(req)))),
  );
  r.post(
    '/p2p/merchant/apply',
    requireAuth,
    ah(async (req, res) => {
      await p2p.apply(uid(req));
      res.json(await p2p.myMerchant(uid(req)));
    }),
  );
  r.post(
    '/p2p/merchant/resign',
    requireAuth,
    ah(async (req, res) => {
      await p2p.resign(uid(req));
      res.json(await p2p.myMerchant(uid(req)));
    }),
  );

  r.get(
    '/p2p/payment-methods',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.paymentMethods(uid(req)))),
  );
  r.post(
    '/p2p/payment-methods',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.addPaymentMethod(uid(req), paymentMethodSchema.parse(req.body)))),
  );
  r.delete(
    '/p2p/payment-methods/:id',
    requireAuth,
    ah(async (req, res) => {
      await p2p.removePaymentMethod(uid(req), idOf(req.params.id, 'phương thức'));
      res.json({ ok: true });
    }),
  );

  r.get(
    '/p2p/my-ads',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.myAds(uid(req)))),
  );
  r.post(
    '/p2p/my-ads',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.createAd(uid(req), createAdSchema.parse(req.body)))),
  );
  r.patch(
    '/p2p/my-ads/:id',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.updateAd(uid(req), idOf(req.params.id, 'quảng cáo'), updateAdSchema.parse(req.body)))),
  );
  r.post(
    '/p2p/my-ads/:id/online',
    requireAuth,
    ah(async (req, res) => {
      const { online } = z.object({ online: z.boolean() }).strict().parse(req.body);
      res.json(await p2p.setAdOnline(uid(req), idOf(req.params.id, 'quảng cáo'), online));
    }),
  );
  r.delete(
    '/p2p/my-ads/:id',
    requireAuth,
    ah(async (req, res) => {
      await p2p.closeAd(uid(req), idOf(req.params.id, 'quảng cáo'));
      res.json({ ok: true });
    }),
  );

  /* ---------------- đơn P2P ---------------- */

  r.get(
    '/p2p/orders',
    requireAuth,
    ah(async (req, res) => {
      const { scope } = z.object({ scope: z.enum(['open', 'done', 'all']).default('all') }).parse(req.query);
      res.json(await p2p.myOrders(uid(req), scope));
    }),
  );
  r.post(
    '/p2p/orders',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.placeOrder(uid(req), placeP2POrderSchema.parse(req.body)))),
  );
  r.get(
    '/p2p/orders/:id',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.orderFor(uid(req), idOf(req.params.id)))),
  );
  r.post(
    '/p2p/orders/:id/paid',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.markPaid(uid(req), idOf(req.params.id)))),
  );
  r.post(
    '/p2p/orders/:id/release',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.release(uid(req), idOf(req.params.id)))),
  );
  r.post(
    '/p2p/orders/:id/cancel',
    requireAuth,
    ah(async (req, res) => {
      const { reason } = z.object({ reason: z.string().trim().max(200).default('') }).parse(req.body ?? {});
      res.json(await p2p.cancel(uid(req), idOf(req.params.id), reason));
    }),
  );
  r.post(
    '/p2p/orders/:id/appeal',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.appeal(uid(req), idOf(req.params.id), appealSchema.parse(req.body)))),
  );
  r.get(
    '/p2p/orders/:id/messages',
    requireAuth,
    ah(async (req, res) => {
      const id = idOf(req.params.id);
      await p2p.orderFor(uid(req), id);
      res.json(await p2p.messages(id));
    }),
  );
  r.post(
    '/p2p/orders/:id/messages',
    requireAuth,
    ah(async (req, res) => res.json(await p2p.postMessage(uid(req), idOf(req.params.id), p2pMessageSchema.parse(req.body).body))),
  );

  /* ---------------- ngân hàng giả lập ---------------- */

  r.get(
    '/bank',
    requireAuth,
    ah(async (req, res) => res.json(await bank.account(uid(req)))),
  );
  r.get(
    '/bank/statement',
    requireAuth,
    ah(async (req, res) => res.json(await bank.statement(uid(req)))),
  );
  r.get(
    '/bank/lookup/:accountNo',
    requireAuth,
    ah(async (req, res) => {
      const no = z.string().regex(/^\d{10}$/, 'Số tài khoản gồm 10 chữ số').parse(req.params.accountNo);
      res.json(await bank.lookup(no));
    }),
  );
  r.post(
    '/bank/transfers',
    requireAuth,
    ah(async (req, res) => res.json(await bank.transfer(uid(req), bankTransferSchema.parse(req.body)))),
  );

  return r;
}
