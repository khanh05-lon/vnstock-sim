-- Phân quyền nhân viên theo chức năng + hàng chờ duyệt 2 người cho thao tác lớn.
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('USER', 'SUPPORT', 'ADMIN', 'MARKET_OPS', 'FINANCE', 'RISK', 'AUDITOR'));

-- Đề xuất thao tác lớn: người đề xuất và người duyệt phải khác nhau; duyệt xong hệ thống mới thực hiện.
-- Không khoá ngoại tới users (giữ nguyên khi tài khoản bị xoá); mỗi quyết định còn ghi admin_audit_log.
CREATE TABLE approval_requests (
  id                 BIGSERIAL PRIMARY KEY,
  kind               TEXT NOT NULL CHECK (kind IN ('PRICE_SET', 'SYMBOL_LIST', 'SYMBOL_DELIST', 'MARKET_HALT', 'DATA_RESTORE')),
  target             TEXT,
  payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
  summary            TEXT NOT NULL,
  reason             TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING'
                     CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED')),
  requested_by       UUID NOT NULL,
  requested_by_email TEXT NOT NULL,
  requested_role     TEXT NOT NULL,
  decided_by         UUID,
  decided_by_email   TEXT,
  decision_note      TEXT,
  decided_at         TIMESTAMPTZ,
  result             JSONB,
  expires_at         TIMESTAMPTZ NOT NULL,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX approval_requests_status_idx ON approval_requests (status, created_at DESC);
-- Mỗi thao tác (loại + đối tượng) chỉ có 1 đề xuất đang chờ
CREATE UNIQUE INDEX approval_requests_pending_uniq ON approval_requests (kind, (COALESCE(target, ''))) WHERE status = 'PENDING';
