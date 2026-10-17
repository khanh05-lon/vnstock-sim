-- Chế độ giá từng cặp do quản trị viên chọn:
--   LIVE   = giá thực tế (Binance)
--   MANUAL = giá điều chỉnh: sàn tự sinh giá theo kịch bản trong price_control
--            {since, from, to, startAt, endAt, volatilityPct, reason, by}
-- Lịch sử thay đổi nằm trong admin_audit_log (PRICE_MODE_MANUAL / PRICE_SET / PRICE_MODE_LIVE).
ALTER TABLE symbols ADD COLUMN price_mode TEXT NOT NULL DEFAULT 'LIVE';
ALTER TABLE symbols ADD CONSTRAINT symbols_price_mode_check CHECK (price_mode IN ('LIVE', 'MANUAL'));
ALTER TABLE symbols ADD COLUMN price_control JSONB;
