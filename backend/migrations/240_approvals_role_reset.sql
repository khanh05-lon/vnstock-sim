-- Thêm loại đề xuất 2 người: cấp / đổi vai trò nhân viên, đặt lại tài khoản khách.
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_kind_check
  CHECK (kind IN ('PRICE_SET', 'SYMBOL_LIST', 'SYMBOL_DELIST', 'MARKET_HALT', 'DATA_RESTORE', 'ROLE_SET', 'ACCOUNT_RESET'));
