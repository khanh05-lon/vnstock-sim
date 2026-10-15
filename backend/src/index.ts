import fs from 'node:fs';
import http from 'node:http';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { config } from './config';
import { Database } from './db';
import { initSessionCheck } from './lib/auth';
import { errorHandler, notFound } from './lib/errors';
import { log, requestLogger } from './lib/logger';
import { createMailer } from './lib/mailer';
import { limiter } from './lib/rateLimit';
import { serveFrontend } from './lib/static';
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
  const db = await openDatabase();
  if (config.migrateOnStart) await migrate(db);
  initSessionCheck(db);
  await seedMarket(db, config.marketMode);
  const provider = await createProvider(db);
  await seedDemoUser(db, config.demoEmail, config.demoPassword, config.marketMode);

  const market = new MarketService(db, provider, { mode: config.marketMode, tickIntervalMs: config.tickIntervalMs });
  await market.init();

  const app = express();
  app.disable('x-powered-by');
  // Sau reverse proxy (Caddy/Nginx): lấy IP thật từ X-Forwarded-For cho rate limit và log
  app.set('trust proxy', config.trustProxy);
  const frontend = config.frontendDist ? serveFrontend(config.frontendDist) : null;
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: {
          // script inline duy nhất trong index.html (chọn theme) được cho phép theo hash
          scriptSrc: ["'self'", ...(frontend?.inlineScriptHashes ?? [])],
          connectSrc: ["'self'", 'ws:', 'wss:'],
          upgradeInsecureRequests: config.publicUrl.startsWith('https://') ? [] : null,
        },
      },
    }),
  );
  app.use(requestLogger);
  app.use(cors({ origin: config.corsOrigin }));
  app.use(express.json({ limit: '50kb' }));
  app.use(
    '/api',
    limiter({
      windowMs: 60_000,
      limit: config.rateLimit.apiPerMinute,
      message: 'Bạn thao tác quá nhanh, vui lòng thử lại sau ít giây',
    }),
  );
  const mailer = createMailer(config);
  if (mailer.kind === 'log') log.warn('[mail] SMTP chưa cấu hình (SMTP_HOST) — link đặt lại mật khẩu sẽ được ghi ra log thay vì gửi email');

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

  app.get('/api/health', async (_req, res) => {
    // Dùng cho healthcheck của Docker / giám sát: 503 khi mất kết nối CSDL
    const dbOk = await Promise.race([
      db.one('SELECT 1').then(() => true, () => false),
      new Promise<boolean>((resolve) => setTimeout(resolve, 3000, false)),
    ]);
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      db: { kind: db.kind, ok: dbOk },
      uptimeSec: Math.round(process.uptime()),
      mode: config.marketMode,
      provider: provider.name,
      feed: market.feed(),
      tradeDate: market.tradeDate,
      phase: market.phase,
      openOrders: engine.openOrderCount(),
    });
  });
  app.use('/api/auth', authRoutes(db, mailer));
  app.use('/api/market', marketRoutes(market));
  app.use('/api', tradingRoutes(db, market, engine));
  app.use('/api', (_req, _res, next) => next(notFound('API không tồn tại')));
  if (frontend) app.use(frontend.router);
  app.use(errorHandler);

  attachSocket(io, market);
  market.start();

  server.listen(config.port, () => {
    log.info(
      `[api] http://localhost:${config.port}  •  chế độ ${config.marketMode}  •  nguồn ${provider.name} (${market.feed()})  •  CSDL ${db.kind}  •  ngày GD ${market.tradeDate}  •  khởi động ${Date.now() - started}ms`,
      { port: config.port, db: db.kind, frontend: !!frontend, env: config.isProd ? 'production' : 'development' },
    );
  });

  let closing = false;
  const shutdown = async () => {
    if (closing) return;
    closing = true;
    log.info('[api] đang tắt...');
    setTimeout(() => process.exit(1), 10_000).unref();
    io.close();
    server.close();
    await market.stop();
    await db.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

/** DATABASE_URL → PostgreSQL thật (production); không có → PGlite nhúng trong DATA_DIR (dev) */
async function openDatabase(): Promise<Database> {
  if (config.databaseUrl) {
    return Database.connect(config.databaseUrl, {
      max: config.dbPoolMax,
      onError: (err) => log.error('[db] lỗi kết nối Postgres', { err }),
    });
  }
  if (config.isProd) log.warn('[db] production đang dùng PGlite nhúng — nên đặt DATABASE_URL tới PostgreSQL thật');
  fs.mkdirSync(config.dataDir, { recursive: true });
  return Database.open(config.dataDir);
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
  log.error('[api] khởi động thất bại', { err });
  process.exit(1);
});
