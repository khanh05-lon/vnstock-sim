import { isStaff } from '@vss/shared';
import fs from 'node:fs';
import http from 'node:http';
import cors from 'cors';
import express from 'express';
import helmet from 'helmet';
import { Server } from 'socket.io';
import { config } from './config';
import { Database } from './db';
import { installAdmin } from './admin';
import { deskRoutes } from './support/desk';
import { SupportService } from './support/service';
import { SupportAssistant, claudeBackend } from './support/ai';
import { supportRoutes } from './routes/support';
import { initSessionCheck } from './lib/auth';
import { errorHandler, notFound } from './lib/errors';
import { log, requestLogger } from './lib/logger';
import { createMailer } from './lib/mailer';
import { limiter } from './lib/rateLimit';
import { serveFrontend } from './lib/static';
import { BinanceRest } from './market/binance/rest';
import { MarketService } from './market/marketService';
import { seedSymbols } from './market/symbols';
import { migrate } from './migrate';
import { AlertMonitor } from './ops/alerts';
import { FillDigest } from './ops/fillDigest';
import { metrics } from './ops/metrics';
import { NavService } from './portfolio/nav';
import { alertRoutes } from './routes/alerts';
import { authRoutes } from './routes/auth';
import { communityRoutes } from './routes/community';
import { marketRoutes } from './routes/market';
import { tradingRoutes } from './routes/trading';
import { watchlistRoutes } from './routes/watchlists';
import { seedDemoUser } from './seed/seed';
import { attachSocket, socketNotifier } from './socket';
import { SpotEngine } from './trading/engine';
import { PriceAlertService } from './trading/priceAlerts';
import { BankService } from './p2p/bank';
import { p2pRoutes } from './p2p/routes';
import { seedDevMerchants } from './p2p/seed';
import { squareModerationEmail } from './lib/emails';
import { sendLater } from './routes/auth';
import { squareRoutes } from './square/routes';
import { seedDevSquare } from './square/seed';
import { SquareService } from './square/service';
import { P2PService } from './p2p/service';
import { startAmlSchedule } from './kyc/aml';
import { kycRoutes } from './kyc/routes';
import { KycService } from './kyc/service';
import { privacyRoutes } from './privacy/routes';
import { PrivacyService } from './privacy/service';
import { VipService, vipRoutes } from './trading/vip';

async function main() {
  const started = Date.now();
  const db = await openDatabase();
  if (config.migrateOnStart) await migrate(db);
  initSessionCheck(db);

  const rest = config.marketFeed === 'binance' ? new BinanceRest({ baseUrls: config.binance.restUrls }) : null;
  await seedSymbols(db, rest);
  await seedDemoUser(db, config.demoEmail, config.demoPassword);

  const market = new MarketService(db, rest, {
    feed: config.marketFeed,
    wsUrl: config.binance.wsUrl,
    flushMs: config.flushMs,
    simAfterMs: config.binance.simAfterMs,
  });
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
  if (mailer.kind === 'log') log.warn('[mail] SMTP chưa cấu hình (SMTP_HOST), link đặt lại mật khẩu sẽ được ghi ra log thay vì gửi email');

  const server = http.createServer(app);
  const io = new Server(server, { cors: { origin: config.corsOrigin } });

  const digest = new FillDigest(db, mailer);
  const engine = new SpotEngine(
    db,
    market,
    socketNotifier(io, (userId, f) => {
      metrics.recordFill(Number(f.quoteQty));
      digest.push(userId, f);
    }),
  );
  metrics.socketCount = () => io.engine.clientsCount;
  market.on('tickers', () => (metrics.lastTickAt = Date.now()));
  const alerts = new AlertMonitor(db, mailer, {
    emails: config.alertEmails,
    webhookUrl: config.alertWebhookUrl,
    thresholds: config.alertThresholds,
    feedLost: () => config.marketFeed === 'binance' && market.feed() === 'SIM',
    supportOverdue: () => support.overdueCount(),
  });
  // Hỗ trợ khách hàng: khách nhận sự kiện ở phòng user:<id>, nhân viên ở phòng "staff"
  const support = new SupportService(db, mailer);
  support.notifyCustomer = (userId, ev) => io.to(`user:${userId}`).emit('support', ev);
  support.notifyStaff = (ev) => io.to('staff').emit('support:staff', ev);
  await engine.load();
  // Chợ P2P + ngân hàng giả lập: khách ở phòng user:<id>, nhân viên xử lý khiếu nại ở phòng "staff"
  const bank = new BankService(db);
  const p2p = new P2PService(db, market, {
    user: (userId, payload) => io.to(`user:${userId}`).emit('p2p', payload),
    staff: (payload) => io.to('staff').emit('p2p:staff', payload),
    account: (userId) => io.to(`user:${userId}`).emit('account'),
  });
  engine.userCleanup.push((userId, reason) => p2p.onUserCleanup(userId, reason));
  engine.resetGuards.push((userId) => p2p.assertCanReset(userId));
  // Xác minh danh tính (KYC) + giám sát chống rửa tiền (AML)
  const kyc = new KycService(db, mailer);
  // Cấp VIP phí: tính lại 00:00 UTC hằng ngày
  const vip = new VipService(db);
  vip.notify = (userId) => io.to(`user:${userId}`).emit('account');
  const nav = new NavService(db, market);
  // Cộng đồng (kiểu Binance Square) + kiểm duyệt nội dung
  const square = new SquareService({
    db,
    market: {
      listedAssets: () => [...new Set(market.symbols().map((s) => market.info(s)?.baseAsset).filter((x): x is string => !!x))],
      lastPrice: (s) => market.lastPrice(s),
    },
    roiOf: async (userId) => {
      const fills = await db.one<{ n: number }>('SELECT count(*)::int AS n FROM fills WHERE user_id = $1', [userId]);
      if (!fills?.n) return null;
      const n = (await nav.current([userId])).get(userId);
      return n && n.contributed > 0 ? ((n.nav - n.contributed) / n.contributed) * 100 : null;
    },
    notify: (userId) => io.to(`user:${userId}`).emit('square'),
    emailUser: async (userId, title, lines) => {
      const u = await db.one<{ email: string; full_name: string; status: string }>('SELECT email, full_name, status FROM users WHERE id = $1', [userId]);
      if (u && u.status !== 'DELETED') sendLater(mailer, u.email, squareModerationEmail(u.full_name, title, lines), { userId });
    },
  });
  const priceAlerts = new PriceAlertService(db, {
    info: (s) => market.info(s),
    quoteOf: (s) => {
      const t = market.state(s)?.ticker;
      return t && t.last !== '0' ? { last: t.last, changePct: t.changePct } : null;
    },
  }, mailer);
  priceAlerts.notify = (userId, alert, message) => io.to(`user:${userId}`).emit('alert', { alert, message });
  await priceAlerts.load();
  // Cặp bị gỡ khỏi sàn → huỷ cảnh báo của cặp đó
  market.on('symbols', () => void priceAlerts.cancelMissingSymbols().catch((err) => log.error('[alert] lỗi huỷ cảnh báo cặp ngừng giao dịch', { err })));
  market.hooks = {
    onTick: async (changed, trades) => {
      await engine.onTick(changed, trades);
      await priceAlerts.onTick(new Set([...changed, ...trades.keys()]));
    },
  };

  // Quản trị & vận hành (phải đứng trước các route /api khác: chặn tài khoản bị khoá)
  const store = await installAdmin({
    app,
    io,
    db,
    market,
    p2p,
    kyc,
    vip,
    square,
    engine,
    mailer,
    alerts,
    rest,
    onRestored: async () => {
      await priceAlerts.load();
    },
    // Kết quả duyệt điều chỉnh số dư → báo vào yêu cầu hỗ trợ liên quan
    onAdjustDecided: async (r) => {
      if (!r.ticketId) return;
      const approved = r.status === 'APPROVED';
      await support.postSystem(
        r.ticketId,
        `Yêu cầu điều chỉnh #${r.id} (${r.amount} ${r.asset}) ${approved ? 'đã được duyệt' : 'bị từ chối'} bởi ${r.decidedByEmail}${r.decisionNote ? `: ${r.decisionNote}` : ''}`,
        true,
      );
      if (approved) await support.postSystem(r.ticketId, `Số dư của bạn đã được điều chỉnh ${r.amount} ${r.asset}`, false);
    },
  });
  app.use('/api/support-desk', deskRoutes({ db, io, market, engine, store, mailer, support, p2p }));

  // Chỉ số Prometheus: cần METRICS_TOKEN (production không có token → tắt)
  app.get('/api/metrics', (req, res, next) => {
    const token = (req.headers.authorization ?? '').replace(/^Bearer /, '');
    if (config.metricsToken ? token !== config.metricsToken : config.isProd) return next(notFound('API không tồn tại'));
    res.type('text/plain; version=0.0.4').send(metrics.prometheus({ open_orders: engine.openOrderCount(), active_alerts: alerts.active.size }));
  });

  app.get('/api/health', async (_req, res) => {
    // Dùng cho healthcheck của Docker / giám sát: 503 khi mất kết nối CSDL
    const dbOk = await Promise.race([
      db.one('SELECT 1').then(
        () => true,
        () => false,
      ),
      new Promise<boolean>((resolve) => setTimeout(resolve, 3000, false)),
    ]);
    res.status(dbOk ? 200 : 503).json({
      ok: dbOk,
      db: { kind: db.kind, ok: dbOk },
      uptimeSec: Math.round(process.uptime()),
      source: config.marketFeed,
      feed: market.feed(),
      symbols: market.symbols().length,
      openOrders: engine.openOrderCount(),
    });
  });
  app.use('/api/auth', authRoutes(db, mailer));
  app.use('/api/market', marketRoutes(market));
  app.use('/api', communityRoutes(db, nav, market));
  app.use('/api', watchlistRoutes(db));
  app.use('/api', alertRoutes(priceAlerts));
  const assistant = new SupportAssistant(db, market, config.ai.apiKey ? claudeBackend(config.ai.apiKey, config.ai.model) : null);
  log.info(`[ai] trợ lý hỗ trợ: ${assistant.enabled ? `bật (${config.ai.model})` : 'tắt — chưa đặt ANTHROPIC_API_KEY'}`);
  app.use('/api', supportRoutes(support, assistant));
  app.use('/api', p2pRoutes(p2p, bank));
  app.use('/api', kycRoutes(kyc));
  app.use('/api', privacyRoutes(new PrivacyService(db)));
  app.use('/api', vipRoutes(vip));
  app.use('/api', squareRoutes(square));
  app.use('/api', tradingRoutes(db, market, engine, nav));
  app.use('/api', (_req, _res, next) => next(notFound('API không tồn tại')));
  if (frontend) app.use(frontend.router);
  app.use(errorHandler);

  attachSocket(io, market);
  // Nhân viên (quản trị, CSKH) vào phòng "staff" để nhận yêu cầu hỗ trợ mới theo thời gian thực
  io.on('connection', (socket) => {
    const u = socket.data.user as { id: string } | undefined;
    if (!u) return;
    db.one<{ role: string; status: string }>('SELECT role, status FROM users WHERE id = $1', [u.id]).then(
      (row) => {
        if (row && row.status === 'ACTIVE' && isStaff(row.role)) void socket.join('staff');
      },
      () => undefined,
    );
  });
  market.start();
  await nav.snapshotAll().catch((err) => log.error('[nav] lỗi chụp tổng tài sản lúc khởi động', { err }));
  nav.start();
  metrics.startSampling();
  alerts.start();
  support.start();
  p2p.start();
  const stopAml = startAmlSchedule(db);
  vip.start();
  await seedDevMerchants(db, p2p).catch((err) => log.error('[p2p] lỗi tạo thương nhân mẫu', { err }));
  await seedDevSquare(db).catch((err) => log.error('[square] lỗi tạo bài mẫu', { err }));
  if (!config.alertEmails.length && !config.alertWebhookUrl) log.warn('[alert] chưa cấu hình ALERT_EMAILS / ALERT_WEBHOOK_URL, cảnh báo chỉ ghi log và hiện ở trang Quản trị');

  server.listen(config.port, () => {
    log.info(
      `[api] http://localhost:${config.port}  •  nguồn ${config.marketFeed === 'binance' ? 'Binance (dự phòng giả lập)' : 'giả lập'}  •  ${market.symbols().length} cặp  •  CSDL ${db.kind}  •  khởi động ${Date.now() - started}ms`,
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
    alerts.stop();
    support.stop();
    p2p.stop();
    stopAml();
    vip.stop();
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
  if (config.isProd) log.warn('[db] production đang dùng PGlite nhúng, nên đặt DATABASE_URL tới PostgreSQL thật');
  fs.mkdirSync(config.dataDir, { recursive: true });
  return Database.open(config.dataDir);
}

main().catch((err) => {
  log.error('[api] khởi động thất bại', { err });
  process.exit(1);
});
