-- Tiền bán chờ về (T+2) & ứng trước tiền bán, giao dịch ký quỹ (margin), lãi tiền gửi / lãi vay

ALTER TABLE accounts ADD COLUMN cash_pending BIGINT NOT NULL DEFAULT 0;          -- tiền bán chờ về (chưa ứng)
ALTER TABLE accounts ADD COLUMN auto_advance BOOLEAN NOT NULL DEFAULT true;      -- tự ứng trước khi mua vượt tiền mặt
ALTER TABLE accounts ADD COLUMN margin_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE accounts ADD COLUMN credit_limit BIGINT NOT NULL DEFAULT 0;          -- hạn mức vay ký quỹ
ALTER TABLE accounts ADD COLUMN loan_balance BIGINT NOT NULL DEFAULT 0;          -- dư nợ gốc
ALTER TABLE accounts ADD COLUMN loan_interest BIGINT NOT NULL DEFAULT 0;         -- lãi vay cộng dồn chưa trả
ALTER TABLE accounts ADD COLUMN loan_hold BIGINT NOT NULL DEFAULT 0;             -- phần vay đã giữ cho lệnh mua đang chờ
ALTER TABLE accounts ADD COLUMN margin_status TEXT NOT NULL DEFAULT 'NORMAL' CHECK (margin_status IN ('NORMAL', 'CALL', 'FORCE'));
ALTER TABLE accounts ADD COLUMN margin_call_at TIMESTAMPTZ;
ALTER TABLE accounts ADD COLUMN deposit_interest_accrued BIGINT NOT NULL DEFAULT 0;
ALTER TABLE accounts ADD COLUMN last_interest_date DATE;
ALTER TABLE accounts ADD CONSTRAINT margin_non_negative
  CHECK (cash_pending >= 0 AND credit_limit >= 0 AND loan_balance >= 0 AND loan_interest >= 0 AND loan_hold >= 0 AND deposit_interest_accrued >= 0);

-- Phần tiền phong toả của lệnh mua được tài trợ bằng tiền vay
ALTER TABLE orders ADD COLUMN loan_hold BIGINT NOT NULL DEFAULT 0 CHECK (loan_hold >= 0);

-- Tiền bán chứng khoán chờ về tài khoản (T+2), có thể ứng trước một phần / toàn bộ
CREATE TABLE cash_settlements (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  order_id    BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  symbol      TEXT NOT NULL,
  amount      BIGINT NOT NULL CHECK (amount >= 0),      -- tiền bán ròng (đã trừ phí, thuế)
  advanced    BIGINT NOT NULL DEFAULT 0,                -- phần đã ứng trước
  trade_date  DATE NOT NULL,
  settle_date DATE NOT NULL,
  settled     BOOLEAN NOT NULL DEFAULT false,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT advanced_range CHECK (advanced >= 0 AND advanced <= amount)
);
CREATE INDEX cash_settlements_due_idx ON cash_settlements (settle_date) WHERE settled = false;
CREATE INDEX cash_settlements_user_idx ON cash_settlements (user_id) WHERE settled = false;

ALTER TABLE transactions_ledger DROP CONSTRAINT transactions_ledger_type_check;
ALTER TABLE transactions_ledger ADD CONSTRAINT transactions_ledger_type_check
  CHECK (type IN ('DEPOSIT', 'BUY', 'SELL', 'FEE', 'TAX', 'RESET', 'ADJUST', 'DELIST', 'DIVIDEND', 'RIGHTS', 'CW_SETTLE', 'COUPON', 'BOND_REDEEM',
                  'INTEREST', 'LOAN', 'LOAN_REPAY', 'MARGIN_INTEREST', 'ADVANCE', 'ADVANCE_FEE'));
