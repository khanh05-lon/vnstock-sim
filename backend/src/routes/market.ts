import { Router } from 'express';
import { KLINE_INTERVALS, type KlineInterval } from '@vss/shared';
import { ah, badRequest, notFound } from '../lib/errors';
import type { MarketService } from '../market/marketService';

/** API thị trường công khai (không cần đăng nhập) */
export function marketRoutes(market: MarketService) {
  const r = Router();

  const symbolOf = (raw: string) => {
    const s = raw.toUpperCase();
    if (!market.info(s)) throw notFound(`Cặp ${s} không tồn tại`);
    return s;
  };

  r.get('/status', (_req, res) => {
    res.json(market.status());
  });

  /** Danh sách cặp kèm ticker 24h */
  r.get('/symbols', (_req, res) => {
    res.json(market.rows());
  });

  r.get('/tickers', (_req, res) => {
    res.json(market.tickers());
  });

  r.get(
    '/symbols/:symbol',
    ah(async (req, res) => {
      const symbol = symbolOf(req.params.symbol!);
      const s = market.state(symbol)!;
      res.json({ ...s.info, ...s.ticker, avgPrice: market.avgPrice(symbol) });
    }),
  );

  r.get(
    '/depth/:symbol',
    ah(async (req, res) => {
      const limit = Math.min(Math.max(Number(req.query.limit) || 20, 5), 20);
      res.json(market.depth(symbolOf(req.params.symbol!), limit));
    }),
  );

  r.get(
    '/trades/:symbol',
    ah(async (req, res) => {
      res.json(market.recentTrades(symbolOf(req.params.symbol!)));
    }),
  );

  r.get(
    '/klines/:symbol',
    ah(async (req, res) => {
      const symbol = symbolOf(req.params.symbol!);
      const interval = String(req.query.interval ?? '1h') as KlineInterval;
      if (!KLINE_INTERVALS.includes(interval)) throw badRequest('INTERVAL', 'Khung thời gian không hợp lệ');
      const limit = Math.min(Math.max(Number(req.query.limit) || 500, 10), 1000);
      const endTime = req.query.endTime ? Number(req.query.endTime) : undefined;
      if (endTime != null && !Number.isFinite(endTime)) throw badRequest('END_TIME', 'endTime không hợp lệ');
      res.json(await market.candles(symbol, interval, limit, endTime));
    }),
  );

  return r;
}
