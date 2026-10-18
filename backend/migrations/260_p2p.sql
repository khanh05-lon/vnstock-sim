-- Chợ P2P và thương nhân (Binance P2P / OKX P2P) + ngân hàng giả lập để thanh toán VNĐ bên ngoài sàn.

-- ===================== Ngân hàng giả lập =====================
-- Mỗi người dùng 1 tài khoản ngân hàng VNĐ ảo. Sàn KHÔNG tự trừ / cộng tiền ở đây khi giao dịch P2P:
-- người mua tự chuyển khoản, người bán tự kiểm tra rồi mới nhả coin (như thật).
CREATE TABLE bank_accounts (
  user_id     UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  account_no  TEXT NOT NULL UNIQUE CHECK (account_no ~ '^\d{10}$'),
  holder_name TEXT NOT NULL,
  balance_vnd NUMERIC(20, 0) NOT NULL DEFAULT 0 CHECK (balance_vnd >= 0),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Mọi biến động số dư ngân hàng. from_user / to_user NULL = ngân hàng (cấp vốn, đặt lại).
-- Bất biến (đối soát): balance_vnd = tổng nhận − tổng chuyển.
CREATE TABLE bank_transfers (
  id           BIGSERIAL PRIMARY KEY,
  from_user    UUID REFERENCES users (id) ON DELETE CASCADE,
  to_user      UUID REFERENCES users (id) ON DELETE CASCADE,
  from_account TEXT,
  to_account   TEXT,
  amount       NUMERIC(20, 0) NOT NULL CHECK (amount > 0),
  memo         TEXT NOT NULL DEFAULT '',
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  CHECK (from_user IS NOT NULL OR to_user IS NOT NULL)
);
CREATE INDEX bank_transfers_from_idx ON bank_transfers (from_user, created_at DESC);
CREATE INDEX bank_transfers_to_idx ON bank_transfers (to_user, created_at DESC);

-- Tài khoản ngân hàng cho người dùng hiện có, cấp 100.000.000đ
INSERT INTO bank_accounts (user_id, account_no, holder_name, balance_vnd)
SELECT u.id, (1000000000 + row_number() OVER (ORDER BY u.created_at, u.id))::text, upper(u.full_name), 100000000
FROM users u;
INSERT INTO bank_transfers (to_user, to_account, amount, memo)
SELECT user_id, account_no, balance_vnd, 'Cấp vốn ngân hàng giả lập' FROM bank_accounts;

-- ===================== Thương nhân =====================
CREATE TABLE p2p_merchants (
  user_id          UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  status           TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'ACTIVE', 'SUSPENDED', 'REJECTED', 'RESIGNED')),
  -- Tiền cọc USDT đang khoá trong ví (balances.locked)
  deposit_usdt     NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (deposit_usdt >= 0),
  applied_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  reviewed_at      TIMESTAMPTZ,
  reviewed_by      TEXT,
  note             TEXT,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX p2p_merchants_status_idx ON p2p_merchants (status, applied_at);

-- Tài khoản nhận tiền (nhãn ngân hàng + tài khoản ngân hàng giả lập của chính người dùng)
CREATE TABLE p2p_payment_methods (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  bank_name   TEXT NOT NULL,
  account_no  TEXT NOT NULL,
  holder_name TEXT NOT NULL,
  deleted_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX p2p_payment_methods_user_idx ON p2p_payment_methods (user_id);

-- ===================== Quảng cáo =====================
-- side theo góc nhìn thương nhân: SELL = thương nhân bán coin (coin khoá ngay khi đăng), BUY = thương nhân mua coin.
CREATE TABLE p2p_ads (
  id                 BIGSERIAL PRIMARY KEY,
  merchant_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  side               TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  asset              TEXT NOT NULL,
  price_type         TEXT NOT NULL CHECK (price_type IN ('FIXED', 'FLOATING')),
  fixed_price        NUMERIC(20, 0) CHECK (fixed_price > 0),
  float_ratio        NUMERIC(6, 2) CHECK (float_ratio > 0),
  total_qty          NUMERIC(36, 18) NOT NULL CHECK (total_qty > 0),
  -- Còn lại để khách đặt đơn
  available_qty      NUMERIC(36, 18) NOT NULL CHECK (available_qty >= 0),
  -- Quảng cáo bán: số coin (kèm phí) đang khoá trong ví thương nhân cho phần còn lại + đơn đang chạy
  locked_amount      NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (locked_amount >= 0),
  min_fiat           NUMERIC(20, 0) NOT NULL CHECK (min_fiat > 0),
  max_fiat           NUMERIC(20, 0) NOT NULL CHECK (max_fiat >= min_fiat),
  pay_minutes        INTEGER NOT NULL CHECK (pay_minutes IN (15, 30, 45, 60)),
  payment_method_ids BIGINT[] NOT NULL DEFAULT '{}',
  terms              TEXT NOT NULL DEFAULT '',
  min_account_days   INTEGER NOT NULL DEFAULT 0,
  -- Phí thương nhân chốt lúc đăng
  maker_fee          NUMERIC(10, 6) NOT NULL DEFAULT 0,
  status             TEXT NOT NULL DEFAULT 'ONLINE' CHECK (status IN ('ONLINE', 'OFFLINE', 'CLOSED')),
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
  closed_at          TIMESTAMPTZ
);
CREATE INDEX p2p_ads_market_idx ON p2p_ads (status, side, asset);
CREATE INDEX p2p_ads_merchant_idx ON p2p_ads (merchant_id, status);

-- ===================== Đơn P2P =====================
CREATE TABLE p2p_orders (
  id                BIGSERIAL PRIMARY KEY,
  ad_id             BIGINT NOT NULL REFERENCES p2p_ads (id),
  maker_id          UUID NOT NULL REFERENCES users (id),
  taker_id          UUID NOT NULL REFERENCES users (id),
  buyer_id          UUID NOT NULL REFERENCES users (id),
  seller_id         UUID NOT NULL REFERENCES users (id),
  asset             TEXT NOT NULL,
  price             NUMERIC(20, 0) NOT NULL CHECK (price > 0),
  qty               NUMERIC(36, 18) NOT NULL CHECK (qty > 0),
  fiat_amount       NUMERIC(20, 0) NOT NULL CHECK (fiat_amount > 0),
  -- Phí thương nhân (coin): quảng cáo bán thì thương nhân trả thêm, quảng cáo mua thì trừ vào coin thương nhân nhận
  fee               NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (fee >= 0),
  -- Coin đang giữ trong ký quỹ của bên bán cho đơn này (qty, + phí nếu bên bán là thương nhân)
  escrow_amount     NUMERIC(36, 18) NOT NULL DEFAULT 0 CHECK (escrow_amount >= 0),
  status            TEXT NOT NULL DEFAULT 'PENDING_PAYMENT'
                    CHECK (status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL', 'COMPLETED', 'CANCELLED')),
  pay_minutes       INTEGER NOT NULL,
  pay_deadline      TIMESTAMPTZ NOT NULL,
  paid_at           TIMESTAMPTZ,
  released_at       TIMESTAMPTZ,
  cancelled_at      TIMESTAMPTZ,
  cancelled_by      TEXT CHECK (cancelled_by IN ('BUYER', 'SYSTEM', 'STAFF')),
  cancel_reason     TEXT,
  -- Tài khoản nhận tiền của bên bán (chụp lại lúc đặt đơn)
  pay_bank_name     TEXT NOT NULL,
  pay_account_no    TEXT NOT NULL,
  pay_holder_name   TEXT NOT NULL,
  terms             TEXT NOT NULL DEFAULT '',
  appeal_by         TEXT CHECK (appeal_by IN ('BUYER', 'SELLER')),
  appeal_reason     TEXT,
  appeal_desc       TEXT,
  appeal_at         TIMESTAMPTZ,
  resolution        TEXT CHECK (resolution IN ('RELEASED', 'RETURNED')),
  resolved_by       TEXT,
  resolved_at       TIMESTAMPTZ,
  resolution_note   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX p2p_orders_buyer_idx ON p2p_orders (buyer_id, created_at DESC);
CREATE INDEX p2p_orders_seller_idx ON p2p_orders (seller_id, created_at DESC);
CREATE INDEX p2p_orders_ad_idx ON p2p_orders (ad_id);
CREATE INDEX p2p_orders_open_idx ON p2p_orders (status, pay_deadline) WHERE status IN ('PENDING_PAYMENT', 'PAID', 'APPEAL');

-- Chat trong đơn. sender_id NULL = tin hệ thống; staff_email = tin của nhân viên xử lý khiếu nại
CREATE TABLE p2p_messages (
  id          BIGSERIAL PRIMARY KEY,
  order_id    BIGINT NOT NULL REFERENCES p2p_orders (id) ON DELETE CASCADE,
  sender_id   UUID REFERENCES users (id),
  staff_email TEXT,
  body        TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX p2p_messages_order_idx ON p2p_messages (order_id, id);

-- Sổ cái: biến động số dư do P2P (ký quỹ chuyển cho người mua, trừ cọc...)
ALTER TABLE ledger DROP CONSTRAINT IF EXISTS ledger_type_check;
ALTER TABLE ledger ADD CONSTRAINT ledger_type_check CHECK (type IN ('RESET', 'TRADE', 'FEE', 'ADJUST', 'P2P'));
ALTER TABLE ledger ADD COLUMN p2p_order_id BIGINT REFERENCES p2p_orders (id);
