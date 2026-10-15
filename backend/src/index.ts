import fs from 'node:fs';
import http from 'node:http';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { config } from './config';
import { Database } from './db';
import { errorHandler, notFound } from './lib/errors';
import { MarketService } from './market/marketService';
import { MockProvider } from './market/mockProvider';
import { migrate } from './migrate';
import { authRoutes } from './routes/auth';
import { marketRoutes } from './routes/market';
import { tradingRoutes } from './routes/trading';
import { seedDemoUser, seedMarket } from './seed/seed';
import { attachSocket, socketNotifier } from './socket';
import { TradingEngine } from './trading/engine';

async function main() {
  const started = Date.now();
  fs.mkdirSync(config.dataDir, { recursive: true });
  const db = await Database.open(config.dataDir);
  await migrate(db);
  await seedMarket(db, config.marketMode);
  await seedDemoUser(db, config.demoEmail, config.demoPassword, config.marketMode);

  const market = new MarketService(db, new MockProvider(), { mode: config.marketMode, tickIntervalMs: config.tickIntervalMs });
  await market.init();

  const app = express();
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '50kb' }));

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.corsOrigin } });

  const engine = new TradingEngine(db, market, socketNotifier(io), { settlementDays: config.settlementDays });
  await engine.load();
  market.hooks = {
    onTick: (symbols, trades) => engine.onTick(symbols, trades),
    onAuction: (kind, prices) => engine.onAuction(kind, prices),
    onDayEnd: () => engine.expireAll(),
    onNewDay: async () => {
      await engine.settle();
    },
  };

  app.get('/api/health', (_req, res) => {
    res.json({ ok: true, mode: config.marketMode, tradeDate: market.tradeDate, phase: market.phase, openOrders: engine.openOrderCount() });
  });
  app.use('/api/auth', authRoutes(db));
  app.use('/api/market', marketRoutes(market));
  app.use('/api', tradingRoutes(db, market, engine));
  app.use('/api', (_req, _res, next) => next(notFound('API không tồn tại')));
  app.use(errorHandler);

  attachSocket(io, market);
  market.start();

  server.listen(config.port, () => {
    console.log(
      `[api] http://localhost:${config.port}  •  chế độ ${config.marketMode}  •  ngày GD ${market.tradeDate}  •  khởi động ${Date.now() - started}ms`,
    );
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    console.log('[api] đang tắt...');
    io.close();
    await market.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((err) => {
  console.error('[api] khởi động thất bại', err);
  process.exit(1);
});
