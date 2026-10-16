-- Quản trị thị trường: loại chứng khoán, niêm yết / huỷ niêm yết, tỷ lệ cho vay ký quỹ theo mã,
-- tỷ lệ phí / thuế chốt theo từng lệnh (đổi biểu phí không ảnh hưởng lệnh đã đặt)

ALTER TABLE stocks ADD COLUMN type TEXT NOT NULL DEFAULT 'STOCK' CHECK (type IN ('STOCK', 'ETF', 'CW', 'BOND'));
ALTER TABLE stocks ADD COLUMN status TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'DELISTED'));
ALTER TABLE stocks ADD COLUMN listed_at DATE;
ALTER TABLE stocks ADD COLUMN delisted_at DATE;
ALTER TABLE stocks ADD COLUMN delist_reason TEXT;
-- Tỷ lệ cho vay ký quỹ: VN30 50%, HOSE 30%, HNX 20%, UPCOM không cho vay (tham khảo danh mục ký quỹ của các CTCK)
ALTER TABLE stocks ADD COLUMN margin_ratio REAL NOT NULL DEFAULT 0 CHECK (margin_ratio >= 0 AND margin_ratio <= 0.8);
UPDATE stocks SET margin_ratio = CASE WHEN is_vn30 THEN 0.5 WHEN exchange = 'HOSE' THEN 0.3 WHEN exchange = 'HNX' THEN 0.2 ELSE 0 END;

ALTER TABLE orders ADD COLUMN fee_rate DOUBLE PRECISION;
ALTER TABLE orders ADD COLUMN tax_rate DOUBLE PRECISION;

-- Sao kê: DELIST = thanh toán tiền khi mã bị huỷ niêm yết
ALTER TABLE transactions_ledger DROP CONSTRAINT transactions_ledger_type_check;
ALTER TABLE transactions_ledger ADD CONSTRAINT transactions_ledger_type_check
  CHECK (type IN ('DEPOSIT', 'BUY', 'SELL', 'FEE', 'TAX', 'RESET', 'ADJUST', 'DELIST'));
