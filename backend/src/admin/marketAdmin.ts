import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import express, { type Router } from 'express';
import { z } from 'zod';
import { DEFAULT_RULES, RULES, rulesPatchSchema } from '@vss/shared';
import { config } from '../config';
import { initSessionCheck } from '../lib/auth';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { addSymbol, type SymbolRowDb } from '../market/symbols';
import { utcDay } from '../portfolio/nav';
import type { Approvals } from './approvals';
import { RestoreError, exportBackup, parseBackup, restoreBackup, writeBackupFile, type BackupFile } from './backup';
import { audit, need, reasonSchema, symbolParam, type AdminCtx, type AdminDeps, type AdminRequest } from './common';

/**
 * Quản trị thị trường: biểu phí (maker / taker / giảm phí BNB / vốn ban đầu), cặp giao dịch
 * (thêm từ Binance, đổi tên / thứ tự, tạm ngừng, gỡ khỏi sàn) và khôi phục dữ liệu từ bản sao lưu.
 * Niêm yết, huỷ niêm yết, khôi phục dữ liệu là đề xuất: người thứ hai có thẩm quyền duyệt rồi hệ thống mới thực hiện.
 */
export function mountMarketAdmin(r: Router, deps: AdminDeps, broadcast: () => void, approvals: Approvals) {
  const { db, io, market, engine, store } = deps;

  /* ------------------------------ biểu phí ------------------------------ */

  r.get('/rules', (_req, res) => {
    res.json({ rules: RULES, defaults: DEFAULT_RULES, overrides: store.rulesPatch });
  });

  r.put(
    '/rules',
    need('market.manage'),
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
    need('market.manage'),
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

  /** Niêm yết (đã được duyệt): lấy bộ lọc thật từ Binance exchangeInfo, xuất hiện ngay trên bảng giá */
  const listSymbol = async (admin: AdminCtx, symbol: string, extra: Record<string, unknown>) => {
    const exists = await db.one<{ enabled: boolean }>('SELECT enabled FROM symbols WHERE symbol = $1', [symbol]);
    if (exists?.enabled) throw new AppError(409, 'SYMBOL_EXISTS', `Cặp ${symbol} đã có trên sàn`);
    let row: SymbolRowDb;
    try {
      row = await addSymbol(db, deps.rest ?? null, symbol);
    } catch (err) {
      throw badRequest('SYMBOL_UNKNOWN', err instanceof Error ? err.message : `Không tìm thấy cặp ${symbol}`);
    }
    await market.addSymbolRow(row);
    await audit(db, admin, 'SYMBOL_LIST', 'symbol', symbol, { reactivated: !!exists, ...extra });
    return { symbol, reactivated: !!exists };
  };
  approvals.register('SYMBOL_LIST', (admin, req) => listSymbol(admin, req.target!, { approvalId: req.id, requestedBy: req.requestedByEmail, reason: req.reason }));

  /** Đề xuất niêm yết cặp mới / đưa lại cặp đã gỡ — chờ người thứ hai duyệt (202) */
  r.post(
    '/symbols',
    need('market.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { symbol, reason } = z
        .object({ symbol: symbolParam, reason: reasonSchema.optional() })
        .strict()
        .parse(req.body);
      const exists = await db.one<{ enabled: boolean }>('SELECT enabled FROM symbols WHERE symbol = $1', [symbol]);
      if (exists?.enabled) throw new AppError(409, 'SYMBOL_EXISTS', `Cặp ${symbol} đã có trên sàn`);
      const request = await approvals.create(admin, {
        kind: 'SYMBOL_LIST',
        target: symbol,
        payload: { reactivate: !!exists },
        summary: exists ? `Đưa lại cặp ${symbol} lên sàn` : `Niêm yết cặp mới ${symbol} (bộ lọc lấy từ Binance)`,
        reason: reason ?? (exists ? 'Đưa lại cặp đã gỡ' : 'Niêm yết cặp mới'),
      });
      res.status(202).json({ ok: true, pending: true, request });
    }),
  );

  r.patch(
    '/symbols/:symbol',
    need('market.manage'),
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
  const delistSymbol = async (admin: AdminCtx, symbol: string, reason: string, extra: Record<string, unknown>) => {
    if (!market.info(symbol)) throw notFound('Cặp không có trên sàn (chưa thêm hoặc đã gỡ)');
    const canceled = await engine.cancelAllForSymbol(symbol, `Cặp ${symbol} bị gỡ khỏi sàn: ${reason}`);
    await deps.onDelist?.(symbol, reason);
    await db.tx(async (tx) => {
      await tx.many(`UPDATE symbols SET enabled = false, updated_at = now() WHERE symbol = $1`, [symbol]);
      await tx.many('DELETE FROM watchlists WHERE symbol = $1', [symbol]);
      await audit(tx, admin, 'SYMBOL_DELIST', 'symbol', symbol, { reason, canceledOrders: canceled, ...extra });
    });
    if (engine.control.haltedSymbols.has(symbol)) await store.setSymbolHalt(symbol, false);
    market.removeSymbol(symbol);
    broadcast();
    return { canceledOrders: canceled };
  };
  approvals.register('SYMBOL_DELIST', (admin, req) => delistSymbol(admin, req.target!, req.reason, { approvalId: req.id, requestedBy: req.requestedByEmail }));

  /** Đề xuất gỡ cặp — khi được duyệt: huỷ mọi lệnh đang mở của cặp, ngừng hiển thị trên bảng giá */
  r.post(
    '/symbols/:symbol/delist',
    need('market.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const symbol = symbolParam.parse(req.params.symbol);
      const { reason } = z.object({ reason: reasonSchema }).strict().parse(req.body);
      if (!market.info(symbol)) throw notFound('Cặp không có trên sàn (chưa thêm hoặc đã gỡ)');
      const open = await db.one<{ n: number }>(`SELECT count(*)::int AS n FROM orders WHERE symbol = $1 AND status IN ('NEW','PARTIALLY_FILLED')`, [symbol]);
      const request = await approvals.create(admin, {
        kind: 'SYMBOL_DELIST',
        target: symbol,
        payload: { openOrders: open?.n ?? 0 },
        summary: `Gỡ cặp ${symbol} khỏi sàn — huỷ ${open?.n ?? 0} lệnh đang mở, xoá khỏi danh sách theo dõi`,
        reason,
      });
      res.status(202).json({ ok: true, pending: true, request });
    }),
  );

  /* ------------------------------ khôi phục dữ liệu ------------------------------ */

  /**
   * Khôi phục từ file JSON (gửi nguyên file, Content-Type: application/octet-stream).
   * ?dryRun=1 → chạy thử trong transaction rồi huỷ, chỉ trả báo cáo.
   * Chạy thật: tạm ngừng hệ thống, tự sao lưu dữ liệu hiện tại, ghi đè, nạp lại bộ nhớ, mở lại.
   */
  /** Khôi phục thật (đã được duyệt): tạm ngừng hệ thống, tự sao lưu dữ liệu hiện tại, ghi đè, nạp lại bộ nhớ, mở lại */
  const runRestore = async (admin: AdminCtx, backup: BackupFile) => {
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
      return { ...report, autoBackupFile: autoFile };
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
  };

  approvals.register('DATA_RESTORE', async (admin, req) => {
    const p = req.payload as { file: string; sha256: string };
    let raw: Buffer;
    try {
      raw = fs.readFileSync(p.file);
    } catch {
      throw badRequest('BACKUP_MISSING', 'Không còn file sao lưu đã tải lên — hãy đề xuất lại');
    }
    // File trên máy chủ bị thay sau khi đề xuất → không khôi phục
    if (crypto.createHash('sha256').update(raw).digest('hex') !== p.sha256) throw badRequest('BACKUP_CHANGED', 'File sao lưu đã bị thay đổi sau khi đề xuất — từ chối khôi phục');
    const report = await runRestore(admin, parseBackup(raw));
    return { ...report, approvalId: req.id, requestedBy: req.requestedByEmail };
  });

  /**
   * Khôi phục từ file JSON (gửi nguyên file, Content-Type: application/octet-stream).
   * ?dryRun=1 → chạy thử trong transaction rồi huỷ, chỉ trả báo cáo.
   * Không dryRun → lưu file trên máy chủ, chạy thử để kiểm tra, tạo đề xuất chờ Quản trị hệ thống KHÁC duyệt (202).
   */
  r.post(
    '/data/restore',
    need('data.manage'),
    express.raw({ type: 'application/octet-stream', limit: '200mb' }),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      if (!Buffer.isBuffer(req.body) || !req.body.length) throw badRequest('NO_FILE', 'Chưa có file sao lưu (gửi dạng application/octet-stream)');
      const dryRun = req.query.dryRun === '1' || req.query.dryRun === 'true';
      const { reason } = z.object({ reason: reasonSchema.optional() }).parse({ reason: typeof req.query.reason === 'string' ? req.query.reason : undefined });
      let backup: BackupFile;
      try {
        backup = parseBackup(req.body);
      } catch (err) {
        throw badRequest('BACKUP_INVALID', err instanceof Error ? err.message : 'File không hợp lệ');
      }
      let report;
      try {
        report = await restoreBackup(db, backup, { dryRun: true });
      } catch (err) {
        if (err instanceof RestoreError) throw badRequest('RESTORE_FAILED', err.message);
        throw err;
      }
      if (dryRun) return void res.json(report);

      const dir = path.join(config.backupDir, 'pending-restore');
      fs.mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `restore-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.json`);
      fs.writeFileSync(file, req.body);
      const sha256 = crypto.createHash('sha256').update(req.body).digest('hex');
      const rows = report.tables.reduce((n, t) => n + t.rows, 0);
      const request = await approvals.create(admin, {
        kind: 'DATA_RESTORE',
        target: null,
        payload: { file, sha256, bytes: req.body.length, exportedAt: backup.exportedAt, exportedBy: backup.exportedBy, tables: report.tables.length, rows },
        summary: `Khôi phục bản sao lưu lúc ${backup.exportedAt} (của ${backup.exportedBy}): ${report.tables.length} bảng, ${rows} dòng — ghi đè dữ liệu hiện tại`,
        reason: reason ?? 'Khôi phục dữ liệu từ bản sao lưu',
      });
      res.status(202).json({ ok: true, pending: true, request, report });
    }),
  );
}
