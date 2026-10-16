import express, { type Router } from 'express';
import { z } from 'zod';
import { DEFAULT_RULES, RULES, isValidTick, rulesPatchSchema, tickSize, type Exchange, type InstrumentType } from '@vss/shared';
import { config } from '../config';
import { initSessionCheck } from '../lib/auth';
import { prevTradingDay, skipWeekendsFor } from '../lib/calendar';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { StockDbRow } from '../market/marketService';
import { generateHistory, insertBatched, tradingDates } from '../seed/seed';
import type { HoldingRow } from '../trading/dto';
import { corporateActionSchema } from '../corporate/service';
import { marginMetrics } from '../trading/cash';
import { RestoreError, exportBackup, parseBackup, restoreBackup, writeBackupFile } from './backup';
import { audit, reasonSchema, symbolParam, type AdminDeps, type AdminRequest } from './common';

const fmt = (n: number) => n.toLocaleString('en-US');

const listSchema = z
  .object({
    symbol: symbolParam,
    exchange: z.enum(['HOSE', 'HNX', 'UPCOM']),
    type: z.enum(['STOCK', 'ETF']).default('STOCK'),
    name: z.string().trim().min(3, 'Tên tối thiểu 3 ký tự').max(120),
    industry: z.string().trim().min(2, 'Nhập ngành').max(60),
    listedShares: z.number().int().min(1_000_000, 'KL niêm yết tối thiểu 1 triệu').max(100_000_000_000),
    ref: z.number().int().positive('Giá tham chiếu phải > 0'),
    eps: z.number().int().min(-1_000_000).max(1_000_000).default(0),
    bvps: z.number().int().min(0).max(10_000_000).default(10_000),
    isVn30: z.boolean().default(false),
    marginRatio: z.number().min(0).max(0.8).default(0),
    liquidity: z.number().min(0.05).max(1).default(0.4),
    volatility: z.number().min(0.005).max(0.08).default(0.02),
    /** Sinh lịch sử giá giả lập (để có biểu đồ ngay); false = mã mới lên sàn chưa có lịch sử */
    withHistory: z.boolean().default(true),
  })
  .strict();

const updateSchema = z
  .object({
    name: z.string().trim().min(3).max(120),
    industry: z.string().trim().min(2).max(60),
    listedShares: z.number().int().min(1_000_000).max(100_000_000_000),
    eps: z.number().int().min(-1_000_000).max(1_000_000),
    bvps: z.number().int().min(0).max(10_000_000),
    isVn30: z.boolean(),
    marginRatio: z.number().min(0).max(0.8),
    liquidity: z.number().min(0.05).max(1),
    volatility: z.number().min(0.005).max(0.08),
  })
  .partial()
  .strict()
  .refine((o) => Object.keys(o).length > 0, 'Không có thay đổi');

/**
 * Quản trị thị trường: tham số giao dịch (phí, thuế, biên độ, ký quỹ...), danh mục mã (niêm yết, sửa,
 * huỷ niêm yết, rổ VN30) và khôi phục dữ liệu từ bản sao lưu.
 */
export function mountMarketAdmin(r: Router, deps: AdminDeps, broadcast: () => void) {
  const { db, io, market, engine, store } = deps;

  /* ------------------------------ tham số giao dịch ------------------------------ */

  r.get('/rules', (_req, res) => {
    res.json({ rules: RULES, defaults: DEFAULT_RULES, overrides: store.rulesPatch, settlementDays: deps.settlementDays });
  });

  r.put(
    '/rules',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const patch = rulesPatchSchema.parse(req.body);
      const before = JSON.parse(JSON.stringify(RULES));
      try {
        await store.setRules(patch);
      } catch (err) {
        throw badRequest('RULES_INVALID', err instanceof Error ? err.message : 'Tham số không hợp lệ');
      }
      await audit(db, admin, 'RULES_UPDATE', 'system', null, { patch, before: pick(before, patch) });
      broadcast();
      res.json({ rules: RULES, overrides: store.rulesPatch });
    }),
  );

  r.delete(
    '/rules',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      await store.setRules(null);
      await audit(db, admin, 'RULES_RESET', 'system', null);
      broadcast();
      res.json({ rules: RULES, overrides: store.rulesPatch });
    }),
  );

  /* ------------------------------ danh mục mã ------------------------------ */

  r.get(
    '/symbols',
    ah(async (_req, res) => {
      const rows = await db.many<
        StockDbRow & { listed_at: string | null; delisted_at: string | null; delist_reason: string | null; holders: number; open_orders: number }
      >(
        `SELECT s.*,
                (SELECT count(*)::int FROM holdings h WHERE h.symbol = s.symbol) AS holders,
                (SELECT count(*)::int FROM orders o WHERE o.symbol = s.symbol AND o.status IN ('PENDING','PARTIAL')) AS open_orders
         FROM stocks s ORDER BY s.status, s.symbol`,
      );
      res.json(
        rows.map((s) => {
          const q = market.quote(s.symbol);
          return {
            symbol: s.symbol,
            exchange: s.exchange,
            type: s.type,
            status: s.status,
            name: s.name,
            industry: s.industry,
            listedShares: Number(s.listed_shares),
            eps: s.eps,
            bvps: s.bvps,
            isVn30: s.is_vn30,
            marginRatio: Number(s.margin_ratio),
            liquidity: s.liquidity,
            volatility: s.volatility,
            listedAt: s.listed_at,
            delistedAt: s.delisted_at,
            delistReason: s.delist_reason,
            holders: s.holders,
            openOrders: s.open_orders,
            halted: engine.control.haltedSymbols.has(s.symbol),
            ref: q?.ref ?? null,
            last: q ? market.markPrice(s.symbol) : null,
            volume: q?.volume ?? 0,
          };
        }),
      );
    }),
  );

  /** Niêm yết mã mới — xuất hiện ngay trên bảng giá; có thể sinh sẵn lịch sử giá giả lập */
  r.post(
    '/symbols',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const input = listSchema.parse(req.body);
      const venue = { exchange: input.exchange as Exchange, type: input.type as InstrumentType };
      if (!isValidTick(venue, input.ref)) throw badRequest('TICK', `Giá ${fmt(input.ref)} không đúng bước giá ${fmt(tickSize(venue, input.ref))}đ`);
      if (input.isVn30 && (input.exchange !== 'HOSE' || input.type !== 'STOCK')) throw badRequest('VN30', 'Rổ VN30 chỉ gồm cổ phiếu niêm yết trên HOSE');
      const exists = await db.one<{ status: string }>('SELECT status FROM stocks WHERE symbol = $1', [input.symbol]);
      if (exists) throw new AppError(409, 'SYMBOL_EXISTS', exists.status === 'DELISTED' ? `Mã ${input.symbol} đã từng niêm yết và đã huỷ — chọn mã khác` : `Mã ${input.symbol} đã tồn tại`);

      const td = market.tradeDate;
      const row = await db.tx(async (tx) => {
        const created = await tx.one<StockDbRow>(
          `INSERT INTO stocks (symbol, exchange, type, name, industry, listed_shares, eps, bvps, is_vn30, liquidity, volatility, margin_ratio, listed_at)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
          [
            input.symbol,
            input.exchange,
            input.type,
            input.name,
            input.industry,
            input.listedShares,
            input.eps,
            input.bvps,
            input.isVn30,
            input.liquidity,
            input.volatility,
            input.marginRatio,
            td,
          ],
        );
        if (input.withHistory) {
          const end = prevTradingDay(td, skipWeekendsFor(market.opts.mode));
          const dates = tradingDates(end, 250);
          const bars = generateHistory(
            {
              symbol: input.symbol,
              exchange: input.exchange,
              name: input.name,
              industry: input.industry,
              ref: input.ref,
              sharesM: input.listedShares / 1e6,
              eps: input.eps,
              bvps: input.bvps,
              liq: input.liquidity,
            },
            dates,
          );
          await insertBatched(
            tx,
            'ohlcv_daily',
            ['symbol', 'trade_date', 'open', 'high', 'low', 'close', 'volume', 'value'],
            bars.map((b) => [input.symbol, b.date, b.open, b.high, b.low, b.close, b.volume, b.value]),
          );
        }
        await audit(tx, admin, 'SYMBOL_LIST', 'symbol', input.symbol, {
          exchange: input.exchange,
          type: input.type,
          ref: input.ref,
          isVn30: input.isVn30,
          withHistory: input.withHistory,
        });
        return created!;
      });
      await market.addStock(row, input.ref);
      res.status(201).json({ ok: true, symbol: row.symbol });
    }),
  );

  r.patch(
    '/symbols/:symbol',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const symbol = symbolParam.parse(req.params.symbol);
      const input = updateSchema.parse(req.body);
      const cur = await db.one<StockDbRow>('SELECT * FROM stocks WHERE symbol = $1', [symbol]);
      if (!cur) throw notFound('Mã chứng khoán không tồn tại');
      if (cur.status !== 'ACTIVE') throw badRequest('DELISTED', 'Mã đã huỷ niêm yết');
      if (input.isVn30 && (cur.exchange !== 'HOSE' || cur.type !== 'STOCK')) throw badRequest('VN30', 'Rổ VN30 chỉ gồm cổ phiếu niêm yết trên HOSE');
      const cols: Record<string, string> = {
        name: 'name',
        industry: 'industry',
        listedShares: 'listed_shares',
        eps: 'eps',
        bvps: 'bvps',
        isVn30: 'is_vn30',
        marginRatio: 'margin_ratio',
        liquidity: 'liquidity',
        volatility: 'volatility',
      };
      const sets: string[] = [];
      const params: unknown[] = [symbol];
      for (const [k, v] of Object.entries(input)) {
        params.push(v);
        sets.push(`${cols[k]} = $${params.length}`);
      }
      await db.tx(async (tx) => {
        await tx.many(`UPDATE stocks SET ${sets.join(', ')} WHERE symbol = $1`, params);
        await audit(tx, admin, input.isVn30 !== undefined && input.isVn30 !== cur.is_vn30 ? (input.isVn30 ? 'VN30_ADD' : 'VN30_REMOVE') : 'SYMBOL_UPDATE', 'symbol', symbol, input);
      });
      const { liquidity, volatility, ...info } = input;
      market.updateStock(symbol, { ...info, liq: liquidity, volatility });
      res.json({ ok: true });
    }),
  );

  /**
   * Huỷ niêm yết: huỷ mọi lệnh đang chờ, thanh toán toàn bộ cổ phiếu người dùng đang nắm giữ bằng tiền
   * theo giá thanh toán (mặc định giá hiện hành), gỡ khỏi bảng giá và rổ chỉ số.
   */
  r.post(
    '/symbols/:symbol/delist',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const symbol = symbolParam.parse(req.params.symbol);
      const body = z.object({ reason: reasonSchema, payoutPrice: z.number().int().positive().optional() }).strict().parse(req.body);
      const s = market.quote(symbol);
      if (!s) throw notFound('Mã không có trên bảng giá (chưa niêm yết hoặc đã huỷ)');
      const price = body.payoutPrice ?? market.markPrice(symbol);
      const cancelled = await engine.cancelAllForSymbol(symbol, `Mã ${symbol} huỷ niêm yết: ${body.reason}`);
      await deps.onDelist?.(symbol, body.reason);
      const paid = await db.tx(async (tx) => {
        const holds = await tx.many<HoldingRow>('SELECT * FROM holdings WHERE symbol = $1 FOR UPDATE', [symbol]);
        for (const h of holds) {
          const amount = h.qty_total * price;
          const acct = await tx.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1 FOR UPDATE', [h.user_id]);
          const balance = (acct?.cash_balance ?? 0) + amount;
          await tx.many('UPDATE accounts SET cash_balance = $2, updated_at = now() WHERE user_id = $1', [h.user_id, balance]);
          await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1, 'DELIST', $2, $3, $4)`, [
            h.user_id,
            amount,
            balance,
            `Thanh toán ${fmt(h.qty_total)} ${symbol} × ${fmt(price)}đ do huỷ niêm yết: ${body.reason}`,
          ]);
          await tx.many('DELETE FROM settlement_lots WHERE user_id = $1 AND symbol = $2 AND settled = false', [h.user_id, symbol]);
          await tx.many('DELETE FROM holdings WHERE user_id = $1 AND symbol = $2', [h.user_id, symbol]);
        }
        await tx.many(`UPDATE stocks SET status = 'DELISTED', delisted_at = $2, delist_reason = $3 WHERE symbol = $1`, [symbol, market.tradeDate, body.reason]);
        await tx.many('DELETE FROM watchlists WHERE symbol = $1', [symbol]);
        await audit(tx, admin, 'SYMBOL_DELIST', 'symbol', symbol, { reason: body.reason, payoutPrice: price, holders: holds.length, cancelledOrders: cancelled });
        return holds.map((h) => h.user_id);
      });
      if (engine.control.haltedSymbols.has(symbol)) await store.setSymbolHalt(symbol, false);
      market.removeStock(symbol);
      for (const u of new Set(paid)) io.to(`user:${u}`).emit('account');
      broadcast();
      res.json({ ok: true, holdersPaid: paid.length, cancelledOrders: cancelled, payoutPrice: price });
    }),
  );

  /* ------------------------------ sự kiện quyền ------------------------------ */

  r.get(
    '/corporate-actions',
    ah(async (_req, res) => {
      if (!deps.corp) throw badRequest('NO_CA', 'Chưa bật xử lý sự kiện quyền');
      res.json(await deps.corp.list({ limit: 300 }));
    }),
  );

  r.post(
    '/corporate-actions',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      if (!deps.corp) throw badRequest('NO_CA', 'Chưa bật xử lý sự kiện quyền');
      const input = corporateActionSchema.parse(req.body);
      const created = await deps.corp.create(input, admin.email);
      await audit(db, admin, 'CA_CREATE', 'symbol', input.symbol, { id: created.id, type: input.type, exDate: input.exDate, payDate: input.payDate });
      res.status(201).json(created);
    }),
  );

  r.post(
    '/corporate-actions/:id/cancel',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      if (!deps.corp) throw badRequest('NO_CA', 'Chưa bật xử lý sự kiện quyền');
      const id = Number(req.params.id);
      if (!Number.isSafeInteger(id) || id <= 0) throw badRequest('ID', 'Mã sự kiện không hợp lệ');
      const a = await deps.corp.cancel(id);
      await audit(db, admin, 'CA_CANCEL', 'symbol', a.symbol, { id });
      res.json(a);
    }),
  );

  /* ------------------------------ ký quỹ ------------------------------ */

  /** Tài khoản đang dùng ký quỹ: dư nợ, lãi, tỷ lệ ký quỹ thực tế (giá hiện hành) */
  r.get(
    '/margin',
    ah(async (_req, res) => {
      const rows = await db.many<{
        user_id: string;
        email: string;
        full_name: string;
        cash_balance: number;
        cash_pending: number;
        loan_balance: number;
        loan_interest: number;
        loan_hold: number;
        credit_limit: number;
        margin_status: string;
        margin_call_at: Date | null;
      }>(
        `SELECT a.*, u.email, u.full_name FROM accounts a JOIN users u ON u.id = a.user_id
         WHERE a.margin_enabled OR a.loan_balance > 0 ORDER BY a.loan_balance DESC LIMIT 500`,
      );
      const holds = await db.many<{ user_id: string; symbol: string; qty_total: number }>('SELECT user_id, symbol, qty_total FROM holdings');
      const stock = new Map<string, number>();
      for (const h of holds) stock.set(h.user_id, (stock.get(h.user_id) ?? 0) + h.qty_total * market.markPrice(h.symbol));
      res.json(
        rows.map((a) => {
          const m = marginMetrics(a, stock.get(a.user_id) ?? 0);
          return {
            userId: a.user_id,
            email: a.email,
            fullName: a.full_name,
            creditLimit: Number(a.credit_limit),
            loanBalance: Number(a.loan_balance),
            loanInterest: Number(a.loan_interest),
            loanHold: Number(a.loan_hold),
            stockValue: m.stockValue,
            ratio: m.debt > 0 ? m.ratio : null,
            status: m.status,
            callAmount: m.callAmount,
            callSince: a.margin_call_at ? new Date(a.margin_call_at).toISOString() : null,
          };
        }),
      );
    }),
  );

  r.post(
    '/users/:id/credit',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      if (!deps.margin) throw badRequest('NO_MARGIN', 'Chưa bật ký quỹ');
      const id = z.string().uuid().parse(req.params.id);
      const { creditLimit, reason } = z.object({ creditLimit: z.number().int().min(0).max(100_000_000_000), reason: reasonSchema }).strict().parse(req.body);
      await deps.margin.setCreditLimit(id, creditLimit);
      await audit(db, admin, 'CREDIT_LIMIT', 'user', id, { creditLimit, reason });
      io.to(`user:${id}`).emit('account');
      res.json({ ok: true });
    }),
  );

  /* ------------------------------ khôi phục dữ liệu ------------------------------ */

  /**
   * Khôi phục từ file JSON (gửi nguyên file, Content-Type: application/octet-stream).
   * ?dryRun=1 → chạy thử trong transaction rồi huỷ, chỉ trả báo cáo.
   * Chạy thật: tạm ngừng hệ thống, tự sao lưu dữ liệu hiện tại, ghi đè, nạp lại bộ nhớ, mở lại.
   */
  r.post(
    '/data/restore',
    express.raw({ type: 'application/octet-stream', limit: '200mb' }),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('NO_FILE', 'Chưa có file sao lưu (gửi dạng application/octet-stream)');
      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
      let backup;
      try {
        backup = parseBackup(req.body);
      } catch (err) {
        throw badRequest('BACKUP_INVALID', err instanceof Error ? err.message : 'File không hợp lệ');
      }
      if (dryRun) {
        try {
          return void res.json(await restoreBackup(db, backup, { dryRun: true }));
        } catch (err) {
          if (err instanceof RestoreError) throw badRequest('RESTORE_FAILED', err.message);
          throw err;
        }
      }

      const wasHalted = engine.control.haltAll;
      store.maintenance = 'Hệ thống đang khôi phục dữ liệu, vui lòng quay lại sau ít phút';
      engine.control.haltAll = true;
      broadcast();
      let autoFile: string | null = null;
      try {
        autoFile = writeBackupFile(config.backupDir, 'auto-before-restore', await exportBackup(db, { exportedBy: `${admin.email} (tự động trước khi khôi phục)`, tradeDate: market.tradeDate }));
        log.info('[admin] đã tự sao lưu trước khi khôi phục', { file: autoFile });
        const report = await restoreBackup(db, backup, { dryRun: false, actor: admin });
        // Nạp lại trạng thái trong bộ nhớ theo dữ liệu mới
        for (const sym of report.stocksAdded) {
          const row = await db.one<StockDbRow & { status: string }>('SELECT * FROM stocks WHERE symbol = $1', [sym]);
          if (row?.status !== 'ACTIVE' || market.quote(sym)) continue;
          const snap = await db.one<{ ref: number }>('SELECT ref FROM price_snapshots WHERE symbol = $1', [sym]);
          const close = await db.one<{ close: number }>('SELECT close FROM ohlcv_daily WHERE symbol = $1 ORDER BY trade_date DESC LIMIT 1', [sym]);
          const ref = snap?.ref ?? close?.close;
          if (ref) await market.addStock(row, ref);
          else report.warnings.push(`Mã ${sym} chưa có giá tham chiếu — chưa đưa lên bảng giá`);
        }
        await engine.reload();
        await store.load();
        initSessionCheck(db);
        await deps.onRestored?.();
        log.warn('[admin] đã khôi phục dữ liệu từ bản sao lưu', { by: admin.email, exportedAt: backup.exportedAt });
        res.json({ ...report, autoBackupFile: autoFile });
      } catch (err) {
        if (err instanceof RestoreError) throw badRequest('RESTORE_FAILED', err.message);
        throw err;
      } finally {
        store.maintenance = null;
        if (!wasHalted && engine.control.haltAll && !(await db.one<{ v: { halted?: boolean } }>(`SELECT value AS v FROM market_meta WHERE key = 'admin.halt'`))?.v?.halted) {
          engine.control.haltAll = false;
        }
        broadcast();
        // Phiên realtime cũ có thể thuộc tài khoản không còn tồn tại → buộc kết nối lại
        io.disconnectSockets(true);
      }
    }),
  );
}

/** Lấy giá trị cũ của đúng các khoá được chỉnh (ghi nhật ký) */
function pick(before: Record<string, unknown>, patch: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(patch)) {
    const b = before[k];
    out[k] = v && typeof v === 'object' && b && typeof b === 'object' ? pick(b as Record<string, unknown>, v as Record<string, unknown>) : b;
  }
  return out;
}
