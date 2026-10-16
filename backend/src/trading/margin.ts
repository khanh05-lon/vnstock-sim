import { RULES, buyHoldAmount, marketOrderTypeFor, type StockInfo } from '@vss/shared';
import type { Database } from '../db';
import { forceSellEmail, marginCallEmail } from '../lib/emails';
import { badRequest, notFound } from '../lib/errors';
import { log } from '../lib/logger';
import type { Mailer } from '../lib/mailer';
import { calendarDays, marginMetrics, planBuy, previewAdvance, repayDebt, type MarginMetrics, type MoneyRow } from './cash';
import { dateOnly } from './dto';
import type { TradingEngine } from './engine';

export interface MarginMarket {
  tradeDate: string;
  phase: string;
  opts: { mode: string };
  info(symbol: string): StockInfo | undefined;
  quote(symbol: string): { ref: number; ceil: number; floor: number } | undefined;
  markPrice(symbol: string): number;
}

type FullAccount = MoneyRow & { initial_capital: number; contributed: number; deposit_interest_accrued: number; last_interest_date: string | Date | null; margin_call_at: Date | null };

const fmt = (n: number) => Math.round(n).toLocaleString('en-US');

/**
 * Ký quỹ, ứng trước, lãi:
 *  - Lãi tiền gửi không kỳ hạn tính hằng ngày trên tiền mặt nhàn rỗi, trả vào đầu tháng mới.
 *  - Lãi vay ký quỹ tính hằng ngày trên dư nợ gốc, cộng dồn; trả khi tiền bán về hoặc trả nợ chủ động.
 *  - Theo dõi tỷ lệ ký quỹ thực tế: dưới tỷ lệ duy trì → cảnh báo (email + realtime); dưới tỷ lệ xử lý →
 *    huỷ lệnh mua đang chờ và bán giải chấp đủ để đưa tỷ lệ về mức ban đầu.
 */
export class MarginService {
  notify: (userId: string, event: { status: string; ratio: number; message: string }) => void = () => undefined;
  private timer: NodeJS.Timeout | null = null;
  private checking = false;

  constructor(
    private db: Database,
    private market: MarginMarket,
    private engine: TradingEngine,
    private mailer: Mailer | null = null,
  ) {}

  private async stockValue(userId: string): Promise<number> {
    const hs = await this.db.many<{ symbol: string; qty_total: number }>('SELECT symbol, qty_total FROM holdings WHERE user_id = $1', [userId]);
    return hs.reduce((s, h) => s + h.qty_total * this.market.markPrice(h.symbol), 0);
  }

  /** Số liệu tiền, ứng trước, ký quỹ của 1 tài khoản (trả cho giao diện) */
  async summary(userId: string) {
    const a = await this.db.one<FullAccount>('SELECT * FROM accounts WHERE user_id = $1', [userId]);
    if (!a) throw notFound('Không tìm thấy tài khoản');
    const stock = await this.stockValue(userId);
    const m = marginMetrics(a, stock);
    const adv = await previewAdvance(this.db, userId, this.market.tradeDate);
    return { account: a, metrics: m, advance: adv };
  }

  async setAutoAdvance(userId: string, on: boolean) {
    await this.db.many('UPDATE accounts SET auto_advance = $2, updated_at = now() WHERE user_id = $1', [userId, on]);
  }

  /** Người dùng kích hoạt ký quỹ (đã đọc cảnh báo rủi ro) với hạn mức mặc định; tắt khi không còn nợ */
  async setEnabled(userId: string, enabled: boolean) {
    const a = await this.db.one<FullAccount>('SELECT * FROM accounts WHERE user_id = $1', [userId]);
    if (!a) throw notFound('Không tìm thấy tài khoản');
    if (!enabled && (a.loan_balance > 0 || a.loan_interest > 0 || a.loan_hold > 0)) throw badRequest('HAS_DEBT', 'Hãy trả hết nợ ký quỹ và huỷ lệnh mua dùng tiền vay trước khi tắt ký quỹ');
    await this.db.many('UPDATE accounts SET margin_enabled = $2, credit_limit = CASE WHEN $2 THEN GREATEST(credit_limit, $3) ELSE 0 END, updated_at = now() WHERE user_id = $1', [
      userId,
      enabled,
      RULES.margin.defaultCreditLimit,
    ]);
  }

  /** Quản trị viên đặt hạn mức vay cho 1 tài khoản */
  async setCreditLimit(userId: string, limit: number) {
    const row = await this.db.one('UPDATE accounts SET credit_limit = $2, margin_enabled = $2 > 0 OR margin_enabled, updated_at = now() WHERE user_id = $1 RETURNING user_id', [userId, limit]);
    if (!row) throw notFound('Không tìm thấy tài khoản');
  }

  async repay(userId: string, amount: number | null) {
    const r = await this.db.tx((tx) => repayDebt(tx, userId, amount));
    if (!r.interest && !r.principal) throw badRequest('NOTHING', 'Không có nợ cần trả hoặc không đủ tiền mặt khả dụng');
    return r;
  }

  /**
   * Sức mua tối đa (số cổ phiếu) cho 1 mã ở 1 mức giá: tính đúng như khi đặt lệnh (tiền mặt, ứng trước, vay ký quỹ
   * trong hạn mức, tỷ lệ cho vay của mã, tỷ lệ ký quỹ ban đầu).
   */
  async buyingPower(userId: string, symbol: string, price: number) {
    const info = this.market.info(symbol);
    if (!info) throw notFound('Mã không tồn tại');
    const { account: a, advance } = await this.summary(userId);
    const avail = a.cash_balance - a.cash_hold;
    const stock = await this.stockValue(userId);
    const feeRate = RULES.feeRate;
    const fits = (qty: number) => {
      const hold = buyHoldAmount(price, qty, feeRate);
      const plan = planBuy({
        hold,
        avail,
        advanceableNet: a.auto_advance ? advance.maxNet : 0,
        autoAdvance: a.auto_advance,
        marginEnabled: a.margin_enabled,
        symbolRatio: info.marginRatio ?? 0,
        creditAvail: Number(a.credit_limit) - Number(a.loan_balance) - Number(a.loan_hold),
      });
      if ('error' in plan) return null;
      if (plan.loanPart > 0) {
        const s = stock + qty * price;
        const debt = Number(a.loan_balance) + Number(a.loan_interest) + Number(a.loan_hold) + plan.loanPart;
        const pendingLeft = Number(a.cash_pending) - (plan.advanceNet > 0 ? Math.round((plan.advanceNet * advance.gross) / Math.max(1, advance.maxNet)) : 0);
        const nd = Math.max(0, debt - (avail - plan.cashPart + plan.advanceNet) - pendingLeft);
        if ((s - nd) / s < RULES.margin.initialRatio) return null;
      }
      return plan;
    };
    const lot = RULES.lotSize;
    const maxQ = RULES.maxOrderQty[info.exchange];
    let lo = 0;
    let hi = Math.floor(maxQ / lot);
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid * lot)) lo = mid;
      else hi = mid - 1;
    }
    const qty = lo * lot;
    const plan = qty ? fits(qty) : null;
    // lô lẻ còn mua thêm được (chỉ khi chưa đủ 1 lô)
    let odd = 0;
    if (!qty) for (let q = lot - 1; q >= 1; q--) if (fits(q)) { odd = q; break; }
    const cashOnly = Math.floor(Math.max(0, avail) / (price * (1 + feeRate)));
    return {
      maxQty: qty || odd,
      cashOnlyQty: cashOnly - (cashOnly >= lot ? cashOnly % lot : 0),
      usesAdvance: !!plan?.advanceNet,
      usesMargin: !!plan?.loanPart,
      loanPart: plan?.loanPart ?? 0,
      marginRatio: info.marginRatio ?? 0,
    };
  }

  /* ------------------------------ lãi hằng ngày ------------------------------ */

  async accrueInterest(tradeDate = this.market.tradeDate): Promise<number> {
    const accts = await this.db.many<FullAccount>('SELECT * FROM accounts WHERE last_interest_date IS NULL OR last_interest_date < $1', [tradeDate]);
    let n = 0;
    for (const a0 of accts) {
      await this.db.tx(async (tx) => {
        const a = (await tx.one<FullAccount>('SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE', [a0.user_id]))!;
        const last = a.last_interest_date ? dateOnly(a.last_interest_date) : null;
        if (last && last >= tradeDate) return;
        const days = last ? calendarDays(last, tradeDate) : 0;
        let accrued = Number(a.deposit_interest_accrued);
        let bal = a.cash_balance;
        // Sang tháng mới: trả lãi tiền gửi đã cộng dồn
        if (last && last.slice(0, 7) !== tradeDate.slice(0, 7) && accrued > 0) {
          bal += accrued;
          await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'INTEREST',$2,$3,$4)`, [
            a.user_id,
            accrued,
            bal,
            `Lãi tiền gửi không kỳ hạn tháng ${last.slice(5, 7)}/${last.slice(0, 4)} (${(RULES.depositRateYear * 100).toFixed(2)}%/năm)`,
          ]);
          accrued = 0;
        }
        const idle = Math.max(0, a.cash_balance - a.cash_hold);
        accrued += Math.round((idle * RULES.depositRateYear * days) / 365);
        const loanInt = Math.round((Number(a.loan_balance) * RULES.margin.interestRateYear * days) / 365);
        await tx.many(
          `UPDATE accounts SET cash_balance = $2, deposit_interest_accrued = $3, loan_interest = loan_interest + $4, last_interest_date = $5, updated_at = now()
           WHERE user_id = $1`,
          [a.user_id, bal, accrued, loanInt, tradeDate],
        );
        // Lãi tiền gửi vừa trả cũng là tiền về: tự trả nợ ký quỹ (lãi trước, gốc sau)
        if (bal > a.cash_balance && Number(a.loan_balance) + Number(a.loan_interest) + loanInt > 0) await repayDebt(tx, a.user_id);
        n++;
      });
    }
    return n;
  }

  /* ------------------------------ theo dõi tỷ lệ ký quỹ ------------------------------ */

  start(everyMs = 15_000) {
    if (this.timer) return;
    this.timer = setInterval(() => void this.check(), everyMs);
    this.timer.unref?.();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async check(): Promise<{ calls: number; forced: number }> {
    if (this.checking) return { calls: 0, forced: 0 };
    this.checking = true;
    let calls = 0;
    let forced = 0;
    try {
      const accts = await this.db.many<FullAccount & { email: string; full_name: string }>(
        `SELECT a.*, u.email, u.full_name FROM accounts a JOIN users u ON u.id = a.user_id
         WHERE a.loan_balance + a.loan_interest > 0 OR a.margin_status <> 'NORMAL'`,
      );
      for (const a of accts) {
        const m = marginMetrics(a, await this.stockValue(a.user_id));
        if (m.status !== a.margin_status) {
          await this.db.many(`UPDATE accounts SET margin_status = $2, margin_call_at = CASE WHEN $2 = 'NORMAL' THEN NULL ELSE COALESCE(margin_call_at, now()) END WHERE user_id = $1`, [
            a.user_id,
            m.status,
          ]);
          if (m.status === 'CALL' || (m.status === 'FORCE' && a.margin_status === 'NORMAL')) {
            calls++;
            this.notify(a.user_id, {
              status: m.status,
              ratio: m.ratio,
              message: `Tỷ lệ ký quỹ ${(m.ratio * 100).toFixed(1)}% dưới mức duy trì ${Math.round(RULES.margin.callRatio * 100)}% — nộp thêm ~${fmt(m.callAmount)}đ hoặc bán bớt cổ phiếu`,
            });
            if (this.mailer) {
              void this.mailer
                .send({ to: a.email, ...marginCallEmail(a.full_name, m.ratio * 100, Math.round(RULES.margin.callRatio * 100), Math.round(RULES.margin.forceRatio * 100), m.callAmount) })
                .catch((err) => log.error('[margin] gửi email cảnh báo thất bại', { err }));
            }
          } else if (m.status === 'NORMAL') {
            this.notify(a.user_id, { status: 'NORMAL', ratio: m.ratio, message: 'Tỷ lệ ký quỹ đã về mức an toàn' });
          }
        }
        if (m.status === 'FORCE' && this.market.phase === 'CONTINUOUS' && !this.engine.control.haltAll) {
          if (await this.forceSell(a, m)) forced++;
        }
      }
    } catch (err) {
      log.error('[margin] lỗi kiểm tra tỷ lệ ký quỹ', { err });
    } finally {
      this.checking = false;
    }
    return { calls, forced };
  }

  /** Bán giải chấp: huỷ lệnh mua đang chờ, bán từ mã có giá trị lớn nhất cho tới khi đủ số tiền cần thu về */
  private async forceSell(a: FullAccount & { email: string; full_name: string }, m: MarginMetrics): Promise<boolean> {
    const pending = await this.db.one(`SELECT 1 FROM orders WHERE user_id = $1 AND source = 'FORCE_SELL' AND status IN ('PENDING','PARTIAL')`, [a.user_id]);
    if (pending) return false;
    const buys = await this.db.many<{ id: number }>(`SELECT id FROM orders WHERE user_id = $1 AND side = 'BUY' AND status IN ('PENDING','PARTIAL')`, [a.user_id]);
    for (const b of buys) await this.engine.adminCancel(b.id, 'Hệ thống huỷ lệnh mua do tài khoản dưới tỷ lệ ký quỹ xử lý').catch(() => undefined);
    const hs = await this.db.many<{ symbol: string; qty_available: number }>('SELECT symbol, qty_available FROM holdings WHERE user_id = $1 AND qty_available > 0', [a.user_id]);
    const items = hs
      .map((h) => ({ ...h, price: this.market.markPrice(h.symbol), info: this.market.info(h.symbol) }))
      .filter((h) => h.info && h.price > 0)
      .sort((x, y) => y.qty_available * y.price - x.qty_available * x.price);
    let need = m.sellAmount;
    const lines: string[] = [];
    const lot = RULES.lotSize;
    for (const h of items) {
      if (need <= 0) break;
      const info = h.info!;
      let qty = Math.min(h.qty_available, Math.ceil(need / h.price));
      qty = qty >= lot ? Math.min(h.qty_available - (h.qty_available % lot), Math.ceil(qty / lot) * lot) : qty;
      if (qty <= 0) qty = Math.min(h.qty_available, lot - 1);
      const odd = qty < lot;
      const q = this.market.quote(h.symbol)!;
      const mkt = odd ? null : marketOrderTypeFor(info.exchange);
      try {
        const o = await this.engine.placeOrder(
          a.user_id,
          { symbol: h.symbol, side: 'SELL', orderType: mkt ?? 'LO', price: mkt ? null : q.floor, qty },
          { source: 'FORCE_SELL' },
        );
        lines.push(`Bán ${fmt(qty)} ${h.symbol} (${mkt ?? `LO ${fmt(q.floor)}`}) — lệnh #${o.id}`);
        need -= qty * h.price;
      } catch (err) {
        log.error('[margin] không đặt được lệnh bán giải chấp', { err, userId: a.user_id, symbol: h.symbol });
      }
    }
    if (!lines.length) return false;
    log.warn('[margin] bán giải chấp', { userId: a.user_id, ratio: m.ratio, sellAmount: m.sellAmount });
    this.notify(a.user_id, { status: 'FORCE', ratio: m.ratio, message: `Hệ thống đã đặt ${lines.length} lệnh bán giải chấp` });
    if (this.mailer) {
      void this.mailer.send({ to: a.email, ...forceSellEmail(a.full_name, lines) }).catch((err) => log.error('[margin] gửi email giải chấp thất bại', { err }));
    }
    return true;
  }
}
