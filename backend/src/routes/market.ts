import { Router } from 'express';
import { ah, badRequest, notFound } from '../lib/errors';
import { TIMEFRAMES, type MarketService, type Timeframe } from '../market/marketService';

export function marketRoutes(market: MarketService) {
  const r = Router();

  r.get('/session', (_req, res) => {
    res.json(market.session());
  });

  r.get('/stocks', (_req, res) => {
    res.json(market.rows());
  });

  r.get('/stocks/:symbol', (req, res, next) => {
    const s = market.quote(req.params.symbol.toUpperCase());
    if (!s) return next(notFound('Mã chứng khoán không tồn tại'));
    res.json({ ...s.info, ...market.snapshot(s), trades: market.recentTrades(s.info.symbol) });
  });

  r.get(
    '/stocks/:symbol/candles',
    ah(async (req, res) => {
      const symbol = req.params.symbol.toUpperCase();
      if (!market.quote(symbol)) throw notFound('Mã chứng khoán không tồn tại');
      const tf = String(req.query.tf ?? '1D') as Timeframe;
      if (!TIMEFRAMES.includes(tf)) throw badRequest('TF', 'Khung thời gian không hợp lệ');
      res.json(await market.candles(symbol, tf));
    }),
  );

  r.get('/indices', (_req, res) => {
    res.json(market.indexSnapshots());
  });

  r.get(
    '/indices/:code/history',
    ah(async (req, res) => {
      const tf = req.query.tf === '1m' ? '1m' : '1D';
      res.json(await market.indexHistory(req.params.code.toUpperCase(), tf));
    }),
  );

  return r;
}
