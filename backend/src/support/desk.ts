import { Router } from 'express';
import { z } from 'zod';
import { Big, can, rolesWith, ticketMessageSchema, ticketUpdateSchema } from '@vss/shared';
import { assetParam, audit, reasonSchema, uuid, type AdminDeps, type AdminRequest } from '../admin/common';
import { auditView, createAdjustRequest, lockUser, staffGuard } from '../admin/staff';
import { listAuthEvents } from '../lib/authEvents';
import { ah, badRequest, notFound } from '../lib/errors';
import { accountView } from '../trading/account';
import { toFillDTO, toLedgerDTO, toOrderDTO, type FillRow, type LedgerRow, type OrderRow } from '../trading/dto';
import { listOrderEvents } from '../trading/orderEvents';
import { mountP2PDesk } from '../p2p/deskRoutes';
import { mountSupportLead } from './lead';
import type { P2PService } from '../p2p/service';
import type { SupportService } from './service';

const idOf = (raw: string | undefined, what = 'yêu cầu') => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', `Mã ${what} không hợp lệ`);
  return id;
};

/**
 * Khu vực nhân viên CSKH (/api/support-desk): nhân viên CSKH, Trưởng nhóm CSKH, Vận hành P2P, Rủi ro.
 * Nhân viên chỉ xem được dữ liệu của khách THÔNG QUA yêu cầu hỗ trợ khách đã gửi (quyền tối thiểu),
 * mỗi lần xem được ghi nhật ký; mọi thao tác nghiệp vụ ghi nhật ký quản trị + tin nhắn hệ thống trong yêu cầu.
 */
export function deskRoutes(deps: Pick<AdminDeps, 'db' | 'io' | 'market' | 'engine' | 'store' | 'mailer'> & { support: SupportService; p2p?: P2PService }) {
  const { db, market, engine, support } = deps;
  const r = Router();
  r.use(...staffGuard(db, 'support.desk'));

  r.get(
    '/me',
    ah(async (req, res) => {
      res.json({ staff: (req as AdminRequest).admin });
    }),
  );

  r.get(
    '/stats',
    ah(async (req, res) => {
      res.json(await support.stats((req as AdminRequest).admin));
    }),
  );

  /** Danh sách nhân viên để giao việc */
  r.get(
    '/staff',
    ah(async (_req, res) => {
      const rows = await db.many<{ id: string; email: string; full_name: string; role: string }>(
        `SELECT id, email, full_name, role FROM users WHERE role = ANY($1::text[]) AND status = 'ACTIVE' ORDER BY role, email`,
        [rolesWith('support.desk')],
      );
      res.json(rows.map((u) => ({ id: u.id, email: u.email, fullName: u.full_name, role: u.role })));
    }),
  );

  r.get(
    '/tickets',
    ah(async (req, res) => {
      const f = z
        .object({ scope: z.enum(['active', 'mine', 'unassigned', 'overdue', 'all']).default('active'), q: z.string().trim().max(100).optional() })
        .parse(req.query);
      res.json(await support.list((req as AdminRequest).admin, f));
    }),
  );

  /** Chi tiết yêu cầu + hồ sơ khách để xử lý: ví, lệnh đang mở, lệnh / khớp / sổ cái gần đây, đăng nhập gần đây */
  r.get(
    '/tickets/:id',
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const id = idOf(req.params.id);
      const detail = await support.detailForStaff(id);
      const uid = detail.ticket.customer!.id;
      await auditView(db, staff, uid, detail.ticket.customer!.email, `support #${id}`);
      const [account, open, recent, fills, ledger, logins] = await Promise.all([
        accountView(db, market, uid).catch(() => null),
        db.many<OrderRow>(`SELECT * FROM orders WHERE user_id = $1 AND status IN ('NEW','PARTIALLY_FILLED') ORDER BY id DESC LIMIT 50`, [uid]),
        db.many<OrderRow>('SELECT * FROM orders WHERE user_id = $1 ORDER BY id DESC LIMIT 30', [uid]),
        db.many<FillRow>('SELECT * FROM fills WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [uid]),
        db.many<LedgerRow>('SELECT * FROM ledger WHERE user_id = $1 ORDER BY id DESC LIMIT 20', [uid]),
        listAuthEvents(db, uid, 20),
      ]);
      const linked = detail.ticket.orderId
        ? {
            order: (await db.one<OrderRow>('SELECT * FROM orders WHERE id = $1 AND user_id = $2', [detail.ticket.orderId, uid])) ?? null,
            events: await listOrderEvents(db, detail.ticket.orderId),
            fills: (await db.many<FillRow>('SELECT * FROM fills WHERE order_id = $1 ORDER BY id', [detail.ticket.orderId])).map(toFillDTO),
          }
        : null;
      res.json({
        ...detail,
        customer: {
          account,
          openOrders: open.map(toOrderDTO),
          recentOrders: recent.map(toOrderDTO),
          recentFills: fills.map(toFillDTO),
          recentLedger: ledger.map(toLedgerDTO),
          authEvents: logins,
        },
        linkedOrder: linked && { order: linked.order ? toOrderDTO(linked.order) : null, events: linked.events, fills: linked.fills },
      });
    }),
  );

  /** Nhật ký 1 lệnh của khách (chỉ lệnh của chính khách gửi yêu cầu) */
  r.get(
    '/tickets/:id/orders/:orderId/events',
    ah(async (req, res) => {
      const t = await support.getRow(idOf(req.params.id));
      const orderId = idOf(req.params.orderId, 'lệnh');
      const o = await db.one('SELECT 1 FROM orders WHERE id = $1 AND user_id = $2', [orderId, t.user_id]);
      if (!o) throw notFound('Lệnh không thuộc khách hàng của yêu cầu này');
      const fills = await db.many<FillRow>('SELECT * FROM fills WHERE order_id = $1 ORDER BY id', [orderId]);
      res.json({ events: await listOrderEvents(db, orderId), fills: fills.map(toFillDTO) });
    }),
  );

  r.post(
    '/tickets/:id/assign',
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const id = idOf(req.params.id);
      const { assigneeId } = z.object({ assigneeId: uuid.optional() }).parse(req.body ?? {});
      let assignee = { id: staff.id, email: staff.email };
      if (assigneeId && assigneeId !== staff.id) {
        if (!can(staff.role, 'support.lead')) throw badRequest('FORBIDDEN', 'Chỉ Trưởng nhóm CSKH được giao yêu cầu cho nhân viên khác');
        const u = await db.one<{ id: string; email: string }>(`SELECT id, email FROM users WHERE id = $1 AND role = ANY($2::text[]) AND status = 'ACTIVE'`, [
          assigneeId,
          rolesWith('support.desk'),
        ]);
        if (!u) throw badRequest('ASSIGNEE', 'Người được giao không phải nhân viên đang hoạt động');
        assignee = u;
      }
      res.json(await support.assign(staff, id, assignee));
    }),
  );

  r.post(
    '/tickets/:id/messages',
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const { body, internal } = ticketMessageSchema.parse(req.body);
      res.json(await support.staffMessage(staff, idOf(req.params.id), body, !!internal));
    }),
  );

  r.post(
    '/tickets/:id/update',
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      res.json(await support.update(staff, idOf(req.params.id), ticketUpdateSchema.parse(req.body)));
    }),
  );

  /** Huỷ hộ lệnh đang mở của khách (vd. khách không huỷ được, lệnh đặt nhầm) */
  r.post(
    '/tickets/:id/cancel-order',
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const id = idOf(req.params.id);
      const { orderId, reason } = z.object({ orderId: z.number().int().positive(), reason: reasonSchema }).parse(req.body);
      const t = await support.getRow(id);
      const o = await db.one<{ user_id: string }>('SELECT user_id FROM orders WHERE id = $1', [orderId]);
      if (!o || o.user_id !== t.user_id) throw badRequest('ORDER', 'Lệnh không thuộc khách hàng của yêu cầu này');
      const order = await engine.adminCancel(orderId, `CSKH huỷ hộ (yêu cầu #${id}): ${reason}`, { actor: staff.email });
      await audit(db, staff, 'ORDER_CANCEL', 'order', String(orderId), { ticketId: id, symbol: order.symbol, side: order.side, reason });
      await support.action(staff, id, `huỷ hộ lệnh #${orderId} (${order.symbol}) — ${reason}`, `Nhân viên CSKH đã huỷ hộ lệnh #${orderId} (${order.symbol}): ${reason}`);
      res.json({ order, ticket: await support.detailForStaff(id) });
    }),
  );

  /** Khoá khẩn tài khoản khi khách báo bị truy cập trái phép (mở khoá chỉ quản trị viên làm) */
  r.post(
    '/tickets/:id/lock-user',
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const id = idOf(req.params.id);
      const { reason } = z.object({ reason: reasonSchema }).parse(req.body);
      const t = await support.getRow(id);
      const out = await lockUser(deps, staff, t.user_id, `${reason} (yêu cầu hỗ trợ #${id})`);
      await support.action(staff, id, `khoá khẩn tài khoản, huỷ ${out.cancelledOrders} lệnh mở — ${reason}`);
      res.json({ ok: true, cancelledOrders: out.cancelledOrders, ticket: await support.detailForStaff(id) });
    }),
  );

  /** Đề xuất điều chỉnh số dư (bồi hoàn / sửa sai) — luôn cần quản trị viên khác duyệt */
  r.post(
    '/tickets/:id/adjust-request',
    ah(async (req, res) => {
      const staff = (req as AdminRequest).admin;
      const id = idOf(req.params.id);
      const { asset, amount, reason } = z
        .object({
          asset: assetParam,
          amount: z
            .string()
            .trim()
            .regex(/^-?\d{1,15}(\.\d{1,18})?$/, 'Số lượng không hợp lệ')
            .refine((v) => Number(v) !== 0, 'Số lượng phải khác 0'),
          reason: reasonSchema,
        })
        .parse(req.body);
      const t = await support.getRow(id);
      const price = market.priceUsdt(asset);
      if (!price) throw badRequest('ASSET', `Không định giá được ${asset}`);
      const usdtValue = new Big(amount).times(price);
      if (usdtValue.abs().gt(1_000_000)) throw badRequest('LIMIT', 'Mỗi lần điều chỉnh tối đa tương đương 1.000.000 USDT');
      const request = await createAdjustRequest(db, staff, {
        userId: t.user_id,
        email: t.email ?? '',
        asset,
        amount,
        usdtValue: usdtValue.toFixed(),
        reason,
        ticketId: id,
      }, deps.mailer);
      await support.action(staff, id, `đề xuất điều chỉnh ${amount} ${asset} (≈ ${usdtValue.toFixed(2)} USDT), yêu cầu duyệt #${request.id} — ${reason}`);
      res.status(201).json({ request, ticket: await support.detailForStaff(id) });
    }),
  );

  // Trưởng nhóm CSKH: bồi hoàn nhỏ, khôi phục 2FA (đối chiếu KYC)
  mountSupportLead(r, { db, io: deps.io, mailer: deps.mailer, support });
  // Khiếu nại đơn P2P (quyền p2p.appeal)
  if (deps.p2p) mountP2PDesk(r, { db, p2p: deps.p2p });
  return r;
}
