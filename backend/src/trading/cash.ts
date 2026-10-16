import { RULES } from '@vss/shared';
import type { Queryable } from '../db';
import { dateOnly } from './dto';

/** Các cột tiền của tài khoản (gồm phần ký quỹ / tiền chờ về) */
export interface MoneyRow {
  user_id: string;
  cash_balance: number;
  cash_hold: number;
  cash_pending: number;
  loan_balance: number;
  loan_interest: number;
  loan_hold: number;
  credit_limit: number;
  margin_enabled: boolean;
  auto_advance: boolean;
  margin_status: 'NORMAL' | 'CALL' | 'FORCE';
}

/** Số ngày lịch từ ngày giao dịch hiện tại tới ngày tiền về (tối thiểu 1) */
export const calendarDays = (from: string, to: string) => Math.max(1, Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86400_000));

interface SettlementRow {
  id: number;
  amount: number;
  advanced: number;
  settle_date: string | Date;
}

/** Ứng trước: phí = số tiền ứng × phí/ngày × số ngày còn lại tới ngày tiền về */
const feeFor = (gross: number, days: number, rate: number) => Math.round(gross * rate * days);

/** Có thể ứng tối đa bao nhiêu (trước phí) và thực nhận tối đa bao nhiêu */
export async function previewAdvance(q: Queryable, userId: string, tradeDate: string, rate = RULES.advanceFeeRateDaily) {
  const rows = await q.many<SettlementRow>(
    'SELECT id, amount, advanced, settle_date FROM cash_settlements WHERE user_id = $1 AND settled = false AND advanced < amount ORDER BY settle_date, id',
    [userId],
  );
  let gross = 0;
  let fee = 0;
  const items = rows.map((r) => {
    const avail = Number(r.amount) - Number(r.advanced);
    const days = calendarDays(tradeDate, dateOnly(r.settle_date));
    const f = feeFor(avail, days, rate);
    gross += avail;
    fee += f;
    return { id: r.id, settleDate: dateOnly(r.settle_date), available: avail, days, fee: f };
  });
  return { gross, fee, maxNet: gross - fee, items };
}

/**
 * Ứng trước tiền bán chờ về để thực nhận ít nhất `needNet` (ưu tiên khoản về sớm nhất → phí thấp nhất).
 * Ghi tăng tiền mặt, giảm tiền chờ về, sao kê ADVANCE + ADVANCE_FEE. Phải gọi trong transaction đã khoá dòng tài khoản.
 */
export async function advanceCash(tx: Queryable, userId: string, needNet: number, tradeDate: string, rate = RULES.advanceFeeRateDaily) {
  const rows = await tx.many<SettlementRow>(
    'SELECT id, amount, advanced, settle_date FROM cash_settlements WHERE user_id = $1 AND settled = false AND advanced < amount ORDER BY settle_date, id FOR UPDATE',
    [userId],
  );
  let remaining = needNet;
  let gross = 0;
  let fee = 0;
  for (const r of rows) {
    if (remaining <= 0) break;
    const avail = Number(r.amount) - Number(r.advanced);
    const days = calendarDays(tradeDate, dateOnly(r.settle_date));
    const k = rate * days;
    // cần ứng g sao cho g − phí(g) ≥ phần còn thiếu
    let g = Math.min(avail, Math.ceil(remaining / Math.max(0.0001, 1 - k)));
    while (g < avail && g - feeFor(g, days, rate) < remaining) g++;
    const f = feeFor(g, days, rate);
    await tx.many('UPDATE cash_settlements SET advanced = advanced + $2 WHERE id = $1', [r.id, g]);
    gross += g;
    fee += f;
    remaining -= g - f;
  }
  if (gross > 0) {
    const a = (await tx.one<{ cash_balance: number }>('SELECT cash_balance FROM accounts WHERE user_id = $1', [userId]))!;
    const afterGross = a.cash_balance + gross;
    await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'ADVANCE',$2,$3,$4)`, [
      userId,
      gross,
      afterGross,
      'Ứng trước tiền bán chứng khoán chờ về',
    ]);
    if (fee > 0) {
      await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'ADVANCE_FEE',$2,$3,$4)`, [
        userId,
        -fee,
        afterGross - fee,
        `Phí ứng trước ${(rate * 100).toFixed(3)}%/ngày`,
      ]);
    }
    await tx.many('UPDATE accounts SET cash_balance = cash_balance + $2, cash_pending = cash_pending - $3, updated_at = now() WHERE user_id = $1', [
      userId,
      gross - fee,
      gross,
    ]);
  }
  return { gross, fee, net: gross - fee };
}

/**
 * Trả nợ ký quỹ từ tiền mặt khả dụng: lãi trước, gốc sau. maxAmount = null → trả tối đa có thể.
 * Phải gọi trong transaction. Trả về số đã trả.
 */
export async function repayDebt(tx: Queryable, userId: string, maxAmount: number | null = null) {
  const a = await tx.one<MoneyRow>('SELECT * FROM accounts WHERE user_id = $1 FOR UPDATE', [userId]);
  if (!a) return { interest: 0, principal: 0 };
  let budget = Math.max(0, a.cash_balance - a.cash_hold);
  if (maxAmount != null) budget = Math.min(budget, maxAmount);
  const interest = Math.min(budget, Number(a.loan_interest));
  const principal = Math.min(budget - interest, Number(a.loan_balance));
  let bal = a.cash_balance;
  if (interest > 0) {
    bal -= interest;
    await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'MARGIN_INTEREST',$2,$3,$4)`, [
      userId,
      -interest,
      bal,
      'Trả lãi vay ký quỹ',
    ]);
  }
  if (principal > 0) {
    bal -= principal;
    await tx.many(`INSERT INTO transactions_ledger (user_id, type, amount, balance_after, note) VALUES ($1,'LOAN_REPAY',$2,$3,$4)`, [
      userId,
      -principal,
      bal,
      'Trả nợ gốc vay ký quỹ',
    ]);
  }
  if (interest || principal) {
    await tx.many(
      'UPDATE accounts SET cash_balance = $2, loan_interest = loan_interest - $3, loan_balance = loan_balance - $4, updated_at = now() WHERE user_id = $1',
      [userId, bal, interest, principal],
    );
  }
  return { interest, principal };
}

export interface MarginMetrics {
  /** Giá trị chứng khoán theo giá thị trường */
  stockValue: number;
  /** Nợ = gốc + lãi */
  debt: number;
  /** Nợ ròng sau khi trừ tiền mặt và tiền chờ về */
  netDebt: number;
  /** Tỷ lệ ký quỹ thực tế = (giá trị CK − nợ ròng) / giá trị CK */
  ratio: number;
  status: 'NORMAL' | 'CALL' | 'FORCE';
  /** Tiền cần nộp thêm để về tỷ lệ ký quỹ ban đầu */
  callAmount: number;
  /** Giá trị cần bán để về tỷ lệ ký quỹ ban đầu (cổ phiếu bán ra, tiền dùng trả nợ) */
  sellAmount: number;
}

/**
 * Tỷ lệ ký quỹ: tiền mặt và tiền bán chờ về được trừ vào nợ; tỷ lệ = phần sở hữu thực / giá trị chứng khoán.
 * Dưới tỷ lệ duy trì → cảnh báo (call); dưới tỷ lệ xử lý → bán giải chấp.
 */
export function marginMetrics(a: Pick<MoneyRow, 'cash_balance' | 'cash_pending' | 'loan_balance' | 'loan_interest'>, stockValue: number, m = RULES.margin): MarginMetrics {
  const debt = Number(a.loan_balance) + Number(a.loan_interest);
  const netDebt = Math.max(0, debt - Number(a.cash_balance) - Number(a.cash_pending));
  const ratio = stockValue > 0 ? (stockValue - netDebt) / stockValue : netDebt > 0 ? 0 : 1;
  const status = debt <= 0 || netDebt <= 0 ? 'NORMAL' : ratio < m.forceRatio ? 'FORCE' : ratio < m.callRatio ? 'CALL' : 'NORMAL';
  const equity = stockValue - netDebt;
  return {
    stockValue,
    debt,
    netDebt,
    ratio,
    status,
    callAmount: Math.max(0, Math.ceil(netDebt - stockValue * (1 - m.initialRatio))),
    sellAmount: Math.max(0, Math.ceil(stockValue - equity / m.initialRatio)),
  };
}

export type BuyPlan = { cashPart: number; advanceNet: number; loanPart: number } | { error: 'INSUFFICIENT_CASH' | 'MARGIN_RATIO'; message: string };

/**
 * Nguồn tiền cho lệnh mua: tiền mặt khả dụng → ứng trước tiền bán chờ về (nếu bật tự ứng) → vay ký quỹ
 * (nếu đã kích hoạt, mã cho vay, còn hạn mức và tỷ lệ ký quỹ sau mua ≥ tỷ lệ ban đầu).
 */
export function planBuy(p: {
  hold: number;
  avail: number;
  advanceableNet: number;
  autoAdvance: boolean;
  marginEnabled: boolean;
  symbolRatio: number;
  creditAvail: number;
  ratioOk?: (loanPart: number, cashPart: number) => boolean;
}): BuyPlan {
  let cashPart = Math.min(Math.max(0, p.avail), p.hold);
  let need = p.hold - cashPart;
  let advanceNet = 0;
  if (need > 0 && p.autoAdvance && p.advanceableNet > 0) {
    advanceNet = Math.min(need, p.advanceableNet);
    cashPart += advanceNet;
    need -= advanceNet;
  }
  let loanPart = 0;
  if (need > 0 && p.marginEnabled && p.symbolRatio > 0) {
    const maxLoan = Math.min(Math.floor(p.hold * p.symbolRatio), Math.max(0, p.creditAvail));
    if (need <= maxLoan) {
      loanPart = need;
      need = 0;
    }
  }
  const fmt = (n: number) => n.toLocaleString('en-US');
  if (need > 0) {
    return {
      error: 'INSUFFICIENT_CASH',
      message: `Sức mua không đủ: cần ${fmt(p.hold)}đ, tiền mặt khả dụng ${fmt(Math.max(0, p.avail))}đ${p.advanceableNet > 0 && p.autoAdvance ? `, có thể ứng ${fmt(p.advanceableNet)}đ` : ''}${
        p.marginEnabled ? (p.symbolRatio > 0 ? `, vay tối đa ${fmt(Math.min(Math.floor(p.hold * p.symbolRatio), Math.max(0, p.creditAvail)))}đ` : ' (mã không cho vay ký quỹ)') : ''
      }`,
    };
  }
  if (loanPart > 0 && p.ratioOk && !p.ratioOk(loanPart, cashPart)) {
    return { error: 'MARGIN_RATIO', message: `Lệnh vượt tỷ lệ ký quỹ ban đầu ${Math.round(RULES.margin.initialRatio * 100)}% — giảm khối lượng hoặc nộp thêm tiền` };
  }
  return { cashPart, advanceNet, loanPart };
}
