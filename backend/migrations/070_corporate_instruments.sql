-- Sự kiện quyền (cổ tức tiền, cổ tức cổ phiếu / thưởng, chia tách, quyền mua phát hành thêm)
-- và các loại chứng khoán khác cổ phiếu: chứng quyền có bảo đảm (CW), trái phiếu niêm yết

CREATE TABLE warrants (
  symbol            TEXT PRIMARY KEY REFERENCES stocks(symbol),
  underlying        TEXT NOT NULL REFERENCES stocks(symbol),
  issuer            TEXT NOT NULL,
  ratio             REAL NOT NULL CHECK (ratio > 0),          -- số CW cho 1 cổ phiếu cơ sở
  exercise_price    BIGINT NOT NULL CHECK (exercise_price > 0),
  maturity_date     DATE NOT NULL,
  last_trading_date DATE NOT NULL,
  settled           BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE bonds (
  symbol           TEXT PRIMARY KEY REFERENCES stocks(symbol),
  issuer           TEXT NOT NULL,
  par_value        BIGINT NOT NULL DEFAULT 100000,
  coupon_rate      REAL NOT NULL CHECK (coupon_rate >= 0 AND coupon_rate < 1),
  coupon_freq      INTEGER NOT NULL CHECK (coupon_freq IN (1, 2, 4)),
  issue_date       DATE NOT NULL,
  maturity_date    DATE NOT NULL,
  last_coupon_date DATE,
  redeemed         BOOLEAN NOT NULL DEFAULT false
);

CREATE TABLE corporate_actions (
  id              BIGSERIAL PRIMARY KEY,
  symbol          TEXT NOT NULL REFERENCES stocks(symbol),
  type            TEXT NOT NULL CHECK (type IN ('CASH_DIVIDEND', 'STOCK_DIVIDEND', 'SPLIT', 'RIGHTS')),
  ex_date         DATE NOT NULL,                 -- ngày giao dịch không hưởng quyền
  record_date     DATE NOT NULL,                 -- ngày đăng ký cuối cùng
  pay_date        DATE NOT NULL,                 -- ngày thanh toán / cổ phiếu về tài khoản
  cash_per_share  BIGINT,                        -- cổ tức tiền (đ / cổ phiếu)
  ratio_from      INTEGER,                       -- tỷ lệ a : b (sở hữu a CP → nhận b CP / b quyền)
  ratio_to        INTEGER,
  issue_price     BIGINT,                        -- giá mua cổ phiếu phát hành thêm (quyền mua)
  subscribe_until DATE,                          -- hạn đăng ký mua
  status          TEXT NOT NULL DEFAULT 'ANNOUNCED' CHECK (status IN ('ANNOUNCED', 'EX_DONE', 'COMPLETED', 'CANCELLED')),
  ref_before      BIGINT,
  ref_after       BIGINT,
  note            TEXT,
  created_by      TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  processed_at    TIMESTAMPTZ,
  CONSTRAINT ca_dates CHECK (record_date >= ex_date AND pay_date >= ex_date),
  CONSTRAINT ca_cash CHECK (type <> 'CASH_DIVIDEND' OR cash_per_share > 0),
  CONSTRAINT ca_ratio CHECK (type = 'CASH_DIVIDEND' OR (ratio_from > 0 AND ratio_to > 0)),
  CONSTRAINT ca_rights CHECK (type <> 'RIGHTS' OR (issue_price > 0 AND subscribe_until IS NOT NULL))
);
CREATE INDEX corporate_actions_symbol_idx ON corporate_actions (symbol, ex_date DESC);

-- Quyền của từng nhà đầu tư, chốt theo số cổ phiếu nắm giữ trước ngày GDKHQ
CREATE TABLE ca_entitlements (
  id          BIGSERIAL PRIMARY KEY,
  action_id   BIGINT NOT NULL REFERENCES corporate_actions(id) ON DELETE CASCADE,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  qty_held    INTEGER NOT NULL,
  cash_amount BIGINT NOT NULL DEFAULT 0,   -- cổ tức tiền trước thuế
  tax_amount  BIGINT NOT NULL DEFAULT 0,
  shares      INTEGER NOT NULL DEFAULT 0,  -- cổ phiếu được nhận / số cổ phiếu tối đa được mua (quyền mua)
  subscribed  INTEGER NOT NULL DEFAULT 0,  -- số cổ phiếu đã đăng ký mua
  status      TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'PAID', 'CANCELLED')),
  paid_at     TIMESTAMPTZ,
  UNIQUE (action_id, user_id),
  CONSTRAINT ca_subscribed CHECK (subscribed >= 0 AND subscribed <= shares)
);
CREATE INDEX ca_entitlements_user_idx ON ca_entitlements (user_id, status);

ALTER TABLE transactions_ledger DROP CONSTRAINT transactions_ledger_type_check;
ALTER TABLE transactions_ledger ADD CONSTRAINT transactions_ledger_type_check
  CHECK (type IN ('DEPOSIT', 'BUY', 'SELL', 'FEE', 'TAX', 'RESET', 'ADJUST', 'DELIST', 'DIVIDEND', 'RIGHTS', 'CW_SETTLE', 'COUPON', 'BOND_REDEEM'));
