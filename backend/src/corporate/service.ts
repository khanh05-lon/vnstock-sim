import { RULES, roundToTick, type StockInfo } from '@vss/shared';
import { z } from 'zod';
import type { Database, Queryable } from '../db';
import { addTradingDays, skipWeekendsFor, vnTimeToMs } from '../lib/calendar';
import { badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import { couponDates } from '../market/instruments';
import type { MarketService } from '../market/marketService';
import type { ConditionalEngine } from '../trading/conditional';
import { dateOnly } from '../trading/dto';
import type { TradingEngine } from '../trading/engine';

export type CaType = 'CASH_DIVIDEND' | 'STOCK_DIVIDEND' | 'SPLIT' | 'RIGHTS';

export const CA_LABEL: Record<CaType, string> = {
  CASH_DIVIDEND: 'Cổ tức bằng tiền',
  STOCK_DIVIDEND: 'Cổ tức bằng cổ phiếu / thưởng',
  SPLIT: 'Chia tách cổ phiếu',
  RIGHTS: 'Quyền mua cổ phiếu phát hành thêm',
};

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Ngày không hợp lệ');

export const corporateActionSchema = z
  .object({
    symbol: z.string().trim().toUpperCase(),
    type: z.enum(['CASH_DIVIDEND', 'STOCK_DIVIDEND', 'SPLIT', 'RIGHTS']),
    exDate: dateStr,
    payDate: dateStr,
    cashPerShare: z.number().int().positive().max(1_000_000).nullable().optional(),
    ratioFrom: z.number().int().positive().max(1000).nullable().optional(),
    ratioTo: z.number().int().positive().max(1000).nullable().optional(),
    issuePrice: z.number().int().positive().nullable().optional(),
    subscribeUntil: dateStr.nullable().optional(),
    note: z.string().trim().max(300).optional(),
  })
  .strict()
  .refine((o) => o.type !== 'CASH_DIVIDEND' || (o.cashPerShare ?? 0) > 0, { message: 'Nhập cổ tức (đồng / cổ phiếu)', path: ['cashPerShare'] })
  .refine((o) => o.type === 'CASH_DIVIDEND' || ((o.ratioFrom ?? 0) > 0 && (o.ratioTo ?? 0) > 0), { message: 'Nhập tỷ lệ a : b', path: ['ratioFrom'] })
  .refine((o) => o.type !== 'RIGHTS' || ((o.issuePrice ?? 0) > 0 && !!o.subscribeUntil), { message: 'Quyền mua cần giá phát hành và hạn đăng ký', path: ['issuePrice'] })
  .refine((o) => o.payDate >= o.exDate, { message: 'Ngày thanh toán phải từ ngày GDKHQ trở đi', path: ['payDate'] });

export type CorporateActionInput = z.infer<typeof corporateActionSchema>;

interface ActionRow {
  id: number;
  symbol: string;
  type: CaType;
  ex_date: string | Date;
  record_date: string | Date;
  pay_date: string | Date;
  cash_per_share: number | null;
  ratio_from: number | null;
  ratio_to: number | null;
  issue_price: number | null;
  subscribe_until: string | Date | null;
  status: 'ANNOUNCED' | 'EX_DONE' | 'COMPLETED' | 'CANCELLED';
  ref_before: number | null;
  ref_after: number | null;
  note: string | null;
  created_by: string | null;
  created_at: Date;
  processed_at: Date | null;
}

export const toActionDTO = (a: ActionRow & { holders?: number }) => ({
  id: a.id,
  symbol: a.symbol,
  type: a.type,
  label: CA_LABEL[a.type],
  exDate: dateOnly(a.ex_date),
  recordDate: dateOnly(a.record_date),
  payDate: dateOnly(a.pay_date),
  cashPerShare: a.cash_per_share,
  ratioFrom: a.ratio_from,
  ratioTo: a.ratio_to,
  issuePrice: a.issue_price,
  subscribeUntil: a.subscribe_until ? dateOnly(a.subscribe_until) : null,
  status: a.status,
  refBefore: a.ref_before,
  refAfter: a.ref_after,
  note: a.note,
  createdBy: a.created_by,
  createdAt: new Date(a.created_at).toISOString(),
  holders: a.holders,
});

const fmt = (n: number) => n.toLocaleString('en-US');

/** Giá tham chiếu điều chỉnh ngày GDKHQ (công thức của Sở GDCK) */
export function adjustedRef(a: Pick<ActionRow, 'type' | 'cash_per_share' | 'ratio_from' | 'ratio_to' | 'issue_price'>, ref: number): number {
  const af = a.ratio_from ?? 1;
  const bt = a.ratio_to ?? 0;
  switch (a.type) {
    case 'CASH_DIVIDEND':
      return ref - (a.cash_per_share ?? 0);
    case 'STOCK_DIVIDEND':
      // sở hữu a CP nhận thêm b CP: P' = P × a / (a + b)
      return (ref * af) / (af + bt);
    case 'SPLIT':
      // a CP cũ thành b CP: P' = P × a / b
      return (ref * af) / bt;
    case 'RIGHTS':
      // a CP được mua b CP giá S: P' = (P × a + S × b) / (a + b)
      return (ref * af + (a.issue_price ?? 0) * bt) / (af + bt);
  }
}

/** Số cổ phiếu được nhận thêm / được quyền mua (làm tròn xuống, phần lẻ bị huỷ) */
export function entitledShares(a: Pick<ActionRow, 'type' | 'ratio_from' | 'ratio_to'>, held: number): number {
  const af = a.ratio_from ?? 1;
  const bt = a.ratio_to ?? 0;
  if (a.type === 'SPLIT') return Math.floor((held * bt) / af) - held;
  if (a.type === 'STOCK_DIVIDEND' || a.type === 'RIGHTS') return Math.floor((held * bt) / af);
  return 0;
}

/**
 * Xử lý sự kiện quyền và vòng đời chứng quyền / trái phiếu — chạy đầu mỗi ngày giao dịch (sau khi chốt giá tham chiếu):
 *  1. Ngày GDKHQ: điều chỉnh giá tham chiếu + lịch sử giá (nguồn giả lập), chốt danh sách người được hưởng,
 *     huỷ lệnh nhiều ngày / lệnh điều kiện của mã.
 *  2. Ngày thanh toán: trả cổ tức tiền (trừ thuế), cổ phiếu thưởng / chia tách, cổ phiếu mua theo quyền.
 *  3. Chứng quyền đáo hạn: thanh toán bằng tiền (giá cơ sở bình quân 5 phiên trước đáo hạn − giá thực hiện) / tỷ lệ.
 *  4. Trái phiếu: trả lãi coupon theo kỳ, đáo hạn trả mệnh giá.
 */
export class CorporateService {
  /** Thông báo người dùng có thay đổi tài khoản do sự kiện quyền */
  notify: (userId: string) => void = () => undefined;

  constructor(
    private db: Database,
    private market: MarketService,
    private engine: TradingEngine,
    private cond: ConditionalEngine | null,
    /** true khi giá lấy từ nguồn thật: Sở đã tự điều chỉnh giá tham chiếu → chỉ xử lý quyền của nhà đầu tư */
    private live: () => boolean = () => false,
  ) {}

  /* ------------------------------ quản trị ------------------------------ */

  async create(input: CorporateActionInput, by: string) {
    const info = this.market.info(input.symbol);
    if (!info) throw notFound(`Mã ${input.symbol} không có trên bảng giá`);
    if (info.type !== 'STOCK' && info.type !== 'ETF') throw badRequest('CA_TYPE', 'Sự kiện quyền chỉ áp dụng cho cổ phiếu / chứng chỉ quỹ');
    const td = this.market.tradeDate;
    if (input.exDate <= td) throw badRequest('EX_DATE', `Ngày GDKHQ phải sau ngày giao dịch hiện tại (${td}) — giá tham chiếu được điều chỉnh trước phiên mở cửa`);
    if (input.type === 'RIGHTS' && (input.subscribeUntil! < input.exDate || input.subscribeUntil! > input.payDate)) {
      throw badRequest('SUBSCRIBE', 'Hạn đăng ký mua phải nằm giữa ngày GDKHQ và ngày phát hành');
    }
    if (input.type === 'SPLIT' && input.ratioTo! <= input.ratioFrom!) throw badRequest('RATIO', 'Chia tách: số cổ phiếu mới phải lớn hơn số cũ (vd. 1 : 2)');
    const ref = this.market.quote(input.symbol)!.ref;
    if (input.type === 'CASH_DIVIDEND' && input.cashPerShare! >= ref) throw badRequest('CASH', 'Cổ tức phải nhỏ hơn giá tham chiếu');
    // Ngày đăng ký cuối cùng = 1 ngày làm việc sau ngày GDKHQ (theo chu kỳ thanh toán T+2)
    const recordDate = addTradingDays(input.exDate, 1, skipWeekendsFor(this.market.opts.mode));
    const row = await this.db.one<ActionRow>(
      `INSERT INTO corporate_actions (symbol, type, ex_date, record_date, pay_date, cash_per_share, ratio_from, ratio_to, issue_price, subscribe_until, note, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12) RETURNING *`,
      [
        input.symbol,
        input.type,
        input.exDate,
        recordDate > input.payDate ? input.exDate : recordDate,
        input.payDate,
        input.type === 'CASH_DIVIDEND' ? input.cashPerShare : null,
        input.type === 'CASH_DIVIDEND' ? null : input.ratioFrom,
        input.type === 'CASH_DIVIDEND' ? null : input.ratioTo,
        input.type === 'RIGHTS' ? input.issuePrice : null,
        input.type === 'RIGHTS' ? input.subscribeUntil : null,
        input.note ?? null,
        by,
      ],
    );
    return toActionDTO(row!);
  }

  async cancel(id: number) {
    const row = await this.db.one<ActionRow>(`UPDATE corporate_actions SET status = 'CANCELLED' WHERE id = $1 AND status = 'ANNOUNCED' RETURNING *`, [id]);
    if (!row) throw badRequest('NOT_CANCELLABLE', 'Chỉ huỷ được sự kiện chưa tới ngày GDKHQ');
    return toActionDTO(row);
  }

  async list(opts: { symbol?: string; upcoming?: boolean; limit?: number } = {}) {
    const params: unknown[] = [];
    const where: string[] = [];
    if (opts.symbol) {
      params.push(opts.symbol);
      where.push(`a.symbol = $${params.length}`);
    }
    if (opts.upcoming) where.push(`a.status IN ('ANNOUNCED','EX_DONE')`);
    params.push(opts.limit ?? 200);
    const rows = await this.db.many<ActionRow & { holders: number }>(
      `SELECT a.*, (SELECT count(*)::int FROM ca_entitlements e WHERE e.action_id = a.id) AS holders
       FROM corporate_actions a ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY a.ex_date DESC, a.id DESC LIMIT $${params.length}`,
      params,
    );
    return rows.map(toActionDTO);
  }

  /* ------------------------------ nhà đầu tư ------------------------------ */

  async entitlements(userId: string) {
    const rows = await this.db.many<
      ActionRow & { e_id: number; qty_held: number; cash_amount: number; tax_amount: number; shares: number; subscribed: number; e_status: string; paid_at: Date | null }
    >(
      `SELECT a.*, e.id AS e_id, e.qty_held, e.cash_amount, e.tax_amount, e.shares, e.subscribed, e.status AS e_status, e.paid_at
       FROM ca_entitlements e JOIN corporate_actions a ON a.id = e.action_id WHERE e.user_id = $1 ORDER BY a.ex_date DESC LIMIT 200`,
      [userId],
    );
    return rows.map((r) => ({
      id: r.e_id,
      action: toActionDTO(r),
      qtyHeld: r.qty_held,
      cashAmount: Number(r.cash_amount),
      taxAmount: Number(r.tax_amount),
      shares: r.shares,
      subscribed: r.subscribed,
      status: r.e_status as 'PENDING' | 'PAID' | 'CANCELLED',
      paidAt: r.paid_at ? new Date(r.paid_at).toISOString() : null,
    }));
  }

  /** Đăng ký mua cổ phiếu phát hành thêm theo quyền: trừ tiền ngay, cổ phiếu về vào ngày phát hành */
  async subscribe(userId: string, actionId: number, qty: number) {
    if (!Number.isInteger(qty) || qty <= 0) throw badRequest('QTY', 'Số lượng đăng ký không hợp lệ');
    const td = this.market.tradeDate;
    const res = await this.db.tx(async (tx) => {
      const a = await tx.one<ActionRow>('SELECT * FROM corporate_actions WHERE id = $1', [actionId]);
      if (!a || a.type !== 'RIGHTS') throw notFound('Không tìm thấy quyền mua');
      if (a.status !== 'EX_DONE' || td > dateOnly(a.subscribe_until!)) throw badRequest('CLOSED', 'Đã hết thời gian đăng ký mua');
      const e = await tx.one<{ id: number; shares: number; subscribed: number }>(
        'SELECT id, shares, subscribed FROM ca_entitlements WHERE action_id = $1 AND user_id = $2 FOR UPDATE',
        [actionId, userId],
      );
      if (!e) throw badRequest('NO_RIGHTS', 'Bạn không có quyền mua trong đợt này');
      if (qty > e.shares - e.subscribed) throw badRequest('QTY', `Bạn chỉ còn được mua tối đa ${fmt(e.shares - e.subscribed)} CP`);
      const amount = qty * a.issue_price!;
      const acct = await tx.one<{ cash_balance: number; cash_hold: number }>('SELECT cash_balance, cash_hold FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
      if (!acct || acct.cash_balance - acct.cash_hold < amount) throw badRequest('INSUFFICIENT_CASH', `Không đủ tiền: cần ${fmt(amount)}đ`);
      const balance = acct.cash_balance - amount;
      await tx.many('UPDATE accounts SET cash_balance = $2, updated_at = now() WHERE user_id = $1', [userId, balance]);
      await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'RIGHTS',$2,$3,$4)`, [
        userId,
        -amount,
        balance,
        `Đăng ký mua ${fmt(qty)} ${a.symbol} phát hành thêm giá ${fmt(a.issue_price!)}đ`,
      ]);
      await tx.many('UPDATE ca_entitlements SET subscribed = subscribed + $2 WHERE id = $1', [e.id, qty]);
      return { subscribed: e.subscribed + qty, amount };
    });
    this.notify(userId);
    return res;
  }

  /** Giá trị quyền chờ về theo người dùng (cộng vào tài sản ròng) */
  async rightsValue(userIds: string[] | null): Promise<Map<string, number>> {
    const filter = userIds ? `AND e.user_id IN (${userIds.map((_, i) => `$${i + 1}`).join(',') || 'NULL'})` : '';
    const rows = await this.db.many<{ user_id: string; type: CaType; symbol: string; cash_amount: number; tax_amount: number; shares: number; subscribed: number }>(
      `SELECT e.user_id, a.type, a.symbol, e.cash_amount, e.tax_amount, e.shares, e.subscribed
       FROM ca_entitlements e JOIN corporate_actions a ON a.id = e.action_id WHERE e.status = 'PENDING' ${filter}`,
      userIds ?? [],
    );
    const out = new Map<string, number>();
    for (const r of rows) {
      const px = this.market.markPrice(r.symbol);
      const v =
        r.type === 'CASH_DIVIDEND' ? Number(r.cash_amount) - Number(r.tax_amount) : r.type === 'RIGHTS' ? r.subscribed * px : r.shares * px;
      out.set(r.user_id, (out.get(r.user_id) ?? 0) + v);
    }
    return out;
  }

  /* ------------------------------ xử lý hằng ngày ------------------------------ */

  async processDay(tradeDate = this.market.tradeDate): Promise<void> {
    const steps: [string, () => Promise<unknown>][] = [
      ['GDKHQ', () => this.processExDates(tradeDate)],
      ['thanh toán quyền', () => this.processPayDates(tradeDate)],
      ['chứng quyền đáo hạn', () => this.settleWarrants(tradeDate)],
      ['trái phiếu', () => this.processBonds(tradeDate)],
    ];
    for (const [name, fn] of steps) {
      try {
        await fn();
      } catch (err) {
        log.error(`[corporate] lỗi xử lý ${name}`, { err, tradeDate });
      }
    }
  }

  async processExDates(tradeDate: string): Promise<number> {
    const actions = await this.db.many<ActionRow>(`SELECT * FROM corporate_actions WHERE status = 'ANNOUNCED' AND ex_date <= $1 ORDER BY ex_date, id`, [tradeDate]);
    for (const a of actions) {
      const q = this.market.quote(a.symbol);
      const info = this.market.info(a.symbol);
      if (!q || !info) {
        await this.db.many(`UPDATE corporate_actions SET status = 'CANCELLED', note = COALESCE(note, '') || ' (mã không còn giao dịch)' WHERE id = $1`, [a.id]);
        continue;
      }
      const refBefore = q.ref;
      let refAfter = refBefore;
      // Lệnh nhiều ngày / lệnh điều kiện đặt theo giá cũ bị huỷ trong ngày GDKHQ
      await this.engine.cancelAllForSymbol(a.symbol, `Huỷ do ${a.symbol} giao dịch không hưởng quyền (${CA_LABEL[a.type].toLowerCase()})`);
      await this.cond?.cancelForSymbol(a.symbol, `Huỷ do ${a.symbol} giao dịch không hưởng quyền`);
      if (!this.live()) {
        refAfter = Math.max(roundToTick(info, 1), roundToTick(info, adjustedRef(a, refBefore)));
        const k = refAfter / refBefore;
        const shareFactor = a.type === 'STOCK_DIVIDEND' ? ((a.ratio_from ?? 1) + (a.ratio_to ?? 0)) / (a.ratio_from ?? 1) : a.type === 'SPLIT' ? (a.ratio_to ?? 1) / (a.ratio_from ?? 1) : 1;
        await this.db.tx(async (tx) => {
          // Giá lịch sử điều chỉnh để biểu đồ không bị "gãy" tại ngày GDKHQ
          await tx.many(
            `UPDATE ohlcv_daily SET open = round(open * $3::float8), high = round(high * $3::float8), low = round(low * $3::float8),
             close = round(close * $3::float8), volume = round(volume / $4::float8) WHERE symbol = $1 AND trade_date < $2`,
            [a.symbol, dateOnly(a.ex_date), k, shareFactor],
          );
          await tx.many(
            `UPDATE ohlcv_intraday SET open = round(open * $3::float8), high = round(high * $3::float8), low = round(low * $3::float8),
             close = round(close * $3::float8) WHERE symbol = $1 AND ts < $2`,
            [a.symbol, Math.floor(vnTimeToMs(dateOnly(a.ex_date), 0) / 1000), k],
          );
          if (shareFactor !== 1) await tx.many('UPDATE stocks SET listed_shares = round(listed_shares * $2::float8) WHERE symbol = $1', [a.symbol, shareFactor]);
        });
        this.market.applyCorporateAdjustment(a.symbol, refAfter, shareFactor !== 1 ? Math.round(info.listedShares * shareFactor) : undefined);
      }
      // Chốt danh sách người được hưởng quyền: số CP sở hữu trước ngày GDKHQ (gồm cả CP mua chờ về T+2)
      const holders = await this.db.tx(async (tx) => {
        const hs = await tx.many<{ user_id: string; qty_total: number }>('SELECT user_id, qty_total FROM holdings WHERE symbol = $1 AND qty_total > 0', [a.symbol]);
        for (const h of hs) {
          const cash = a.type === 'CASH_DIVIDEND' ? h.qty_total * (a.cash_per_share ?? 0) : 0;
          const tax = Math.round(cash * RULES.dividendTaxRate);
          const shares = entitledShares(a, h.qty_total);
          if (!cash && !shares) continue;
          await tx.many(
            `INSERT INTO ca_entitlements (action_id, user_id, qty_held, cash_amount, tax_amount, shares) VALUES ($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
            [a.id, h.user_id, h.qty_total, cash, tax, shares],
          );
        }
        await tx.many(`UPDATE corporate_actions SET status = 'EX_DONE', ref_before = $2, ref_after = $3, processed_at = now() WHERE id = $1`, [a.id, refBefore, refAfter]);
        return hs.map((h) => h.user_id);
      });
      for (const u of holders) this.notify(u);
      log.info(`[corporate] ${a.symbol} GDKHQ ${CA_LABEL[a.type]}: tham chiếu ${fmt(refBefore)} → ${fmt(refAfter)}, ${holders.length} người được hưởng`);
    }
    return actions.length;
  }

  async processPayDates(tradeDate: string): Promise<number> {
    const actions = await this.db.many<ActionRow>(`SELECT * FROM corporate_actions WHERE status = 'EX_DONE' AND pay_date <= $1 ORDER BY pay_date, id`, [tradeDate]);
    for (const a of actions) {
      const paid = await this.db.tx(async (tx) => {
        const ents = await tx.many<{ id: number; user_id: string; cash_amount: number; tax_amount: number; shares: number; subscribed: number; qty_held: number }>(
          `SELECT * FROM ca_entitlements WHERE action_id = $1 AND status = 'PENDING' FOR UPDATE`,
          [a.id],
        );
        const users: string[] = [];
        for (const e of ents) {
          if (a.type === 'CASH_DIVIDEND') {
            const acct = await tx.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1 FOR UPDATE', [e.user_id]);
            let bal = (acct?.cash_balance ?? 0) + Number(e.cash_amount);
            await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'DIVIDEND',$2,$3,$4)`, [
              e.user_id,
              e.cash_amount,
              bal,
              `Cổ tức ${a.symbol}: ${fmt(e.qty_held)} CP × ${fmt(a.cash_per_share!)}đ`,
            ]);
            if (Number(e.tax_amount) > 0) {
              bal -= Number(e.tax_amount);
              await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'TAX',$2,$3,$4)`, [
                e.user_id,
                -e.tax_amount,
                bal,
                `Thuế TNCN ${RULES.dividendTaxRate * 100}% cổ tức ${a.symbol}`,
              ]);
            }
            await tx.many('UPDATE accounts SET cash_balance = $2, updated_at = now() WHERE user_id = $1', [e.user_id, bal]);
          } else {
            const add = a.type === 'RIGHTS' ? e.subscribed : e.shares;
            if (add > 0) {
              const cost = a.type === 'RIGHTS' ? add * (a.issue_price ?? 0) : 0;
              await tx.many(
                `INSERT INTO holdings (user_id, symbol, qty_total, qty_available, total_cost) VALUES ($1,$2,$3,$3,$4)
                 ON CONFLICT (user_id, symbol) DO UPDATE SET qty_total = holdings.qty_total + $3, qty_available = holdings.qty_available + $3,
                 total_cost = holdings.total_cost + $4`,
                [e.user_id, a.symbol, add, cost],
              );
            }
          }
          await tx.many(`UPDATE ca_entitlements SET status = 'PAID', paid_at = now() WHERE id = $1`, [e.id]);
          users.push(e.user_id);
        }
        await tx.many(`UPDATE corporate_actions SET status = 'COMPLETED' WHERE id = $1`, [a.id]);
        return users;
      });
      for (const u of paid) this.notify(u);
      log.info(`[corporate] ${a.symbol} thanh toán ${CA_LABEL[a.type]} cho ${paid.length} người`);
    }
    return actions.length;
  }

  /**
   * Rút mã khỏi giao dịch và trả tiền cho người nắm giữ (chứng quyền đáo hạn, trái phiếu đáo hạn).
   * perUnit: số tiền mỗi đơn vị; taxRate: thuế khấu trừ trên số tiền nhận.
   */
  private async retire(symbol: string, reason: string, perUnit: number, ledgerType: 'CW_SETTLE' | 'BOND_REDEEM', describe: (qty: number) => string, taxRate = 0) {
    await this.engine.cancelAllForSymbol(symbol, reason);
    await this.cond?.cancelForSymbol(symbol, reason);
    const users = await this.db.tx(async (tx: Queryable) => {
      const hs = await tx.many<{ user_id: string; qty_total: number }>('SELECT user_id, qty_total FROM holdings WHERE symbol = $1 FOR UPDATE', [symbol]);
      for (const h of hs) {
        const amount = h.qty_total * perUnit;
        const acct = await tx.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1 FOR UPDATE', [h.user_id]);
        let bal = acct?.cash_balance ?? 0;
        if (amount > 0) {
          bal += amount;
          await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,$2,$3,$4,$5)`, [h.user_id, ledgerType, amount, bal, describe(h.qty_total)]);
          const tax = Math.round(amount * taxRate);
          if (tax > 0) {
            bal -= tax;
            await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'TAX',$2,$3,$4)`, [h.user_id, -tax, bal, `Thuế TNCN ${symbol}`]);
          }
          await tx.many('UPDATE accounts SET cash_balance = $2, updated_at = now() WHERE user_id = $1', [h.user_id, bal]);
        }
        await tx.many('DELETE FROM settlement_lots WHERE user_id = $1 AND symbol = $2 AND settled = false', [h.user_id, symbol]);
        await tx.many('DELETE FROM holdings WHERE user_id = $1 AND symbol = $2', [h.user_id, symbol]);
      }
      await tx.many(`UPDATE stocks SET status = 'DELISTED', delisted_at = $2, delist_reason = $3 WHERE symbol = $1`, [symbol, this.market.tradeDate, reason]);
      await tx.many('DELETE FROM watchlists WHERE symbol = $1', [symbol]);
      return hs.map((h) => h.user_id);
    });
    this.market.removeStock(symbol);
    for (const u of users) this.notify(u);
    return users.length;
  }

  async settleWarrants(tradeDate: string): Promise<number> {
    const due = await this.db.many<{ symbol: string; underlying: string; ratio: number; exercise_price: number; maturity_date: string | Date }>(
      `SELECT w.* FROM warrants w JOIN stocks s ON s.symbol = w.symbol WHERE w.settled = false AND s.status = 'ACTIVE' AND w.maturity_date <= $1`,
      [tradeDate],
    );
    for (const w of due) {
      const maturity = dateOnly(w.maturity_date);
      const closes = await this.db.many<{ close: number }>(
        'SELECT close FROM ohlcv_daily WHERE symbol = $1 AND trade_date < $2 ORDER BY trade_date DESC LIMIT 5',
        [w.underlying, maturity],
      );
      const avg = closes.length ? closes.reduce((s, c) => s + Number(c.close), 0) / closes.length : this.market.markPrice(w.underlying);
      const payout = Math.max(0, Math.floor((avg - Number(w.exercise_price)) / Number(w.ratio)));
      const n = await this.retire(
        w.symbol,
        `Chứng quyền đáo hạn ${maturity}`,
        payout,
        'CW_SETTLE',
        (q) => `Thanh toán ${fmt(q)} ${w.symbol} đáo hạn: (giá cơ sở BQ ${fmt(Math.round(avg))} − thực hiện ${fmt(Number(w.exercise_price))}) / ${w.ratio} = ${fmt(payout)}đ/CW`,
        payout > 0 ? RULES.sellTaxRate : 0,
      );
      await this.db.many('UPDATE warrants SET settled = true WHERE symbol = $1', [w.symbol]);
      log.info(`[corporate] chứng quyền ${w.symbol} đáo hạn: thanh toán ${fmt(payout)}đ/CW cho ${n} người`);
    }
    return due.length;
  }

  async processBonds(tradeDate: string): Promise<number> {
    const bonds = await this.db.many<{
      symbol: string;
      par_value: number;
      coupon_rate: number;
      coupon_freq: number;
      issue_date: string | Date;
      maturity_date: string | Date;
      last_coupon_date: string | Date | null;
    }>(`SELECT b.* FROM bonds b JOIN stocks s ON s.symbol = b.symbol WHERE b.redeemed = false AND s.status = 'ACTIVE'`);
    let events = 0;
    for (const b of bonds) {
      const issue = dateOnly(b.issue_date);
      const maturity = dateOnly(b.maturity_date);
      const last = b.last_coupon_date ? dateOnly(b.last_coupon_date) : issue;
      const due = couponDates({ issueDate: issue, maturityDate: maturity, couponFreq: b.coupon_freq }).filter((d) => d > last && d <= tradeDate);
      const coupon = Math.round((Number(b.par_value) * Number(b.coupon_rate)) / b.coupon_freq);
      for (const d of due) {
        const users = await this.db.tx(async (tx) => {
          const hs = await tx.many<{ user_id: string; qty_total: number }>('SELECT user_id, qty_total FROM holdings WHERE symbol = $1 AND qty_total > 0', [b.symbol]);
          for (const h of hs) {
            const gross = h.qty_total * coupon;
            const tax = Math.round(gross * RULES.dividendTaxRate);
            const acct = await tx.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1 FOR UPDATE', [h.user_id]);
            const afterGross = (acct?.cash_balance ?? 0) + gross;
            await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'COUPON',$2,$3,$4)`, [
              h.user_id,
              gross,
              afterGross,
              `Lãi trái phiếu ${b.symbol} kỳ ${d}: ${fmt(h.qty_total)} TP × ${fmt(coupon)}đ`,
            ]);
            await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'TAX',$2,$3,$4)`, [
              h.user_id,
              -tax,
              afterGross - tax,
              `Thuế TNCN ${RULES.dividendTaxRate * 100}% lãi trái phiếu ${b.symbol}`,
            ]);
            await tx.many('UPDATE accounts SET cash_balance = $2, updated_at = now() WHERE user_id = $1', [h.user_id, afterGross - tax]);
          }
          await tx.many('UPDATE bonds SET last_coupon_date = $2 WHERE symbol = $1', [b.symbol, d]);
          return hs.map((h) => h.user_id);
        });
        for (const u of users) this.notify(u);
        events++;
      }
      if (maturity <= tradeDate) {
        await this.retire(b.symbol, `Trái phiếu đáo hạn ${maturity}`, Number(b.par_value), 'BOND_REDEEM', (q) => `Hoàn trả mệnh giá ${fmt(q)} ${b.symbol} đáo hạn`);
        await this.db.many('UPDATE bonds SET redeemed = true WHERE symbol = $1', [b.symbol]);
        events++;
      }
    }
    return events;
  }
}

/** Chứng quyền đã quá ngày giao dịch cuối cùng? */
export function warrantExpired(info: StockInfo, tradeDate: string): boolean {
  return !!info.warrant && tradeDate > info.warrant.lastTradingDate;
}

