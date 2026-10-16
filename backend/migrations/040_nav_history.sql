-- Hiệu quả đầu tư: tài sản ròng (NAV) theo ngày và vốn đã góp để tính tỷ suất lợi nhuận / bảng xếp hạng

-- Vốn đã góp = vốn ảo ban đầu + các lần quản trị viên điều chỉnh (không tính lãi/lỗ, cổ tức...)
ALTER TABLE accounts ADD COLUMN contributed BIGINT NOT NULL DEFAULT 0;
UPDATE accounts a SET contributed = a.initial_capital + COALESCE(
  (SELECT sum(l.amount) FROM transactions_ledger l WHERE l.user_id = a.user_id AND l.type = 'ADJUST'), 0);

CREATE TABLE nav_daily (
  user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  trade_date  DATE NOT NULL,
  nav         BIGINT NOT NULL,
  cash        BIGINT NOT NULL,
  stock_value BIGINT NOT NULL,
  debt        BIGINT NOT NULL DEFAULT 0,
  contributed BIGINT NOT NULL,
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, trade_date)
);
CREATE INDEX nav_daily_date_idx ON nav_daily (trade_date);
