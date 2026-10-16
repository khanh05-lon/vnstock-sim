import { Router } from 'express';
import { z } from 'zod';
import { conditionalOrderSchema, modifyOrderSchema, placeOrderSchema } from '@vss/shared';
import type { Database } from '../db';
import { isEmailVerified, requireAuth, type AuthedRequest } from '../lib/auth';
import { AppError, ah, badRequest } from '../lib/errors';
import { limiter } from '../lib/rateLimit';
import { config } from '../config';
import { addDays } from '../lib/calendar';
import type { MarketService } from '../market/marketService';
import { metrics } from '../ops/metrics';
import type { NavService } from '../portfolio/nav';
import { monthlyReport } from '../portfolio/report';
import { advanceCash, previewAdvance } from '../trading/cash';
import type { ConditionalEngine } from '../trading/conditional';
import type { MarginService } from '../trading/margin';
import type { TradingEngine } from '../trading/engine';
import {
  toAccountDTO,
  toHoldingDTO,
  toLedgerDTO,
  toOrderDTO,
  toTradeDTO,
  type AccountRow,
  type HoldingRow,
  type LedgerRow,
  type OrderRow,
  type TradeRow,
} from '../trading/dto';

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
    .regex(/^[A-Z0-9]{0,10}$/)
    .optional(),
  side: z.enum(['BUY', 'SELL']).optional(),
  status: z.enum(['PENDING', 'PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED']).optional(),
  scope: z.enum(['open', 'today', 'all']).optional(),
});

const idParam = (raw: string) => {
  const id = Number(raw);
  if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã lệnh không hợp lệ');
  return id;
};

/** Ghép điều kiện lọc theo ngày (giờ VN) */
function dateFilters(col: string, from: string | undefined, to: string | undefined, params: unknown[]): string[] {
  const where: string[] = [];
  if (from) {
    params.push(from);
    where.push(`(${col} AT TIME ZONE 'UTC' + INTERVAL '7 hours')::date >= $${params.length}::date`);
  }
  if (to) {
    params.push(to);
    where.push(`(${col} AT TIME ZONE 'UTC' + INTERVAL '7 hours')::date <= $${params.length}::date`);
  }
  return where;
}

export function tradingRoutes(db: Database, market: MarketService, engine: TradingEngine, nav: NavService, cond: ConditionalEngine, margin: MarginService) {
  const r = Router();
  r.use(requireAuth);

  // Theo từng người dùng (sau requireAuth nên luôn có user id)
  const orderLimiter = limiter({
    windowMs: 60_000,
    limit: config.rateLimit.ordersPerMinute,
    message: 'Bạn đặt lệnh quá nhanh, vui lòng chậm lại',
  });

  /* ------------------------------ tài khoản ------------------------------ */

  /** Tài khoản tiền đầy đủ: tiền mặt, chờ về, có thể ứng, ký quỹ (tỷ lệ thực tế), quyền chờ về */
  const accountDTO = async (userId: string) => {
    const s = await margin.summary(userId);
    const rights = (await nav.rightsValue([userId])).get(userId) ?? 0;
    const hasDebt = s.metrics.debt > 0;
    return {
      ...toAccountDTO(s.account as unknown as AccountRow),
      advanceable: s.advance.maxNet,
      marginRatio: hasDebt ? Math.round(s.metrics.ratio * 10_000) / 10_000 : null,
      marginStatus: s.metrics.status,
      marginCallAmount: s.metrics.callAmount,
      rightsValue: rights,
    };
  };

  r.get(
    '/account',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await accountDTO(user.id));
    }),
  );

  /** Ứng trước tiền bán: xem trước (GET) / thực hiện (POST {amount} = số tiền muốn thực nhận) */
  r.get(
    '/account/advance',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await previewAdvance(db, user.id, market.tradeDate));
    }),
  );

  r.post(
    '/account/advance',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { amount } = z.object({ amount: z.number().int().positive('Nhập số tiền cần ứng') }).strict().parse(req.body);
      const done = await db.tx(async (tx) => {
        await tx.one('SELECT user_id FROM accounts WHERE user_id = $1 FOR UPDATE', [user.id]);
        const p = await previewAdvance(tx, user.id, market.tradeDate);
        if (amount > p.maxNet) throw badRequest('ADVANCE_LIMIT', `Chỉ ứng được tối đa ${p.maxNet.toLocaleString('en-US')}đ (đã trừ phí)`);
        return advanceCash(tx, user.id, amount, market.tradeDate);
      });
      res.json(done);
    }),
  );

  r.put(
    '/account/settings',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { autoAdvance } = z.object({ autoAdvance: z.boolean() }).strict().parse(req.body);
      await margin.setAutoAdvance(user.id, autoAdvance);
      res.json(await accountDTO(user.id));
    }),
  );

  /** Kích hoạt / tắt giao dịch ký quỹ (bắt buộc xác nhận đã đọc cảnh báo rủi ro) */
  r.post(
    '/account/margin',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const body = z.object({ enabled: z.boolean(), acceptRisk: z.boolean().optional() }).strict().parse(req.body);
      if (body.enabled && !body.acceptRisk) throw badRequest('ACCEPT_RISK', 'Vui lòng xác nhận đã hiểu rủi ro của giao dịch ký quỹ');
      await margin.setEnabled(user.id, body.enabled);
      res.json(await accountDTO(user.id));
    }),
  );

  r.post(
    '/account/margin/repay',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { amount } = z.object({ amount: z.number().int().positive().nullable() }).strict().parse(req.body);
      const paid = await margin.repay(user.id, amount);
      res.json({ ...paid, account: await accountDTO(user.id) });
    }),
  );

  /** Sức mua tối đa cho 1 mã ở 1 mức giá (tính cả ứng trước và vay ký quỹ) */
  r.get(
    '/account/buying-power',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const q = z.object({ symbol: z.string().trim().toUpperCase(), price: z.coerce.number().int().positive() }).parse(req.query);
      res.json(await margin.buyingPower(user.id, q.symbol, q.price));
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

  r.get(
    '/portfolio',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const account = await accountDTO(user.id);
      const holdings = await db.many<HoldingRow>('SELECT * FROM holdings WHERE user_id = $1 ORDER BY symbol', [user.id]);
      const agg = await db.one<{ realized: number; fees: number; taxes: number }>(
        `SELECT COALESCE(SUM(realized_pnl), 0)::bigint AS realized, COALESCE(SUM(fee), 0)::bigint AS fees, COALESCE(SUM(tax), 0)::bigint AS taxes
         FROM trades WHERE user_id = $1`,
        [user.id],
      );
      const items = holdings.map((h) => {
        const dto = toHoldingDTO(h);
        const price = market.markPrice(h.symbol);
        return { ...dto, marketPrice: price, marketValue: price * h.qty_total };
      });
      res.json({
        account,
        holdings: items,
        realizedPnl: agg?.realized ?? 0,
        totalFees: agg?.fees ?? 0,
        totalTaxes: agg?.taxes ?? 0,
      });
    }),
  );

  /** Tài sản ròng theo ngày + VN-Index cùng kỳ để so sánh hiệu quả đầu tư */
  r.get(
    '/portfolio/nav',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { range } = z.object({ range: z.enum(['1M', '3M', '6M', '1Y', 'ALL']).default('3M') }).parse(req.query);
      const td = market.tradeDate;
      // Tài khoản có từ trước khi có tính năng này: dựng lại lịch sử từ sao kê + lịch sử khớp (1 lần)
      if (!(await db.one('SELECT 1 FROM nav_daily WHERE user_id = $1 AND trade_date < $2', [user.id, td]))) await nav.backfill(user.id);
      const days = { '1M': 30, '3M': 90, '6M': 182, '1Y': 365, ALL: 0 }[range];
      const since = days ? addDays(td, -days) : '1900-01-01';
      const rows = await db.many<{ d: string; nav: number; cash: number; stock_value: number; debt: number; contributed: number }>(
        `SELECT trade_date::text AS d, nav, cash, stock_value, debt, contributed FROM nav_daily
         WHERE user_id = $1 AND trade_date >= $2 AND trade_date < $3 ORDER BY trade_date`,
        [user.id, since, td],
      );
      const cur = (await nav.current([user.id])).get(user.id);
      const points = rows.map((x) => ({ date: x.d, nav: Number(x.nav), cash: Number(x.cash), stock: Number(x.stock_value), debt: Number(x.debt), contributed: Number(x.contributed) }));
      if (cur) points.push({ date: td, nav: cur.nav, cash: cur.cash, stock: cur.stock + cur.rights, debt: cur.debt, contributed: cur.contributed });
      const from = points[0]?.date ?? td;
      const idx = await db.many<{ d: string; close: number }>(
        `SELECT trade_date::text AS d, close FROM index_daily WHERE code = 'VNINDEX' AND trade_date >= $1 AND trade_date < $2 ORDER BY trade_date`,
        [from, td],
      );
      const live = market.indexSnapshots().find((i) => i.code === 'VNINDEX')?.value;
      const benchmark = idx.map((x) => ({ date: x.d, value: Number(x.close) }));
      if (live) benchmark.push({ date: td, value: live });
      res.json({ points, benchmark });
    }),
  );

  /* ------------------------------ lệnh ------------------------------ */

  r.get(
    '/orders',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const q = historyQuery.parse(req.query);
      const params: unknown[] = [user.id];
      const where = ['user_id = $1'];
      if (q.scope === 'open') where.push(`status IN ('PENDING','PARTIAL')`);
      if (q.scope === 'today') {
        params.push(market.tradeDate);
        where.push(`trade_date = $${params.length}`);
      }
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
      const rows = await db.many<OrderRow>(`SELECT * FROM orders WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 1000`, params);
      res.json(rows.map(toOrderDTO));
    }),
  );

  /** REQUIRE_EMAIL_VERIFICATION=true: phải xác thực email trước khi đặt lệnh */
  const assertVerified = async (userId: string) => {
    if (config.requireEmailVerification && !(await isEmailVerified(userId))) {
      throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Vui lòng xác thực email trước khi đặt lệnh (kiểm tra hộp thư hoặc bấm "Gửi lại email xác thực")');
    }
  };

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

  r.patch(
    '/orders/:id',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = modifyOrderSchema.parse(req.body);
      res.json(await engine.modifyOrder(user.id, idParam(req.params.id), input));
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

  /* ------------------------------ lệnh điều kiện ------------------------------ */

  r.get(
    '/conditional-orders',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { scope } = z.object({ scope: z.enum(['active', 'all']).default('active') }).parse(req.query);
      res.json(await cond.list(user.id, scope));
    }),
  );

  r.post(
    '/conditional-orders',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      await assertVerified(user.id);
      const input = conditionalOrderSchema.parse(req.body);
      res.status(201).json(await cond.create(user.id, input));
    }),
  );

  r.delete(
    '/conditional-orders/:id',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      res.json(await cond.cancel(user.id, idParam(req.params.id)));
    }),
  );

  /* ------------------------------ lịch sử ------------------------------ */

  r.get(
    '/trades',
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
      const rows = await db.many<TradeRow>(`SELECT * FROM trades WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 2000`, params);
      res.json(rows.map(toTradeDTO));
    }),
  );

  r.get(
    '/ledger',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const q = historyQuery.parse(req.query);
      const params: unknown[] = [user.id];
      const where = ['user_id = $1', ...dateFilters('created_at', q.from, q.to, params)];
      const rows = await db.many<LedgerRow>(
        `SELECT * FROM transactions_ledger WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 2000`,
        params,
      );
      res.json(rows.map(toLedgerDTO));
    }),
  );

  /* ------------------------------ báo cáo ------------------------------ */

  r.get(
    '/reports/monthly',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const thisYear = Number(market.tradeDate.slice(0, 4));
      const { year } = z.object({ year: z.coerce.number().int().min(2000).max(2100).default(thisYear) }).parse(req.query);
      res.json(await monthlyReport(db, user.id, year));
    }),
  );

  // Danh sách theo dõi: routes/watchlists.ts

  return r;
}
