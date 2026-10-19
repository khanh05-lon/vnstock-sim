-- Sắp xếp lại vai trò theo phân tách trách nhiệm (SoD) như sàn thật + cấp VIP phí + quyền của chủ thể dữ liệu.

-- Vai trò mới: Trưởng nhóm CSKH, Trưởng Tuân thủ (MLRO), Vận hành P2P, Bảo vệ dữ liệu cá nhân (DPO)
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('USER', 'SUPPORT', 'SUPPORT_LEAD', 'ADMIN', 'MARKET_OPS', 'FINANCE', 'RISK', 'P2P_OPS', 'COMPLIANCE', 'MLRO', 'DPO', 'AUDITOR'));

-- STR do chuyên viên Tuân thủ soạn phải được MLRO duyệt nộp
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_kind_check
  CHECK (kind IN ('PRICE_SET', 'SYMBOL_LIST', 'SYMBOL_DELIST', 'MARKET_HALT', 'MARKET_RESUME', 'DATA_RESTORE', 'ROLE_SET', 'ACCOUNT_RESET',
                  'AML_UNFREEZE', 'STR_FILE'));

-- Cấp VIP phí Spot (tính lại 00:00 UTC hằng ngày theo khối lượng 30 ngày + BNB nắm giữ)
ALTER TABLE users ADD COLUMN vip_level SMALLINT NOT NULL DEFAULT 0 CHECK (vip_level BETWEEN 0 AND 9);
ALTER TABLE users ADD COLUMN vip_volume_30d NUMERIC(36, 18) NOT NULL DEFAULT 0;
ALTER TABLE users ADD COLUMN vip_updated_at TIMESTAMPTZ;

-- Yêu cầu của chủ thể dữ liệu (xoá tài khoản = ẩn danh, giữ dữ liệu giao dịch theo nghĩa vụ lưu trữ)
CREATE TABLE privacy_requests (
  id            BIGSERIAL PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  type          TEXT NOT NULL DEFAULT 'DELETE' CHECK (type IN ('DELETE')),
  reason        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by    TEXT,
  decision_note TEXT,
  decided_at    TIMESTAMPTZ,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX privacy_requests_status_idx ON privacy_requests (status, created_at);
CREATE UNIQUE INDEX privacy_requests_one_pending ON privacy_requests (user_id) WHERE status = 'PENDING';
