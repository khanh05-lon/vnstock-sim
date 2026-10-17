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
import { config } from '../config';
import type { Queryable } from '../db';
import { AppError, ah, badRequest, notFound } from '../lib/errors';
import type { StoredPriceControl } from '../market/symbols';
import type { Approvals } from './approvals';
import { audit, need, symbolParam, type AdminCtx, type AdminDeps, type AdminRequest } from './common';

/**
 * Quản lý giá từng cặp: giá thực tế (Binance) ⇄ giá điều chỉnh (đặt giá / chạy kịch bản) — vai trò Vận hành thị trường.
 * Mọi thao tác bắt buộc lý do, lưu CSDL (giữ sau khi khởi động lại) và ghi nhật ký quản trị chỉ-ghi-thêm.
 * Chỉnh giá lớn (so với giá hiện tại HOẶC giá Binance quá PRICE_APPROVAL_PCT) thành đề xuất, người thứ hai duyệt.
 */
export function mountPriceControl(r: Router, deps: AdminDeps, approvals: Approvals) {
  const { db, market, engine } = deps;

  /** Nhân viên đã đặt lệnh cặp này trong 60 phút qua — dấu hiệu có thể biết trước kịch bản giá */
  const staffRecentOrders = (symbol: string) =>
    db.many<{ email: string; n: number }>(
      `SELECT u.email, count(*)::int AS n FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.symbol = $1 AND u.role <> 'USER' AND o.created_at > now() - interval '60 minutes'
       GROUP BY u.email ORDER BY u.email`,
      [symbol],
    );

  /** Cặp chuyển sang / đổi giá điều chỉnh: huỷ mọi lệnh đang mở của nhân viên trên cặp (không giữ lệnh chờ sẵn) */
  const cancelStaffOrders = async (admin: AdminCtx, symbol: string) => {
    const users = await db.many<{ user_id: string }>(
      `SELECT DISTINCT o.user_id FROM orders o JOIN users u ON u.id = o.user_id
       WHERE o.symbol = $1 AND o.status IN ('NEW','PARTIALLY_FILLED') AND u.role <> 'USER'`,
      [symbol],
    );
    let n = 0;
    for (const u of users) {
      n += await engine.cancelForUserOnSymbol(u.user_id, symbol, `${symbol} ở giá điều chỉnh — nhân viên không được giữ lệnh trên cặp này`, { actor: admin.email });
    }
    return n;
  };

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
    need('admin.view'),
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
    need('admin.view'),
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
    need('market.manage'),
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
      // Tra trước khi mở transaction: trong db.tx chỉ được dùng tx (gọi db.* sẽ khoá chết với PGlite)
      const recent = await staffRecentOrders(symbol);
      await db.tx(async (tx) => {
        await save(tx, symbol, control);
        await audit(tx, admin, 'PRICE_MODE_MANUAL', 'symbol', symbol, {
          reason,
          price: last,
          binancePrice: pc.ref,
          volatilityPct: control.volatilityPct,
          staffRecentOrders: recent,
        });
      });
      market.setPriceControl(symbol, toControl(control));
      res.json({ ok: true, staffOrdersCancelled: await cancelStaffOrders(admin, symbol) });
    }),
  );

  /** Đặt giá / chạy kịch bản — giá xuất phát là giá trên sàn ở thời điểm thực hiện (lúc duyệt, nếu là đề xuất) */
  const applySet = async (
    admin: AdminCtx,
    raw: string,
    input: { price: string; durationMin: number; volatilityPct: number; reason: string },
    extra: Record<string, unknown> = {},
  ) => {
    const { symbol, pc, info, last } = target(raw);
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
    const recent = await staffRecentOrders(symbol);
    await db.tx(async (tx) => {
      await save(tx, symbol, control);
      await audit(tx, admin, 'PRICE_SET', 'symbol', symbol, {
        staffRecentOrders: recent,
        reason: input.reason,
        from: last,
        to,
        changePct: pct(last, to),
        durationMin: input.durationMin,
        volatilityPct: input.volatilityPct,
        binancePrice: pc.ref,
        enteredManual: !pc.control,
        ...extra,
      });
    });
    market.setPriceControl(symbol, toControl(control));
    const staffOrdersCancelled = await cancelStaffOrders(admin, symbol);
    return { from: last, to, endAt: control.endAt, staffOrdersCancelled };
  };

  approvals.register('PRICE_SET', async (admin, req) => {
    const p = req.payload as { price: string; durationMin: number; volatilityPct: number };
    return applySet(admin, req.target!, { ...p, reason: req.reason }, { approvalId: req.id, requestedBy: req.requestedByEmail });
  });

  /**
   * Đặt giá (durationMin = 0: nhảy ngay) hoặc chạy kịch bản tới giá đích; cặp đang ở giá thực tế thì tự chuyển sang giá điều chỉnh.
   * Lệch quá PRICE_APPROVAL_PCT so với giá hiện tại hoặc giá Binance → đề xuất chờ người thứ hai duyệt (202).
   */
  r.post(
    '/prices/:symbol/set',
    need('market.manage'),
    ah(async (req, res) => {
      const { admin } = req as AdminRequest;
      const { symbol, pc, info, last } = target(req.params.symbol);
      const input = priceSetSchema.parse(req.body);
      const to = checkPrice(info, input.price);
      const move = pct(last, to) ?? 0;
      const vsBinance = pc.ref ? (pct(pc.ref, to) ?? 0) : null;
      const limit = config.priceApprovalPct;
      // Có nhân viên vừa đặt lệnh cặp này → chỉnh giá dù nhỏ cũng phải có người thứ hai xem xét
      const recent = await staffRecentOrders(symbol);
      if (Math.abs(move) > limit || (vsBinance != null && Math.abs(vsBinance) > limit) || recent.length) {
        const warn = recent.length ? ` ⚠ Nhân viên đã đặt lệnh ${symbol} trong 60 phút qua: ${recent.map((x) => `${x.email} (${x.n} lệnh)`).join(', ')}` : '';
        const request = await approvals.create(admin, {
          kind: 'PRICE_SET',
          target: symbol,
          payload: {
            price: to,
            durationMin: input.durationMin,
            volatilityPct: input.volatilityPct,
            priceAtRequest: last,
            binancePrice: pc.ref,
            changePct: move,
            vsBinancePct: vsBinance,
            staffRecentOrders: recent,
          },
          summary: `${symbol}: ${last} → ${to} (${move > 0 ? '+' : ''}${move}%${vsBinance != null ? `, lệch giá Binance ${vsBinance > 0 ? '+' : ''}${vsBinance}%` : ''}) ${input.durationMin ? `trong ${input.durationMin} phút` : 'ngay lập tức'}, dao động ±${input.volatilityPct}%.${warn}`,
          reason: input.reason,
        });
        res.status(202).json({ ok: true, pending: true, request });
        return;
      }
      res.json({ ok: true, ...(await applySet(admin, symbol, input)) });
    }),
  );

  /** Về giá thực tế (Binance) */
  r.post(
    '/prices/:symbol/live',
    need('market.manage'),
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
