-- Dừng khẩn / mở lại sàn cần duyệt, loại tài khoản gian lận khỏi bảng xếp hạng, đối soát hằng ngày.
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_kind_check
  CHECK (kind IN ('PRICE_SET', 'SYMBOL_LIST', 'SYMBOL_DELIST', 'MARKET_HALT', 'MARKET_RESUME', 'DATA_RESTORE', 'ROLE_SET', 'ACCOUNT_RESET'));

-- Rủi ro & giám sát loại tài khoản khỏi bảng xếp hạng (khác tuỳ chọn ẩn tên của chính người dùng)
ALTER TABLE users ADD COLUMN leaderboard_banned_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN leaderboard_ban_reason TEXT;

-- Kết quả mỗi lần đối soát số dư ↔ sổ cái ↔ khớp lệnh
CREATE TABLE reconciliation_runs (
  id               BIGSERIAL PRIMARY KEY,
  started_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
  finished_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
  ok               BOOLEAN NOT NULL,
  balances_checked INTEGER NOT NULL DEFAULT 0,
  issue_count      INTEGER NOT NULL DEFAULT 0,
  issues           JSONB NOT NULL DEFAULT '[]'::jsonb,
  triggered_by     TEXT NOT NULL
);
CREATE INDEX reconciliation_runs_started_idx ON reconciliation_runs (started_at DESC);
