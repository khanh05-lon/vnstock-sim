import express, { type Router } from 'express';
import { z } from 'zod';
import { DEFAULT_RULES, RULES, rulesPatchSchema } from '@vss/shared';
import { config } from '../config';
import { initSessionCheck } from '../lib/auth';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { addSymbol, type SymbolRowDb } from '../market/symbols';
import { utcDay } from '../portfolio/nav';
import { RestoreError, exportBackup, parseBackup, restoreBackup, writeBackupFile } from './backup';
import { audit, reasonSchema, symbolParam, type AdminDeps, type AdminRequest } from './common';

/**
 * Quản trị thị trường: biểu phí (maker / taker / giảm phí BNB / vốn ban đầu), cặp giao dịch
 * (thêm từ Binance, đổi tên / thứ tự, tạm ngừng, gỡ khỏi sàn) và khôi phục dữ liệu từ bản sao lưu.
 */
export function mountMarketAdmin(r: Router, deps: AdminDeps, broadcast: () => void) {
  const { db, io, market, engine, store } = deps;

  /* ------------------------------ biểu phí ------------------------------ */

  r.get('/rules', (_req, res) => {
    res.json({ rules: RULES, defaults: DEFAULT_RULES, overrides: store.rulesPatch });
  });

  r.put(
    '/rules',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const patch = rulesPatchSchema.parse(req.body);
      const before = JSON.parse(JSON.stringify(RULES)) as Record<string, unknown>;
      await store.setRules(patch);
      await audit(db, admin, 'RULES_UPDATE', 'system', null, { patch, before: Object.fromEntries(Object.keys(patch).map((k) => [k, before[k]])) });
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

  /* ------------------------------ cặp giao dịch ------------------------------ */

  r.get(
    '/symbols',
    ah(async (_req, res) => {
      const rows = await db.many<SymbolRowDb & { holders: number; open_orders: number }>(
        `SELECT s.*,
                (SELECT count(*)::int FROM balances b WHERE b.asset = s.base_asset AND b.free + b.locked > 0) AS holders,
                (SELECT count(*)::int FROM orders o WHERE o.symbol = s.symbol AND o.status IN ('NEW','PARTIALLY_FILLED')) AS open_orders
         FROM symbols s ORDER BY s.enabled DESC, s.sort_order, s.symbol`,
      );
      res.json(
        rows.map((s) => {
          const t = market.state(s.symbol)?.ticker;
          return {
            symbol: s.symbol,
            baseAsset: s.base_asset,
            quoteAsset: s.quote_asset,
            name: s.name,
            status: s.status,
            enabled: s.enabled,
            sortOrder: s.sort_order,
            filters: s.filters,
            halted: engine.control.haltedSymbols.has(s.symbol),
            holders: s.holders,
            openOrders: s.open_orders,
            last: t?.last ?? s.last_price,
            changePct: t?.changePct ?? null,
            quoteVolume: t?.quoteVolume ?? null,
          };
        }),
      );
    }),
  );

  /** Thêm cặp mới: lấy bộ lọc thật từ Binance exchangeInfo, xuất hiện ngay trên bảng giá */
  r.post(
    '/symbols',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { symbol } = z.object({ symbol: symbolParam }).strict().parse(req.body);
      const exists = await db.one<{ enabled: boolean }>('SELECT enabled FROM symbols WHERE symbol = $1', [symbol]);
      if (exists?.enabled) throw new AppError(409, 'SYMBOL_EXISTS', `Cặp ${symbol} đã có trên sàn`);
      let row: SymbolRowDb;
      try {
        row = await addSymbol(db, deps.rest ?? null, symbol);
      } catch (err) {
        throw badRequest('SYMBOL_UNKNOWN', err instanceof Error ? err.message : `Không tìm thấy cặp ${symbol}`);
      }
      await market.addSymbolRow(row);
      await audit(db, admin, 'SYMBOL_LIST', 'symbol', symbol, { reactivated: !!exists });
      res.status(201).json({ ok: true, symbol });
    }),
  );

  r.patch(
    '/symbols/:symbol',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const symbol = symbolParam.parse(req.params.symbol);
      const input = z
        .object({ name: z.string().trim().min(2).max(60), sortOrder: z.number().int().min(0).max(10_000) })
        .partial()
        .strict()
        .refine((o) => Object.keys(o).length > 0, 'Không có thay đổi')
        .parse(req.body);
      const cur = await db.one('SELECT 1 FROM symbols WHERE symbol = $1', [symbol]);
      if (!cur) throw notFound('Cặp giao dịch không tồn tại');
      await db.tx(async (tx) => {
        if (input.name) await tx.many('UPDATE symbols SET name = $2, updated_at = now() WHERE symbol = $1', [symbol, input.name]);
        if (input.sortOrder != null) await tx.many('UPDATE symbols SET sort_order = $2, updated_at = now() WHERE symbol = $1', [symbol, input.sortOrder]);
        await audit(tx, admin, 'SYMBOL_UPDATE', 'symbol', symbol, input);
      });
      const s = market.state(symbol);
      if (s) {
        if (input.name) s.info = { ...s.info, name: input.name };
        if (input.sortOrder != null) s.info = { ...s.info, sortOrder: input.sortOrder };
        market.emit('symbols');
      }
      res.json({ ok: true });
    }),
  );

  /**
   * Gỡ cặp khỏi sàn: huỷ mọi lệnh đang mở của cặp, ngừng hiển thị trên bảng giá.
   * Số dư coin của người dùng giữ nguyên trong ví (vẫn quy đổi giá trị nếu còn cặp XXXUSDT).
   */
  r.post(
    '/symbols/:symbol/delist',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const symbol = symbolParam.parse(req.params.symbol);
      const { reason } = z.object({ reason: reasonSchema }).strict().parse(req.body);
      if (!market.info(symbol)) throw notFound('Cặp không có trên sàn (chưa thêm hoặc đã gỡ)');
      const canceled = await engine.cancelAllForSymbol(symbol, `Cặp ${symbol} bị gỡ khỏi sàn: ${reason}`);
      await deps.onDelist?.(symbol, reason);
      await db.tx(async (tx) => {
        await tx.many(`UPDATE symbols SET enabled = false, updated_at = now() WHERE symbol = $1`, [symbol]);
        await tx.many('DELETE FROM watchlists WHERE symbol = $1', [symbol]);
        await audit(tx, admin, 'SYMBOL_DELIST', 'symbol', symbol, { reason, canceledOrders: canceled });
      });
      if (engine.control.haltedSymbols.has(symbol)) await store.setSymbolHalt(symbol, false);
      market.removeSymbol(symbol);
      broadcast();
      res.json({ ok: true, canceledOrders: canceled });
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
        autoFile = writeBackupFile(config.backupDir, 'auto-before-restore', await exportBackup(db, { exportedBy: `${admin.email} (tự động trước khi khôi phục)`, tradeDate: utcDay() }));
        log.info('[admin] đã tự sao lưu trước khi khôi phục', { file: autoFile });
        const report = await restoreBackup(db, backup, { dryRun: false, actor: admin });
        for (const sym of report.symbolsAdded) {
          const row = await db.one<SymbolRowDb>('SELECT * FROM symbols WHERE symbol = $1', [sym]);
          if (row?.enabled && !market.info(sym)) await market.addSymbolRow(row);
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
