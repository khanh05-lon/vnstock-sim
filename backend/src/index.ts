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
import { alertRoutes } from './routes/alerts';
import { communityRoutes } from './routes/community';
import { tradingRoutes } from './routes/trading';
import { watchlistRoutes } from './routes/watchlists';
import { PriceAlertService } from './trading/priceAlerts';
import { NavService } from './portfolio/nav';
import { AlertMonitor } from './ops/alerts';
import { FillDigest } from './ops/fillDigest';
import { metrics } from './ops/metrics';
import { phaseAt } from './lib/calendar';
import { seedDemoUser, seedMarket } from './seed/seed';
import { attachSocket, socketNotifier } from './socket';
import { TradingEngine } from './trading/engine';
import { ConditionalEngine } from './trading/conditional';
import { MarginService } from './trading/margin';
import { CorporateService } from './corporate/service';
import { seedInstruments } from './market/instruments';
import { corporateRoutes } from './routes/corporate';
import { currentTradeDate, skipWeekendsFor } from './lib/calendar';
import { installAdmin } from './admin';

async function main() {
  const started = Date.now();
  const db = await openDatabase();
  if (config.migrateOnStart) await migrate(db);
  initSessionCheck(db);
  await seedMarket(db, config.marketMode);
  // ETF, chứng quyền, trái phiếu mẫu (chỉ thêm mã chưa có)
  await seedInstruments(db, currentTradeDate(Date.now(), config.marketMode), skipWeekendsFor(config.marketMode));
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
  app.use(metrics.http_);
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

  const digest = new FillDigest(db, mailer);
  const engine = new TradingEngine(
    db,
    market,
    socketNotifier(io, (userId, t) => {
      metrics.recordFill(t.value);
      digest.push(userId, t);
    }),
    { settlementDays: config.settlementDays },
  );
  metrics.socketCount = () => io.engine.clientsCount;
  market.on('indices', () => (metrics.lastTickAt = Date.now()));
  const alerts = new AlertMonitor(db, mailer, {
    emails: config.alertEmails,
    webhookUrl: config.alertWebhookUrl,
    thresholds: config.alertThresholds,
    feedLost: () =>
      config.marketProvider === 'vnstock' && ['ATO', 'CONTINUOUS', 'ATC'].includes(phaseAt(Date.now(), 'REAL_HOURS')) && market.feed() === 'SIM',
  });
  await engine.load();
  const nav = new NavService(db, market);
  const cond = new ConditionalEngine(db, market, engine);
  cond.notify = (userId, dto) => io.to(`user:${userId}`).emit('conditional', dto);
  await cond.load();
  engine.userCleanup.push((userId, reason) => cond.cancelForUser(userId, reason));
  const corp = new CorporateService(db, market, engine, cond, () => !!provider.live);
  corp.notify = (userId) => io.to(`user:${userId}`).emit('account');
  nav.rightsValue = (ids) => corp.rightsValue(ids);
  const margin = new MarginService(db, market, engine, mailer);
  margin.notify = (userId, ev) => {
    io.to(`user:${userId}`).emit('margin', ev);
    io.to(`user:${userId}`).emit('account');
  };
  const priceAlerts = new PriceAlertService(db, market, mailer);
  priceAlerts.notify = (userId, alert, message) => io.to(`user:${userId}`).emit('alert', { alert, message });
  await priceAlerts.load();
  // Mã bị rút khỏi giao dịch (huỷ niêm yết, chứng quyền / trái phiếu đáo hạn) → huỷ cảnh báo của mã đó
  market.on('symbols', () => void priceAlerts.cancelMissingSymbols().catch((err) => log.error('[alert] lỗi huỷ cảnh báo mã ngừng giao dịch', { err })));
  market.hooks = {
    onTick: async (symbols, trades) => {
      await engine.onTick(symbols, trades);
      await cond.onTick(symbols);
      await priceAlerts.onTick(symbols);
    },
    onAuction: (kind, prices) => engine.onAuction(kind, prices),
    onDayEnd: async (tradeDate) => {
      await engine.expireAll();
      await cond.expire(tradeDate);
      // NAV cuối ngày theo giá đóng cửa
      await nav.snapshotAll(tradeDate);
    },
    onNewDay: async () => {
      await engine.settle();
      // lệnh nhiều ngày còn hiệu lực chuyển sang phiên mới (kiểm tra lại biên độ)
      await engine.carryOver();
      // sự kiện quyền (GDKHQ, thanh toán), chứng quyền / trái phiếu đáo hạn, lãi trái phiếu
      await corp.processDay();
      // lãi tiền gửi (trả đầu tháng) và lãi vay ký quỹ cộng dồn theo ngày
      await margin.accrueInterest();
    },
  };
  // Quản trị & vận hành (phải đứng trước các route /api khác: chặn tài khoản bị khoá)
  await installAdmin({
    app,
    io,
    db,
    market,
    engine,
    mailer,
    alerts,
    corp,
    margin,
    providerName: provider.name,
    settlementDays: config.settlementDays,
    onDelist: async (symbol, reason) => void (await cond.cancelForSymbol(symbol, `Mã ${symbol} huỷ niêm yết: ${reason}`)),
    onRestored: async () => {
      await cond.load();
      await priceAlerts.load();
    },
  });

  // Chỉ số Prometheus: cần METRICS_TOKEN (production không có token → tắt)
  app.get('/api/metrics', (req, res, next) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (config.metricsToken ? token !== config.metricsToken : config.isProd) return next(notFound('API không tồn tại'));
    res.type('text/plain; version=0.0.4').send(metrics.prometheus({ open_orders: engine.openOrderCount(), active_alerts: alerts.active.size }));
  });

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
  app.use('/api', communityRoutes(db, nav, market));
  app.use('/api', corporateRoutes(corp));
  app.use('/api', watchlistRoutes(db));
  app.use('/api', alertRoutes(priceAlerts));
  app.use('/api', tradingRoutes(db, market, engine, nav, cond, margin));
  app.use('/api', (_req, _res, next) => next(notFound('API không tồn tại')));
  if (frontend) app.use(frontend.router);
  app.use(errorHandler);

  attachSocket(io, market);
  // Bù xử lý sự kiện quyền / lãi nếu máy chủ tắt đúng lúc sang ngày mới
  await corp.processDay();
  await margin.accrueInterest();
  margin.start();
  market.start();
  await nav.snapshotAll().catch((err) => log.error('[nav] lỗi chụp NAV lúc khởi động', { err }));
  nav.start();
  metrics.startSampling();
  alerts.start();
  if (!config.alertEmails.length && !config.alertWebhookUrl) log.warn('[alert] chưa cấu hình ALERT_EMAILS / ALERT_WEBHOOK_URL — cảnh báo chỉ ghi log và hiện ở trang Quản trị');

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
    nav.stop();
    margin.stop();
    alerts.stop();
    metrics.stopSampling();
    await digest.flush().catch(() => undefined);
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
