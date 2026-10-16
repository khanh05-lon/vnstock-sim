import { Router } from 'express';
import { z } from 'zod';
import { ocoOrderSchema, placeOrderSchema, replaceOrderSchema } from '@vss/shared';
import type { Database } from '../db';
import { config } from '../config';
import { isEmailVerified, requireAuth, type AuthedRequest } from '../lib/auth';
import { AppError, ah, badRequest } from '../lib/errors';
import { limiter } from '../lib/rateLimit';
import type { MarketService } from '../market/marketService';
import { metrics } from '../ops/metrics';
import type { NavService } from '../portfolio/nav';
import { monthlyReport } from '../portfolio/report';
import { accountView } from '../trading/account';
import { toFillDTO, toLedgerDTO, toOrderDTO, toOrderListDTO, type FillRow, type LedgerRow, type OrderListRow, type OrderRow } from '../trading/dto';
import type { SpotEngine } from '../trading/engine';

const dateStr = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ (YYYY-MM-DD)')
  .optional();

const historyQuery = z.object({
  from: dateStr,
  to: dateStr,
  symbol: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{0,20}$/)
    .optional(),
  asset: z
    .string()
    .trim()
    .toUpperCase()
    .regex(/^[A-Z0-9]{0,15}$/)
    .optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  status: z.enum(['NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED']).optional(),
  limit: z.coerce.number().int().min(1).max(1000).default(500),
});

const idParam = (raw: string | undefined) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã lệnh không hợp lệ');
  return id;
};

/** Lọc theo ngày UTC */
function dateFilters(col: string, from: string | undefined, to: string | undefined, params: unknown[]): string[] {
  const where: string[] = [];
  if (from) {
    params.push(from);
    where.push(`(${col} AT TIME ZONE 'UTC')::date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`(${col} AT TIME ZONE 'UTC')::date <= $${params.length}::date`);
  }
  return where;
}

export function tradingRoutes(db: Database, market: MarketService, engine: SpotEngine, nav: NavService) {
  const r = Router();
  r.use(requireAuth);

  // Theo từng người dùng (sau requireAuth nên luôn có user id)
  const orderLimiter = limiter({
    windowMs: 60_000,
    limit: config.rateLimit.ordersPerMinute,
    message: 'Bạn đặt lệnh quá nhanh, vui lòng chậm lại',
  });

  /** REQUIRE_EMAIL_VERIFICATION=true: phải xác thực email trước khi đặt lệnh */
  const assertVerified = async (userId: string) => {
    if (config.requireEmailVerification && !(await isEmailVerified(userId))) {
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Vui lòng xác thực email trước khi đặt lệnh (kiểm tra hộp thư hoặc bấm "Gửi lại email xác thực")');
    }
  };

  /* ------------------------------ ví ------------------------------ */

  r.get(
    '/account',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await accountView(db, market, user.id));
    }),
  );

  /** Bật / tắt trả phí bằng BNB */
  r.put(
    '/account/settings',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { payFeeWithBnb } = z.object({ payFeeWithBnb: z.boolean() }).strict().parse(req.body);
      await db.many('UPDATE accounts SET pay_fee_with_bnb = $2, updated_at = now() WHERE user_id = $1', [user.id, payFeeWithBnb]);
      res.json(await accountView(db, market, user.id));
    }),
  );

  r.post(
    '/account/reset',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      await engine.resetAccount(user.id);
      res.json({ ok: true });
    }),
  );

  /** Tổng tài sản (USDT) theo ngày + BTC cùng kỳ để so sánh */
  r.get(
    '/account/nav',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { range } = z.object({ range: z.enum(['7D', '1M', '3M', '1Y', 'ALL']).default('1M') }).parse(req.query);
      const days = { '7D': 7, '1M': 30, '3M': 90, '1Y': 365, ALL: 0 }[range];
      const points = await nav.history(user.id, days);
      const from = points[0] ? Date.parse(`${points[0].date}T00:00:00Z`) : Date.now();
      const btc = market.info('BTCUSDT')
        ? (await market.candles('BTCUSDT', '1d', 1000).catch(() => [])).filter((k) => k.time * 1000 >= from).map((k) => ({
            date: new Date(k.time * 1000).toISOString().slice(0, 10),
            value: k.close,
          }))
        : [];
      res.json({ points, benchmark: btc });
    }),
  );

  /* ------------------------------ lệnh ------------------------------ */

  r.post(
    '/orders',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      await assertVerified(user.id);
      const input = placeOrderSchema.parse(req.body);
      const order = await engine.placeOrder(user.id, input);
      metrics.orders.placed++;
      res.status(201).json(order);
    }),
  );

  r.post(
    '/orders/oco',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      await assertVerified(user.id);
      const input = ocoOrderSchema.parse(req.body);
      const list = await engine.placeOco(user.id, input);
      metrics.orders.placed += 2;
      res.status(201).json(list);
    }),
  );

  /** Lệnh đang mở */
  r.get(
    '/openOrders',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const q = historyQuery.parse(req.query);
      const params: unknown[] = [user.id];
      let where = `user_id = $1 AND status IN ('NEW','PARTIALLY_FILLED')`;
      if (q.symbol) {
        params.push(q.symbol);
        where += ` AND symbol = $${params.length}`;
      }
      const rows = await db.many<OrderRow>(`SELECT * FROM orders WHERE ${where} ORDER BY id DESC`, params);
      res.json(rows.map(toOrderDTO));
    }),
  );

  /** Lịch sử lệnh */
  r.get(
    '/orders',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const q = historyQuery.parse(req.query);
      const params: unknown[] = [user.id];
      const where = ['user_id = $1'];
      if (q.symbol) {
        params.push(q.symbol);
        where.push(`symbol = $${params.length}`);
      }
      if (q.side) {
        params.push(q.side);
        where.push(`side = $${params.length}`);
      }
      if (q.status) {
        params.push(q.status);
        where.push(`status = $${params.length}`);
      }
      where.push(...dateFilters('created_at', q.from, q.to, params));
      params.push(q.limit);
      const rows = await db.many<OrderRow>(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`, params);
      res.json(rows.map(toOrderDTO));
    }),
  );

  r.get(
    '/orderLists/:id',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const id = idParam(req.params.id);
      const list = await db.one<OrderListRow>('SELECT * FROM order_lists WHERE id = $1 AND user_id = $2', [id, user.id]);
      if (!list) throw badRequest('NOT_FOUND', 'Không tìm thấy lệnh OCO');
      const orders = await db.many<OrderRow>('SELECT * FROM orders WHERE order_list_id = $1 ORDER BY id', [id]);
      res.json(toOrderListDTO(list, orders));
    }),
  );

  /** Sửa lệnh giới hạn (huỷ và đặt lại) */
  r.put(
    '/orders/:id',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = replaceOrderSchema.parse(req.body);
      res.json(await engine.replaceOrder(user.id, idParam(req.params.id), input));
    }),
  );

  r.delete(
    '/orders/:id',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const order = await engine.cancelOrder(user.id, idParam(req.params.id));
      metrics.orders.cancelled++;
      res.json(order);
    }),
  );

  r.delete(
    '/orderLists/:id',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await engine.cancelOrderList(user.id, idParam(req.params.id)));
    }),
  );

  /** Huỷ tất cả lệnh mở (theo cặp nếu có ?symbol=) */
  r.delete(
    '/openOrders',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { symbol } = historyQuery.parse(req.query);
      const n = await engine.cancelAll(user.id, symbol || undefined);
      metrics.orders.cancelled += n;
      res.json({ canceled: n });
    }),
  );

  /* ------------------------------ lịch sử ------------------------------ */

  r.get(
    '/myTrades',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const q = historyQuery.parse(req.query);
      const params: unknown[] = [user.id];
      const where = ['user_id = $1'];
      if (q.symbol) {
        params.push(q.symbol);
        where.push(`symbol = $${params.length}`);
      }
      if (q.side) {
        params.push(q.side);
        where.push(`side = $${params.length}`);
      }
      where.push(...dateFilters('executed_at', q.from, q.to, params));
      params.push(q.limit);
      const rows = await db.many<FillRow>(`SELECT * FROM fills WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`, params);
      res.json(rows.map(toFillDTO));
    }),
  );

  r.get(
    '/ledger',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const q = historyQuery.parse(req.query);
      const params: unknown[] = [user.id];
      const where = ['user_id = $1', ...dateFilters('created_at', q.from, q.to, params)];
      if (q.asset) {
        params.push(q.asset);
        where.push(`asset = $${params.length}`);
      }
      params.push(q.limit);
      const rows = await db.many<LedgerRow>(`SELECT * FROM ledger WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT $${params.length}`, params);
      res.json(rows.map(toLedgerDTO));
    }),
  );

  /* ------------------------------ báo cáo ------------------------------ */

  r.get(
    '/reports/monthly',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const thisYear = new Date().getUTCFullYear();
      const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100).default(thisYear) }).parse(req.query);
      res.json(await monthlyReport(db, user.id, year));
    }),
  );

  return r;
}
