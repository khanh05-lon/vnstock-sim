-- Lệnh nâng cao: lô lẻ (không cần cột riêng — qty < 100), lệnh có hiệu lực nhiều ngày (GTD), nguồn lệnh,
-- lệnh điều kiện (cắt lỗ / chốt lời / trailing stop / mua khi vượt / mua khi giảm về, cặp OCO)

ALTER TABLE orders ADD COLUMN valid_until DATE;
ALTER TABLE orders ADD COLUMN source TEXT NOT NULL DEFAULT 'USER' CHECK (source IN ('USER', 'CONDITIONAL', 'FORCE_SELL'));

CREATE TABLE conditional_orders (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL REFERENCES stocks(symbol),
  side            TEXT NOT NULL CHECK (side IN ('BUY', 'SELL')),
  -- STOP: bán khi giá ≤ kích hoạt / mua khi giá ≥ kích hoạt
  -- LIMIT_IF_TOUCHED: bán khi giá ≥ kích hoạt (chốt lời) / mua khi giá ≤ kích hoạt
  -- TRAILING: bán khi giá giảm trail_pct% từ đỉnh / mua khi giá tăng trail_pct% từ đáy
  kind            TEXT NOT NULL CHECK (kind IN ('STOP', 'LIMIT_IF_TOUCHED', 'TRAILING')),
  trigger_price   BIGINT,
  trail_pct       REAL,
  peak_price      BIGINT,
  order_type      TEXT NOT NULL CHECK (order_type IN ('LO', 'MARKET')),
  limit_price     BIGINT,
  qty             INTEGER NOT NULL CHECK (qty > 0),
  valid_until     DATE NOT NULL,
  oco_group       UUID,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'TRIGGERED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  order_id        BIGINT REFERENCES orders(id) ON DELETE SET NULL,
  triggered_price BIGINT,
  message         TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  triggered_at    TIMESTAMPTZ,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT cond_trigger_needed CHECK (kind = 'TRAILING' OR trigger_price > 0),
  CONSTRAINT cond_trail_needed CHECK (kind <> 'TRAILING' OR (trail_pct > 0 AND trail_pct <= 50)),
  CONSTRAINT cond_limit_needed CHECK (order_type = 'MARKET' OR limit_price > 0)
);
CREATE INDEX conditional_active_idx ON conditional_orders (symbol) WHERE status = 'ACTIVE';
CREATE INDEX conditional_user_idx ON conditional_orders (user_id, created_at DESC);
ALTER TABLE orders ADD COLUMN conditional_id BIGINT;
