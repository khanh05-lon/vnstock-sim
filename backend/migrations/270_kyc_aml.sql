-- Xác minh danh tính (KYC) theo cấp + bộ phận Tuân thủ chống rửa tiền (AML).

-- Vai trò Tuân thủ
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('USER', 'SUPPORT', 'ADMIN', 'MARKET_OPS', 'FINANCE', 'RISK', 'COMPLIANCE', 'AUDITOR'));

-- Cấp KYC đã duyệt + họ tên theo giấy tờ (chính chủ cho ngân hàng / phương thức thanh toán P2P)
ALTER TABLE users ADD COLUMN kyc_level SMALLINT NOT NULL DEFAULT 0 CHECK (kyc_level BETWEEN 0 AND 2);
ALTER TABLE users ADD COLUMN kyc_name TEXT;
-- Tuân thủ hạn chế giao dịch (vẫn đăng nhập được, không đặt lệnh Spot / P2P mới)
ALTER TABLE users ADD COLUMN aml_restricted_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN aml_restricted_reason TEXT;
ALTER TABLE users ADD COLUMN aml_restricted_by TEXT;

-- Thương nhân P2P đang hoạt động: coi như đã xác minh nâng cao để không bị khoá đột ngột
UPDATE users u SET kyc_level = 2, kyc_name = u.full_name
FROM p2p_merchants m WHERE m.user_id = u.id AND m.status IN ('ACTIVE', 'SUSPENDED', 'PENDING');

-- Hồ sơ KYC: dữ liệu khai báo mã hoá (sealSecret), số giấy tờ chỉ giữ mã băm HMAC (dò trùng) + 4 số cuối
CREATE TABLE kyc_applications (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  level         SMALLINT NOT NULL CHECK (level IN (1, 2)),
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED')),
  data_enc      TEXT NOT NULL,
  id_hash       TEXT,
  id_last4      TEXT,
  flags         JSONB NOT NULL DEFAULT '[]'::jsonb,
  reject_reason TEXT,
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX kyc_applications_status_idx ON kyc_applications (status, created_at);
CREATE INDEX kyc_applications_user_idx ON kyc_applications (user_id, level, id DESC);
CREATE INDEX kyc_applications_id_hash_idx ON kyc_applications (id_hash) WHERE id_hash IS NOT NULL;
-- Mỗi người chỉ có 1 hồ sơ đang chờ cho mỗi cấp
CREATE UNIQUE INDEX kyc_applications_one_pending ON kyc_applications (user_id, level) WHERE status = 'PENDING';

-- Cảnh báo AML (quét theo quy tắc). dedupe_key = rule:user:ngày → mỗi ngày 1 cảnh báo / quy tắc / người
CREATE TABLE aml_alerts (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,
  severity    TEXT NOT NULL CHECK (severity IN ('LOW', 'MEDIUM', 'HIGH')),
  detail      JSONB NOT NULL DEFAULT '{}'::jsonb,
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'REVIEWING', 'CLOSED', 'REPORTED')),
  dedupe_key  TEXT NOT NULL UNIQUE,
  notes       TEXT,
  handled_by  TEXT,
  handled_at  TIMESTAMPTZ,
  report_id   BIGINT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX aml_alerts_status_idx ON aml_alerts (status, created_at DESC);
CREATE INDEX aml_alerts_user_idx ON aml_alerts (user_id, created_at DESC);

-- Báo cáo giao dịch đáng ngờ (STR): chỉ được ghi thêm
CREATE TABLE aml_reports (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  alert_ids   BIGINT[] NOT NULL,
  narrative   TEXT NOT NULL,
  created_by  TEXT NOT NULL,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE TRIGGER aml_reports_append_only BEFORE UPDATE OR DELETE ON aml_reports
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

-- Gỡ hạn chế tài khoản cần người Tuân thủ thứ hai duyệt
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_kind_check
  CHECK (kind IN ('PRICE_SET', 'SYMBOL_LIST', 'SYMBOL_DELIST', 'MARKET_HALT', 'MARKET_RESUME', 'DATA_RESTORE', 'ROLE_SET', 'ACCOUNT_RESET', 'AML_UNFREEZE'));
