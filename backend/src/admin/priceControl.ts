import type { Router } from 'express';
import {
  Big,
  PRICE_DEFAULT_VOLATILITY_PCT,
  floorStep,
  pathProgress,
  priceModeSchema,
  priceOnPath,
  priceSetSchema,
  str,
  type AdminPriceRow,
  type PriceControl,
  type PriceHistoryItem,
} from '@vss/shared';
import type { Queryable } from '../db';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import type { StoredPriceControl } from '../market/symbols';
import { audit, symbolParam, type AdminDeps, type AdminRequest } from './common';

/**
 * Quản lý giá từng cặp: giá thực tế (Binance) ⇄ giá điều chỉnh (quản trị viên đặt giá / chạy kịch bản).
 * Mọi thao tác bắt buộc lý do, lưu CSDL (giữ sau khi khởi động lại) và ghi nhật ký quản trị chỉ-ghi-thêm.
 */
export function mountPriceControl(r: Router, deps: AdminDeps) {
  const { db, market } = deps;

  const save = (q: Queryable, symbol: string, control: StoredPriceControl | null) =>
    q.many(`UPDATE symbols SET price_mode = $2, price_control = $3::jsonb, updated_at = now() WHERE symbol = $1`, [
      symbol,
      control ? 'MANUAL' : 'LIVE',
      control ? JSON.stringify(control) : null,
    ]);

  const toControl = (c: StoredPriceControl): PriceControl => ({
    since: c.since,
    from: c.from,
    to: c.to,
    startAt: c.startAt,
    endAt: c.endAt,
    volatilityPct: c.volatilityPct,
  });

  /** Cặp đang trên sàn + giá hiện tại (chưa có giá thì không điều chỉnh được) */
  const target = (raw: unknown) => {
    const symbol = symbolParam.parse(raw);
    const pc = market.priceControl(symbol);
    const info = market.info(symbol);
    if (!pc || !info) throw notFound('Cặp không có trên sàn (chưa thêm hoặc đã gỡ)');
    const last = market.lastPrice(symbol);
    if (!last) throw badRequest('NO_PRICE', 'Cặp chưa có giá, chờ dữ liệu thị trường rồi thử lại');
    return { symbol, pc, info, last };
  };

  /** Làm tròn theo bước giá và kiểm tra khoảng giá của cặp (bộ lọc PRICE_FILTER của Binance) */
  const checkPrice = (info: NonNullable<ReturnType<typeof market.info>>, raw: string): string => {
    const f = info.filters;
    const p = new Big(floorStep(raw, f.tickSize));
    if (p.lte(0)) throw badRequest('PRICE', `Giá nhỏ hơn bước giá ${str(f.tickSize)}`);
    if (new Big(f.minPrice).gt(0) && p.lt(f.minPrice)) throw badRequest('PRICE', `Giá tối thiểu của cặp là ${str(f.minPrice)}`);
    if (new Big(f.maxPrice).gt(0) && p.gt(f.maxPrice)) throw badRequest('PRICE', `Giá tối đa của cặp là ${str(f.maxPrice)}`);
    return str(p.toFixed());
  };

  const pct = (from: string, to: string) => (new Big(from).gt(0) ? Number(new Big(to).minus(from).div(from).times(100).toFixed(2)) : null);

  r.get(
    '/prices',
    ah(async (_req, res) => {
      const meta = new Map(
        (await db.many<{ symbol: string; price_control: StoredPriceControl | null }>(`SELECT symbol, price_control FROM symbols WHERE price_mode = 'MANUAL'`)).map(
          (m) => [m.symbol, m.price_control],
        ),
      );
      const now = Date.now();
      const rows: AdminPriceRow[] = [];
      for (const symbol of market.symbols()) {
        const info = market.info(symbol)!;
        const pc = market.priceControl(symbol)!;
        const last = market.lastPrice(symbol);
        const c = pc.control;
        const m = meta.get(symbol);
        rows.push({
          symbol,
          name: info.name,
          baseAsset: info.baseAsset,
          quoteAsset: info.quoteAsset,
          status: info.status,
          tickSize: str(info.filters.tickSize),
          minPrice: str(info.filters.minPrice),
          maxPrice: str(info.filters.maxPrice),
          mode: c ? 'MANUAL' : 'LIVE',
          last,
          ref: pc.ref,
          diffPct: last && pc.ref ? pct(pc.ref, last) : null,
          control: c
            ? {
                ...c,
                reason: m?.reason ?? '',
                by: m?.by ?? '',
                progress: pathProgress(c, now),
                pathPrice: floorStep(new Big(priceOnPath(c, now)).toFixed(18), info.filters.tickSize),
              }
            : null,
        });
      }
      res.json(rows);
    }),
  );

  /** Lịch sử chỉnh giá của 1 cặp (từ nhật ký quản trị) */
  r.get(
    '/prices/:symbol/history',
    ah(async (req, res) => {
      const symbol = symbolParam.parse(req.params.symbol);
      const rows = await db.many<{ id: number; action: string; admin_email: string; detail: Record<string, unknown>; created_at: Date }>(
        `SELECT id, action, admin_email, detail, created_at FROM admin_audit_log
         WHERE target_type = 'symbol' AND target_id = $1 AND action LIKE 'PRICE\\_%'
         ORDER BY id DESC LIMIT 100`,
        [symbol],
      );
      res.json(
        rows.map(
          (x): PriceHistoryItem => ({ id: Number(x.id), action: x.action, adminEmail: x.admin_email, detail: x.detail, createdAt: new Date(x.created_at).toISOString() }),
        ),
      );
    }),
  );

  /** Chuyển sang giá điều chỉnh, giữ nguyên giá hiện tại (sau đó đặt giá / kịch bản) */
  r.post(
    '/prices/:symbol/manual',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { symbol, pc, last } = target(req.params.symbol);
      const { reason, volatilityPct } = priceModeSchema.parse(req.body);
      if (pc.control) throw new AppError(409, 'ALREADY_MANUAL', 'Cặp đang ở chế độ giá điều chỉnh');
      const now = Date.now();
      const control: StoredPriceControl = {
        since: now,
        from: last,
        to: last,
        startAt: now,
        endAt: now,
        volatilityPct: volatilityPct ?? PRICE_DEFAULT_VOLATILITY_PCT,
        reason,
        by: admin.email,
      };
      await db.tx(async (tx) => {
        await save(tx, symbol, control);
        await audit(tx, admin, 'PRICE_MODE_MANUAL', 'symbol', symbol, { reason, price: last, binancePrice: pc.ref, volatilityPct: control.volatilityPct });
      });
      market.setPriceControl(symbol, toControl(control));
      res.json({ ok: true });
    }),
  );

  /** Đặt giá (durationMin = 0: nhảy ngay) hoặc chạy kịch bản tới giá đích; cặp đang ở giá thực tế thì tự chuyển sang giá điều chỉnh */
  r.post(
    '/prices/:symbol/set',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { symbol, pc, info, last } = target(req.params.symbol);
      const input = priceSetSchema.parse(req.body);
      const to = checkPrice(info, input.price);
      const now = Date.now();
      const control: StoredPriceControl = {
        since: pc.control?.since ?? now,
        from: last,
        to,
        startAt: now,
        endAt: now + input.durationMin * 60_000,
        volatilityPct: input.volatilityPct,
        reason: input.reason,
        by: admin.email,
      };
      await db.tx(async (tx) => {
        await save(tx, symbol, control);
        await audit(tx, admin, 'PRICE_SET', 'symbol', symbol, {
          reason: input.reason,
          from: last,
          to,
          changePct: pct(last, to),
          durationMin: input.durationMin,
          volatilityPct: input.volatilityPct,
          binancePrice: pc.ref,
          enteredManual: !pc.control,
        });
      });
      market.setPriceControl(symbol, toControl(control));
      res.json({ ok: true, from: last, to, endAt: control.endAt });
    }),
  );

  /** Về giá thực tế (Binance) */
  r.post(
    '/prices/:symbol/live',
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { symbol, pc, last } = target(req.params.symbol);
      const { reason } = priceModeSchema.parse(req.body);
      if (!pc.control) throw new AppError(409, 'NOT_MANUAL', 'Cặp đang dùng giá thực tế');
      const since = pc.control.since;
      await db.tx(async (tx) => {
        await save(tx, symbol, null);
        await audit(tx, admin, 'PRICE_MODE_LIVE', 'symbol', symbol, {
          reason,
          manualPrice: last,
          binancePrice: pc.ref,
          manualSince: new Date(since).toISOString(),
          manualMinutes: Math.round((Date.now() - since) / 60_000),
        });
      });
      market.setPriceControl(symbol, null);
      res.json({ ok: true });
    }),
  );
}
