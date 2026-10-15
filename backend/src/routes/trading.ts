import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { modifyOrderSchema, placeOrderSchema } from '@vss/shared';
import type { Database } from '../db';
import { requireAuth, type AuthedRequest } from '../lib/auth';
import { ah, badRequest, notFound } from '../lib/errors';
import type { MarketService } from '../market/marketService';
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

export function tradingRoutes(db: Database, market: MarketService, engine: TradingEngine) {
  const r = Router();
  r.use(requireAuth);

  const orderLimiter = rateLimit({
    windowMs: 60_000,
    limit: 120,
    standardHeaders: 'draft-7',
    legacyHeaders: false,
    message: { error: { code: 'RATE_LIMIT', message: 'Bạn đặt lệnh quá nhanh, vui lòng chậm lại' } },
  });

  /* ------------------------------ tài khoản ------------------------------ */

  r.get(
    '/account',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const acct = await db.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1', [user.id]);
      if (!acct) throw notFound('Không tìm thấy tài khoản');
      res.json(toAccountDTO(acct));
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
      const acct = await db.one<AccountRow>('SELECT * FROM accounts WHERE user_id = $1', [user.id]);
      if (!acct) throw notFound('Không tìm thấy tài khoản');
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
        account: toAccountDTO(acct),
        holdings: items,
        realizedPnl: agg?.realized ?? 0,
        totalFees: agg?.fees ?? 0,
        totalTaxes: agg?.taxes ?? 0,
      });
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

  r.post(
    '/orders',
    orderLimiter,
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const input = placeOrderSchema.parse(req.body);
      res.status(201).json(await engine.placeOrder(user.id, input));
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
      res.json(await engine.cancelOrder(user.id, idParam(req.params.id)));
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

  /* ------------------------------ watchlist ------------------------------ */

  r.get(
    '/watchlist',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const rows = await db.many<{ symbol: string }>('SELECT symbol FROM watchlists WHERE user_id = $1 ORDER BY created_at', [user.id]);
      res.json(rows.map((x) => x.symbol));
    }),
  );

  r.post(
    '/watchlist',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      const { symbol } = z.object({ symbol: z.string().trim().toUpperCase() }).strict().parse(req.body);
      if (!market.quote(symbol)) throw notFound('Mã chứng khoán không tồn tại');
      const count = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM watchlists WHERE user_id = $1', [user.id]);
      if ((count?.n ?? 0) >= 100) throw badRequest('WATCHLIST_FULL', 'Danh sách theo dõi tối đa 100 mã');
      await db.many('INSERT INTO watchlists (user_id, symbol) VALUES ($1, $2) ON CONFLICT DO NOTHING', [user.id, symbol]);
      res.status(201).json({ ok: true });
    }),
  );

  r.delete(
    '/watchlist/:symbol',
    ah(async (req, res) => {
      const { user } = req as AuthedRequest;
      await db.many('DELETE FROM watchlists WHERE user_id = $1 AND symbol = $2', [user.id, req.params.symbol.toUpperCase()]);
      res.json({ ok: true });
    }),
  );

  return r;
}
