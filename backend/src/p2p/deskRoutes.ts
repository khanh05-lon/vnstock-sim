import type { Router } from 'express';
import { z } from 'zod';
import { p2pMessageSchema, resolveAppealSchema } from '@vss/shared';
import { audit, need, type AdminRequest } from '../admin/common';
import { auditView } from '../admin/staff';
import type { Database } from '../db';
import { ah, badRequest, notFound } from '../lib/errors';
import { bankAccountOf, transfersBetween } from './bank';
import type { P2POrderRow, P2PService } from './service';

const idOf = (raw: string | undefined) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã đơn P2P không hợp lệ');
  return id;
};

/**
 * Xử lý khiếu nại P2P ở khu CSKH (/api/support-desk/p2p, quyền p2p.appeal).
 * Bằng chứng: chat trong đơn + các lệnh chuyển khoản ngân hàng giả lập giữa hai bên kể từ lúc tạo đơn.
 * Mỗi lần mở chi tiết ghi USER_VIEW cho cả hai bên; phân xử ghi P2P_APPEAL_RESOLVE.
 */
export function mountP2PDesk(r: Router, deps: { db: Database; p2p: P2PService }) {
  const { db, p2p } = deps;

  r.get(
    '/p2p/appeals',
    need('p2p.appeal'),
    ah(async (req, res) => {
      const { scope } = z.object({ scope: z.enum(['open', 'resolved', 'all']).default('open') }).parse(req.query);
      const where = scope === 'open' ? `status = 'APPEAL'` : scope === 'resolved' ? `appeal_at IS NOT NULL AND status <> 'APPEAL'` : 'appeal_at IS NOT NULL';
      const rows = await db.many<P2POrderRow>(`SELECT * FROM p2p_orders WHERE ${where} ORDER BY appeal_at ${scope === 'open' ? 'ASC' : 'DESC'} LIMIT 200`);
      res.json(await p2p.toOrderDTOs(rows, null));
    }),
  );

  r.get(
    '/p2p/orders/:id',
    need('p2p.appeal'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = idOf(req.params.id);
      const o = await p2p.orderRow(id);
      if (!o) throw notFound('Không tìm thấy đơn P2P');
      const users = await db.many<{ id: string; email: string }>('SELECT id, email FROM users WHERE id = ANY($1::uuid[])', [[o.buyer_id, o.seller_id]]);
      for (const u of users) await auditView(db, admin, u.id, u.email, `p2p_order:${id}`);
      const since = new Date(new Date(o.created_at).getTime() - 60 * 60_000);
      const [buyerBank, sellerBank] = await Promise.all([bankAccountOf(db, o.buyer_id), bankAccountOf(db, o.seller_id)]);
      res.json({
        order: await p2p.toOrderDTO(o, null),
        messages: await p2p.messages(id),
        // Theo góc nhìn người mua: OUT = người mua chuyển cho bên bán
        transfers: await transfersBetween(db, o.buyer_id, o.seller_id, since, o.buyer_id),
        buyer: { email: users.find((u) => u.id === o.buyer_id)?.email ?? '', accountNo: buyerBank?.account_no ?? null },
        seller: { email: users.find((u) => u.id === o.seller_id)?.email ?? '', accountNo: sellerBank?.account_no ?? null },
      });
    }),
  );

  r.post(
    '/p2p/orders/:id/messages',
    need('p2p.appeal'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = idOf(req.params.id);
      const { body } = p2pMessageSchema.parse(req.body);
      res.json(await p2p.staffMessage(admin, id, body));
    }),
  );

  r.post(
    '/p2p/orders/:id/resolve',
    need('p2p.appeal'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const id = idOf(req.params.id);
      const input = resolveAppealSchema.parse(req.body);
      const o = await p2p.resolveAppeal(admin, id, input);
      await audit(db, admin, 'P2P_APPEAL_RESOLVE', 'p2p_order', String(id), {
        outcome: input.outcome,
        note: input.note,
        penaltyUsdt: input.penaltyUsdt ?? null,
        buyerId: o.buyer_id,
        sellerId: o.seller_id,
        qty: o.qty,
        asset: o.asset,
      });
      res.json(await p2p.toOrderDTO(o, null));
    }),
  );
}
