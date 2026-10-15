-- VNStock Sim — schema khởi tạo (PostgreSQL; chạy được trên PGlite và Supabase)

CREATE TABLE users (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email         TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  full_name     TEXT NOT NULL,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  user_id         UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  cash_balance    BIGINT NOT NULL,
  cash_hold       BIGINT NOT NULL DEFAULT 0,
  initial_capital BIGINT NOT NULL,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cash_non_negative CHECK (cash_balance >= 0 AND cash_hold >= 0 AND cash_hold <= cash_balance)
);

CREATE TABLE stocks (
  symbol        TEXT PRIMARY KEY,
  exchange      TEXT NOT NULL CHECK (exchange IN ('HOSE', 'HNX', 'UPCOM')),
  name          TEXT NOT NULL,
  industry      TEXT NOT NULL,
  listed_shares BIGINT NOT NULL,
  eps           INTEGER NOT NULL,
  bvps          INTEGER NOT NULL,
  is_vn30       BOOLEAN NOT NULL DEFAULT false,
  liquidity     REAL NOT NULL DEFAULT 0.5,
  volatility    REAL NOT NULL DEFAULT 0.02
);

-- Nến ngày
CREATE TABLE ohlcv_daily (
  symbol     TEXT NOT NULL REFERENCES stocks(symbol),
  trade_date DATE NOT NULL,
  open       BIGINT NOT NULL,
  high       BIGINT NOT NULL,
  low        BIGINT NOT NULL,
  close      BIGINT NOT NULL,
  volume     BIGINT NOT NULL,
  value      BIGINT NOT NULL,
  PRIMARY KEY (symbol, trade_date)
);

-- Nến 1 phút (giữ vài ngày gần nhất)
CREATE TABLE ohlcv_intraday (
  symbol TEXT NOT NULL REFERENCES stocks(symbol),
  ts     BIGINT NOT NULL, -- epoch giây
  open   BIGINT NOT NULL,
  high   BIGINT NOT NULL,
  low    BIGINT NOT NULL,
  close  BIGINT NOT NULL,
  volume BIGINT NOT NULL,
  PRIMARY KEY (symbol, ts)
);

CREATE TABLE index_daily (
  code       TEXT NOT NULL,
  trade_date DATE NOT NULL,
  open       DOUBLE PRECISION NOT NULL,
  high       DOUBLE PRECISION NOT NULL,
  low        DOUBLE PRECISION NOT NULL,
  close      DOUBLE PRECISION NOT NULL,
  volume     BIGINT NOT NULL,
  value      BIGINT NOT NULL,
  PRIMARY KEY (code, trade_date)
);

CREATE TABLE index_intraday (
  code  TEXT NOT NULL,
  ts    BIGINT NOT NULL,
  value DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (code, ts)
);

-- Ảnh chụp trạng thái giá để khôi phục khi khởi động lại
CREATE TABLE price_snapshots (
  symbol       TEXT PRIMARY KEY REFERENCES stocks(symbol),
  trade_date   DATE NOT NULL,
  ref          BIGINT NOT NULL,
  open         BIGINT NOT NULL,
  high         BIGINT NOT NULL,
  low          BIGINT NOT NULL,
  last         BIGINT NOT NULL,
  volume       BIGINT NOT NULL,
  value        BIGINT NOT NULL,
  foreign_buy  BIGINT NOT NULL DEFAULT 0,
  foreign_sell BIGINT NOT NULL DEFAULT 0,
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE market_meta (
  key   TEXT PRIMARY KEY,
  value JSONB NOT NULL
);

CREATE TABLE watchlists (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL REFERENCES stocks(symbol),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, symbol)
);

CREATE TABLE orders (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol         TEXT NOT NULL REFERENCES stocks(symbol),
  side           TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  order_type     TEXT NOT NULL CHECK (order_type IN ('LO', 'MP', 'ATO', 'ATC')),
  price          BIGINT,           -- giá đặt (LO) / giá chuyển đổi (MP)
  hold_price     BIGINT NOT NULL,  -- giá dùng để phong toả tiền
  qty            INTEGER NOT NULL CHECK (qty > 0),
  filled_qty     INTEGER NOT NULL DEFAULT 0 CHECK (filled_qty >= 0),
  avg_fill_price BIGINT NOT NULL DEFAULT 0,
  status         TEXT NOT NULL CHECK (status IN ('PENDING', 'PARTIAL', 'FILLED', 'CANCELLED', 'EXPIRED', 'REJECTED')),
  hold_amount    BIGINT NOT NULL DEFAULT 0,
  reject_reason  TEXT,
  trade_date     DATE NOT NULL,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT filled_le_qty CHECK (filled_qty <= qty)
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_open_idx ON orders (status) WHERE status IN ('PENDING', 'PARTIAL');

CREATE TABLE trades (
  id           BIGSERIAL PRIMARY KEY,
  order_id     BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol       TEXT NOT NULL REFERENCES stocks(symbol),
  side         TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price        BIGINT NOT NULL,
  qty          INTEGER NOT NULL CHECK (qty > 0),
  value        BIGINT NOT NULL,
  fee          BIGINT NOT NULL,
  tax          BIGINT NOT NULL DEFAULT 0,
  realized_pnl BIGINT,
  executed_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX trades_user_idx ON trades (user_id, executed_at DESC);

-- qty_total = qty_available + qty_hold + qty_pending
CREATE TABLE holdings (
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol        TEXT NOT NULL REFERENCES stocks(symbol),
  qty_total     INTEGER NOT NULL DEFAULT 0,
  qty_available INTEGER NOT NULL DEFAULT 0,
  qty_hold      INTEGER NOT NULL DEFAULT 0,
  qty_pending   INTEGER NOT NULL DEFAULT 0,
  total_cost    BIGINT NOT NULL DEFAULT 0,
  PRIMARY KEY (user_id, symbol),
  CONSTRAINT qty_non_negative CHECK (qty_available >= 0 AND qty_hold >= 0 AND qty_pending >= 0),
  CONSTRAINT qty_consistent CHECK (qty_total = qty_available + qty_hold + qty_pending)
);

-- Lô cổ phiếu chờ về tài khoản (T+2)
CREATE TABLE settlement_lots (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol      TEXT NOT NULL REFERENCES stocks(symbol),
  qty         INTEGER NOT NULL CHECK (qty > 0),
  settle_date DATE NOT NULL,
  settled     BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX settlement_pending_idx ON settlement_lots (settle_date) WHERE settled = false;

CREATE TABLE transactions_ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  type          TEXT NOT NULL CHECK (type IN ('DEPOSIT', 'BUY', 'SELL', 'FEE', 'TAX', 'RESET')),
  amount        BIGINT NOT NULL,
  balance_after BIGINT NOT NULL,
  order_id      BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_idx ON transactions_ledger (user_id, created_at DESC);
