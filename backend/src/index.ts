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
import type { MarketDataProvider } from './market/types';
import { VnstockClient } from './market/vnstock/client';
import { syncRealHistory } from './market/vnstock/history';
import { RealProvider } from './market/vnstock/realProvider';
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
  const provider = await createProvider(db);
  await seedDemoUser(db, config.demoEmail, config.demoPassword, config.marketMode);

  const market = new MarketService(db, provider, { mode: config.marketMode, tickIntervalMs: config.tickIntervalMs });
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
    res.json({
      ok: true,
      mode: config.marketMode,
      provider: provider.name,
      feed: market.feed(),
      tradeDate: market.tradeDate,
      phase: market.phase,
      openOrders: engine.openOrderCount(),
    });
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
      `[api] http://localhost:${config.port}  •  chế độ ${config.marketMode}  •  nguồn ${provider.name} (${market.feed()})  •  ngày GD ${market.tradeDate}  •  khởi động ${Date.now() - started}ms`,
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

/** MARKET_PROVIDER=vnstock: nạp lịch sử nến ngày thật rồi dùng RealProvider; mặc định dùng giả lập */
async function createProvider(db: Database): Promise<MarketDataProvider> {
  if (config.marketProvider !== 'vnstock') return new MockProvider();
  const { url, pollMs, staleMs, historyDays, maxRequestsPerMinute } = config.vnstock;
  const client = new VnstockClient(url, { maxPerMinute: maxRequestsPerMinute });
  if (!(await client.waitReady(20_000))) console.warn(`[vnstock] data-service ${url} chưa phản hồi — hãy chạy \`npm run data-service\``);
  try {
    const r = await syncRealHistory(db, client, { mode: config.marketMode, days: historyDays });
    if (r.bars) {
      console.log(`[vnstock] lịch sử thật: ${r.stocks} mã, ${r.indices} chỉ số, ${r.bars} nến (${r.full ? 'nạp toàn bộ' : `bù ${r.days} phiên`})`);
    }
    if (r.missing.length) console.warn(`[vnstock] nguồn không có lịch sử cho: ${r.missing.join(', ')} — giữ dữ liệu giả lập`);
  } catch (err) {
    console.warn(`[vnstock] không tải được lịch sử từ ${url} (${err instanceof Error ? err.message : err}) — dùng lịch sử đang có trong CSDL`);
  }
  return new RealProvider(client, { mode: config.marketMode, pollMs, staleMs });
}

main().catch((err) => {
  console.error('[api] khởi động thất bại', err);
  process.exit(1);
});
