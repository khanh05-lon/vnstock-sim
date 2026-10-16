-- VNCoin: chuyển từ sàn chứng khoán Việt Nam sang sàn coin Spot.
-- Bỏ toàn bộ dữ liệu nghiệp vụ chứng khoán (mã, giá, lệnh, danh mục, sự kiện quyền, ký quỹ...).
-- Giữ người dùng, xác thực / 2FA, nhật ký quản trị, cảnh báo vận hành, tên danh sách theo dõi.
-- Số tiền / khối lượng / giá dùng NUMERIC(36,18): PGlite và pg đều trả về chuỗi, không mất độ chính xác.

DROP TABLE IF EXISTS
  ca_entitlements, corporate_actions, warrants, bonds, cash_settlements, conditional_orders,
  settlement_lots, holdings, trades, transactions_ledger, orders, price_alerts, watchlists,
  price_snapshots, ohlcv_intraday, ohlcv_daily, index_intraday, index_daily, market_holidays,
  nav_daily, accounts, stocks
  CASCADE;

-- Tham số quản trị cũ (biểu phí VN, mã tạm ngừng, thông báo...) không còn ý nghĩa
DELETE FROM market_meta;

-- Cặp giao dịch. filters: bộ lọc theo Binance exchangeInfo (xem SymbolFilters ở @vss/shared)
CREATE TABLE symbols (
  symbol      TEXT PRIMARY KEY,
  base_asset  TEXT NOT NULL,
  quote_asset TEXT NOT NULL,
  name        TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'TRADING' CHECK (status IN ('TRADING', 'HALT', 'BREAK')),
  -- false = quản trị viên đã gỡ cặp khỏi sàn (giữ lại để tra cứu lệnh cũ)
  enabled     BOOLEAN NOT NULL DEFAULT true,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  filters     JSONB NOT NULL,
  -- giá cuối cùng biết được: điểm xuất phát của bộ giả lập khi mất nguồn dữ liệu
  last_price  NUMERIC(36,18),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE accounts (
  user_id          UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  initial_usdt     NUMERIC(36,18) NOT NULL,
  -- vốn đã góp = vốn ban đầu + điều chỉnh của quản trị viên (mốc tính lãi / lỗ, bảng xếp hạng)
  contributed_usdt NUMERIC(36,18) NOT NULL,
  pay_fee_with_bnb BOOLEAN NOT NULL DEFAULT false,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Số dư theo tài sản: free khả dụng, locked đang khoá cho lệnh mở.
-- cost_usdt: tổng giá vốn (USDT) của lượng đang nắm giữ → giá vốn bình quân = cost_usdt / (free + locked)
CREATE TABLE balances (
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset      TEXT NOT NULL,
  free       NUMERIC(36,18) NOT NULL DEFAULT 0,
  locked     NUMERIC(36,18) NOT NULL DEFAULT 0,
  cost_usdt  NUMERIC(36,18) NOT NULL DEFAULT 0,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, asset),
  CONSTRAINT balance_non_negative CHECK (free >= 0 AND locked >= 0 AND cost_usdt >= 0)
);

-- Danh sách lệnh OCO (2 lệnh: LIMIT_MAKER + STOP_LOSS_LIMIT)
CREATE TABLE order_lists (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL REFERENCES symbols(symbol),
  side       TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  status     TEXT NOT NULL DEFAULT 'EXECUTING' CHECK (status IN ('EXECUTING', 'ALL_DONE')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_lists_user_idx ON order_lists (user_id, created_at DESC);

CREATE TABLE orders (
  id              BIGSERIAL PRIMARY KEY,
  client_order_id TEXT NOT NULL,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL REFERENCES symbols(symbol),
  side            TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  type            TEXT NOT NULL CHECK (type IN ('LIMIT', 'MARKET', 'LIMIT_MAKER', 'STOP_LOSS_LIMIT', 'TAKE_PROFIT_LIMIT')),
  time_in_force   TEXT CHECK (time_in_force IN ('GTC', 'IOC', 'FOK')),
  price           NUMERIC(36,18),
  stop_price      NUMERIC(36,18),
  orig_qty        NUMERIC(36,18) NOT NULL DEFAULT 0,
  executed_qty    NUMERIC(36,18) NOT NULL DEFAULT 0,
  cumm_quote_qty  NUMERIC(36,18) NOT NULL DEFAULT 0,
  quote_order_qty NUMERIC(36,18),
  status          TEXT NOT NULL CHECK (status IN ('NEW', 'PARTIALLY_FILLED', 'FILLED', 'CANCELED', 'EXPIRED', 'REJECTED')),
  -- lệnh dừng: false tới khi kích hoạt; lệnh thường: true khi đang nằm trên sổ
  is_working      BOOLEAN NOT NULL DEFAULT true,
  order_list_id   BIGINT REFERENCES order_lists(id) ON DELETE SET NULL,
  -- biểu phí chốt tại thời điểm đặt lệnh
  maker_fee       NUMERIC(12,8) NOT NULL,
  taker_fee       NUMERIC(12,8) NOT NULL,
  -- phần số dư còn đang khoá cho lệnh (USDT với lệnh mua, coin với lệnh bán)
  locked_asset    TEXT NOT NULL,
  locked_amount   NUMERIC(36,18) NOT NULL DEFAULT 0 CHECK (locked_amount >= 0),
  reason          TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT executed_le_orig CHECK (executed_qty <= orig_qty OR quote_order_qty IS NOT NULL),
  UNIQUE (user_id, client_order_id)
);
CREATE INDEX orders_user_idx ON orders (user_id, created_at DESC);
CREATE INDEX orders_open_idx ON orders (symbol) WHERE status IN ('NEW', 'PARTIALLY_FILLED');

-- Các lần khớp lệnh
CREATE TABLE fills (
  id               BIGSERIAL PRIMARY KEY,
  order_id         BIGINT NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol           TEXT NOT NULL REFERENCES symbols(symbol),
  side             TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  price            NUMERIC(36,18) NOT NULL,
  qty              NUMERIC(36,18) NOT NULL CHECK (qty > 0),
  quote_qty        NUMERIC(36,18) NOT NULL,
  commission       NUMERIC(36,18) NOT NULL,
  commission_asset TEXT NOT NULL,
  -- phí quy đổi USDT tại thời điểm khớp (báo cáo)
  commission_usdt  NUMERIC(36,18) NOT NULL DEFAULT 0,
  is_maker         BOOLEAN NOT NULL,
  realized_pnl     NUMERIC(36,18),
  executed_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX fills_user_idx ON fills (user_id, executed_at DESC);
CREATE INDEX fills_order_idx ON fills (order_id);

-- Sổ cái biến động số dư theo tài sản
CREATE TABLE ledger (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset         TEXT NOT NULL,
  type          TEXT NOT NULL CHECK (type IN ('RESET', 'TRADE', 'FEE', 'ADJUST')),
  amount        NUMERIC(36,18) NOT NULL,
  balance_after NUMERIC(36,18) NOT NULL,
  order_id      BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  note          TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX ledger_user_idx ON ledger (user_id, created_at DESC);

-- Tổng tài sản (USDT) cuối mỗi ngày UTC
CREATE TABLE nav_daily (
  user_id          UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day              DATE NOT NULL,
  nav_usdt         NUMERIC(36,18) NOT NULL,
  contributed_usdt NUMERIC(36,18) NOT NULL,
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, day)
);
CREATE INDEX nav_daily_day_idx ON nav_daily (day);

-- Danh sách theo dõi: giữ tên danh sách, nội dung (mã chứng khoán) bỏ đi
CREATE TABLE watchlists (
  list_id    BIGINT NOT NULL REFERENCES watchlist_lists(id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol     TEXT NOT NULL REFERENCES symbols(symbol) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (list_id, symbol)
);
CREATE INDEX watchlists_user ON watchlists (user_id);

-- Cảnh báo giá: PRICE_* value = giá; CHANGE_* value = % thay đổi 24h
CREATE TABLE price_alerts (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL REFERENCES symbols(symbol) ON DELETE CASCADE,
  kind            TEXT NOT NULL CHECK (kind IN ('PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_UP', 'CHANGE_DOWN')),
  value           NUMERIC(36,18) NOT NULL CHECK (value > 0),
  note            TEXT,
  notify_email    BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'TRIGGERED', 'CANCELLED')),
  triggered_price NUMERIC(36,18),
  triggered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_alerts_active ON price_alerts (symbol) WHERE status = 'ACTIVE';
CREATE INDEX price_alerts_user ON price_alerts (user_id, created_at DESC);

-- Cấp vốn ảo 10.000 USDT cho người dùng hiện có
INSERT INTO accounts (user_id, initial_usdt, contributed_usdt) SELECT id, 10000, 10000 FROM users;
INSERT INTO balances (user_id, asset, free) SELECT id, 'USDT', 10000 FROM users;
INSERT INTO ledger (user_id, asset, type, amount, balance_after, note)
  SELECT id, 'USDT', 'RESET', 10000, 10000, 'Cấp vốn ảo khi chuyển sang sàn coin' FROM users;
