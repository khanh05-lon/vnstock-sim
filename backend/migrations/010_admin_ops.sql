-- Quản trị & vận hành: vai trò, khoá tài khoản, nhật ký quản trị, ngày nghỉ lễ, điều chỉnh vốn ảo

ALTER TABLE users ADD COLUMN role TEXT NOT NULL DEFAULT 'USER' CHECK (role IN ('USER', 'ADMIN'));
ALTER TABLE users ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'LOCKED'));
ALTER TABLE users ADD COLUMN locked_reason TEXT;
ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;

-- Mọi thao tác của quản trị viên đều được ghi lại, không sửa / xoá được qua ứng dụng
CREATE TABLE admin_audit_log (
  id          BIGSERIAL PRIMARY KEY,
  admin_id    UUID REFERENCES users(id) ON DELETE SET NULL,
  admin_email TEXT NOT NULL,
  action      TEXT NOT NULL,
  target_type TEXT,
  target_id   TEXT,
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit_log (created_at DESC);

-- Ngày nghỉ lễ (áp dụng ở chế độ giờ thật: không giao dịch, không tính vào T+2)
CREATE TABLE market_holidays (
  holiday_date DATE PRIMARY KEY,
  name         TEXT NOT NULL,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
-- Dữ liệu mẫu — quản trị viên cập nhật theo thông báo chính thức của Sở GDCK
INSERT INTO market_holidays (holiday_date, name) VALUES
  ('2027-01-01', 'Tết Dương lịch'),
  ('2027-04-30', 'Ngày Giải phóng miền Nam')
ON CONFLICT DO NOTHING;

-- Sao kê: thêm loại ADJUST (quản trị viên điều chỉnh vốn ảo)
ALTER TABLE transactions_ledger DROP CONSTRAINT transactions_ledger_type_check;
ALTER TABLE transactions_ledger ADD CONSTRAINT transactions_ledger_type_check
  CHECK (type IN ('DEPOSIT', 'BUY', 'SELL', 'FEE', 'TAX', 'RESET', 'ADJUST'));
