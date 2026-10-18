import crypto from 'node:crypto';
import { Big, P2P_RULES, type BankAccountDTO, type BankTransferDTO, type Dec } from '@vss/shared';
import type { Queryable } from '../db';
import { badRequest, notFound } from '../lib/errors';

/*
 * Ngân hàng giả lập: tiền VNĐ ảo nằm NGOÀI sàn. Giao dịch P2P không tự động trừ / cộng tiền ở đây —
 * người mua tự chuyển khoản, người bán tự kiểm tra sao kê (như thanh toán ngân hàng thật).
 * Bất biến: balance_vnd = tổng nhận − tổng chuyển trong bank_transfers (from/to NULL = ngân hàng cấp / thu hồi).
 */

export const BANK_LABEL = 'VNCoin Bank (giả lập)';

interface BankRow {
  user_id: string;
  account_no: string;
  holder_name: string;
  balance_vnd: string;
}

/** Tên chủ tài khoản kiểu ngân hàng: chữ in hoa, bỏ dấu */
export function holderNameOf(fullName: string): string {
  return fullName
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D')
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60) || 'KHACH HANG';
}

const toDTO = (r: BankRow): BankAccountDTO => ({
  accountNo: r.account_no,
  holderName: r.holder_name,
  bankName: BANK_LABEL,
  balanceVnd: new Big(r.balance_vnd).toFixed(),
});

export async function bankAccountOf(q: Queryable, userId: string, forUpdate = false): Promise<BankRow | undefined> {
  return q.one<BankRow>(`SELECT * FROM bank_accounts WHERE user_id = $1 ${forUpdate ? 'FOR UPDATE' : ''}`, [userId]);
}

/**
 * Mở tài khoản ngân hàng (nếu chưa có) và đưa số dư về mức cấp ban đầu.
 * Dùng khi mở tài khoản sàn và khi đặt lại tài khoản; chênh lệch ghi thành 1 lệnh của ngân hàng để giữ bất biến sao kê.
 */
export async function grantBankCapital(tx: Queryable, userId: string, note: string): Promise<void> {
  const target = new Big(P2P_RULES.initialBankVnd);
  let acct = await bankAccountOf(tx, userId, true);
  if (!acct) {
    const u = await tx.one<{ full_name: string }>('SELECT full_name FROM users WHERE id = $1', [userId]);
    for (let i = 0; i < 20 && !acct; i++) {
      const no = String(crypto.randomInt(1_000_000_000, 10_000_000_000)).padStart(10, '0');
      acct = await tx.one<BankRow>(
        `INSERT INTO bank_accounts (user_id, account_no, holder_name) VALUES ($1, $2, $3) ON CONFLICT DO NOTHING RETURNING *`,
        [userId, no, holderNameOf(u?.full_name ?? '')],
      );
    }
    if (!acct) throw new Error('Không tạo được số tài khoản ngân hàng giả lập');
  }
  const diff = target.minus(acct.balance_vnd);
  if (diff.eq(0)) return;
  await tx.many('UPDATE bank_accounts SET balance_vnd = $2, updated_at = now() WHERE user_id = $1', [userId, target.toFixed()]);
  if (diff.gt(0)) {
    await tx.many(`INSERT INTO bank_transfers (to_user, to_account, amount, memo) VALUES ($1, $2, $3, $4)`, [userId, acct.account_no, diff.toFixed(), note]);
  } else {
    await tx.many(`INSERT INTO bank_transfers (from_user, from_account, amount, memo) VALUES ($1, $2, $3, $4)`, [
      userId,
      acct.account_no,
      diff.abs().toFixed(),
      note,
    ]);
  }
}

export class BankService {
  constructor(private db: { tx<T>(fn: (tx: Queryable) => Promise<T>): Promise<T> } & Queryable) {}

  async account(userId: string): Promise<BankAccountDTO> {
    let row = await bankAccountOf(this.db, userId);
    if (!row) {
      await this.db.tx((tx) => grantBankCapital(tx, userId, 'Cấp vốn ngân hàng giả lập'));
      row = await bankAccountOf(this.db, userId);
    }
    return toDTO(row!);
  }

  /** Tra cứu chủ tài khoản trước khi chuyển (như ngân hàng hiện tên người nhận) */
  async lookup(accountNo: string): Promise<{ accountNo: string; holderName: string } | null> {
    const r = await this.db.one<BankRow>('SELECT * FROM bank_accounts WHERE account_no = $1', [accountNo]);
    return r ? { accountNo: r.account_no, holderName: r.holder_name } : null;
  }

  async transfer(userId: string, input: { toAccountNo: string; amount: Dec; memo: string }): Promise<BankTransferDTO> {
    const amount = new Big(input.amount);
    if (amount.lte(0)) throw badRequest('AMOUNT', 'Số tiền phải lớn hơn 0');
    return this.db.tx(async (tx) => {
      const from = await bankAccountOf(tx, userId, true);
      if (!from) throw notFound('Bạn chưa có tài khoản ngân hàng giả lập');
      if (from.account_no === input.toAccountNo) throw badRequest('SELF', 'Không thể tự chuyển khoản cho chính mình');
      const to = await tx.one<BankRow>('SELECT * FROM bank_accounts WHERE account_no = $1 FOR UPDATE', [input.toAccountNo]);
      if (!to) throw badRequest('NO_ACCOUNT', 'Số tài khoản người nhận không tồn tại');
      const moved = await tx.one(
        'UPDATE bank_accounts SET balance_vnd = balance_vnd - $2, updated_at = now() WHERE user_id = $1 AND balance_vnd >= $2 RETURNING user_id',
        [userId, amount.toFixed()],
      );
      if (!moved) throw badRequest('INSUFFICIENT_BANK', `Số dư ngân hàng không đủ (còn ${Number(from.balance_vnd).toLocaleString('vi-VN')} ₫)`);
      await tx.many('UPDATE bank_accounts SET balance_vnd = balance_vnd + $2, updated_at = now() WHERE user_id = $1', [to.user_id, amount.toFixed()]);
      const row = await tx.one<{ id: string | number; created_at: Date }>(
        `INSERT INTO bank_transfers (from_user, to_user, from_account, to_account, amount, memo) VALUES ($1, $2, $3, $4, $5, $6) RETURNING id, created_at`,
        [userId, to.user_id, from.account_no, to.account_no, amount.toFixed(), input.memo],
      );
      return {
        id: Number(row!.id),
        direction: 'OUT' as const,
        counterpartyAccount: to.account_no,
        counterpartyName: to.holder_name,
        amount: amount.toFixed(),
        memo: input.memo,
        createdAt: new Date(row!.created_at).toISOString(),
      };
    });
  }

  /** Sao kê: tiền vào / ra của 1 người (mới nhất trước) */
  async statement(userId: string, limit = 100): Promise<BankTransferDTO[]> {
    return statementOf(this.db, userId, limit);
  }
}

interface TransferRow {
  id: string | number;
  from_user: string | null;
  to_user: string | null;
  from_account: string | null;
  to_account: string | null;
  amount: string;
  memo: string;
  created_at: Date;
  from_name: string | null;
  to_name: string | null;
}

export function toTransferDTO(r: TransferRow, viewer: string): BankTransferDTO {
  const out = r.from_user === viewer;
  return {
    id: Number(r.id),
    direction: out ? 'OUT' : 'IN',
    counterpartyAccount: (out ? r.to_account : r.from_account) ?? '',
    counterpartyName: (out ? r.to_name : r.from_name) ?? BANK_LABEL,
    amount: new Big(r.amount).toFixed(),
    memo: r.memo,
    createdAt: new Date(r.created_at).toISOString(),
  };
}

const TRANSFER_SELECT = `SELECT t.*, fa.holder_name AS from_name, ta.holder_name AS to_name
  FROM bank_transfers t
  LEFT JOIN bank_accounts fa ON fa.user_id = t.from_user
  LEFT JOIN bank_accounts ta ON ta.user_id = t.to_user`;

export async function statementOf(q: Queryable, userId: string, limit = 100): Promise<BankTransferDTO[]> {
  const rows = await q.many<TransferRow>(`${TRANSFER_SELECT} WHERE t.from_user = $1 OR t.to_user = $1 ORDER BY t.id DESC LIMIT $2`, [userId, limit]);
  return rows.map((r) => toTransferDTO(r, userId));
}

/** Bằng chứng cho khiếu nại: các lệnh chuyển khoản giữa 2 người trong khoảng thời gian (theo góc nhìn `viewer`) */
export async function transfersBetween(q: Queryable, a: string, b: string, since: Date, viewer: string): Promise<BankTransferDTO[]> {
  const rows = await q.many<TransferRow>(
    `${TRANSFER_SELECT} WHERE ((t.from_user = $1 AND t.to_user = $2) OR (t.from_user = $2 AND t.to_user = $1)) AND t.created_at >= $3
     ORDER BY t.id`,
    [a, b, since],
  );
  return rows.map((r) => toTransferDTO(r, viewer));
}
