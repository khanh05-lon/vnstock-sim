-- Trách nhiệm & dấu vết: nhật ký quản trị chỉ ghi thêm, nhật ký đăng nhập, nhật ký lệnh,
-- duyệt điều chỉnh số dư 2 người, xoá người dùng = ẩn danh, vai trò nhân viên CSKH, hỗ trợ khách hàng.

/* ---------------- 1. Nhật ký quản trị: độc lập, chỉ được ghi thêm ---------------- */
-- Bỏ khoá ngoại tới users: TRUNCATE users CASCADE khi khôi phục sao lưu không được kéo nhật ký đi theo
ALTER TABLE admin_audit_log DROP CONSTRAINT IF EXISTS admin_audit_log_admin_id_fkey;

CREATE OR REPLACE FUNCTION append_only_guard() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'Bảng % chỉ được ghi thêm, không được sửa hoặc xoá', TG_TABLE_NAME;
END $$;

CREATE TRIGGER admin_audit_log_append_only BEFORE UPDATE OR DELETE ON admin_audit_log
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();
CREATE TRIGGER admin_audit_log_no_truncate BEFORE TRUNCATE ON admin_audit_log
  FOR EACH STATEMENT EXECUTE FUNCTION append_only_guard();

/* ---------------- 2. Vai trò nhân viên CSKH, tài khoản đã xoá (ẩn danh) ---------------- */
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check CHECK (role IN ('USER', 'SUPPORT', 'ADMIN'));
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_status_check;
ALTER TABLE users ADD CONSTRAINT users_status_check CHECK (status IN ('ACTIVE', 'LOCKED', 'DELETED'));
ALTER TABLE users ADD COLUMN deleted_at TIMESTAMPTZ;

/* ---------------- 3. Nhật ký đăng nhập & bảo mật ---------------- */
-- Không khoá ngoại: giữ nguyên khi khôi phục sao lưu / ẩn danh tài khoản
CREATE TABLE auth_events (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID,
  email      TEXT,
  event      TEXT NOT NULL,
  ip         TEXT,
  user_agent TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX auth_events_user ON auth_events (user_id, created_at DESC);
CREATE INDEX auth_events_email ON auth_events (email, event, created_at DESC);
CREATE TRIGGER auth_events_append_only BEFORE UPDATE OR DELETE ON auth_events
  FOR EACH ROW EXECUTE FUNCTION append_only_guard();

/* ---------------- 4. Nhật ký lệnh ---------------- */
-- PLACE / REPLACE / CANCEL / EXPIRE / TRIGGER / REJECT; actor: USER, SYSTEM hoặc email nhân viên
CREATE TABLE order_events (
  id         BIGSERIAL PRIMARY KEY,
  order_id   BIGINT NOT NULL,
  user_id    UUID NOT NULL,
  event      TEXT NOT NULL,
  actor      TEXT NOT NULL,
  ip         TEXT,
  detail     JSONB NOT NULL DEFAULT '{}'::jsonb,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX order_events_order ON order_events (order_id, id);
CREATE INDEX order_events_user ON order_events (user_id, created_at DESC);

/* ---------------- 5. Điều chỉnh số dư cần người thứ hai duyệt ---------------- */
CREATE TABLE balance_adjust_requests (
  id                 BIGSERIAL PRIMARY KEY,
  user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  asset              TEXT NOT NULL,
  amount             NUMERIC(36,18) NOT NULL CHECK (amount <> 0),
  usdt_value         NUMERIC(36,18) NOT NULL,
  reason             TEXT NOT NULL,
  ticket_id          BIGINT,
  requested_by       UUID NOT NULL,
  requested_by_email TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING', 'APPROVED', 'REJECTED', 'CANCELLED')),
  decided_by         UUID,
  decided_by_email   TEXT,
  decision_note      TEXT,
  decided_at         TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX balance_adjust_pending ON balance_adjust_requests (created_at) WHERE status = 'PENDING';

/* ---------------- 6. Hỗ trợ khách hàng ---------------- */
CREATE TABLE support_tickets (
  id                     BIGSERIAL PRIMARY KEY,
  user_id                UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  subject                TEXT NOT NULL CHECK (char_length(subject) BETWEEN 3 AND 120),
  category               TEXT NOT NULL CHECK (category IN ('ORDER', 'BALANCE', 'ACCOUNT', 'SECURITY', 'DATA', 'OTHER')),
  priority               TEXT NOT NULL DEFAULT 'NORMAL' CHECK (priority IN ('NORMAL', 'HIGH', 'URGENT')),
  status                 TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER', 'RESOLVED', 'CLOSED')),
  order_id               BIGINT,
  assignee_id            UUID,
  assignee_email         TEXT,
  -- thời điểm tin nhắn đầu tiên của khách chưa được nhân viên trả lời (tính hạn xử lý)
  customer_waiting_since TIMESTAMPTZ,
  first_response_at      TIMESTAMPTZ,
  resolved_at            TIMESTAMPTZ,
  resolved_by_email      TEXT,
  resolution             TEXT,
  rating                 SMALLINT CHECK (rating BETWEEN 1 AND 5),
  rating_comment         TEXT,
  customer_unread        INTEGER NOT NULL DEFAULT 0,
  staff_unread           INTEGER NOT NULL DEFAULT 0,
  last_message_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_tickets_user ON support_tickets (user_id, last_message_at DESC);
CREATE INDEX support_tickets_active ON support_tickets (status, priority, created_at)
  WHERE status IN ('OPEN', 'IN_PROGRESS', 'WAITING_CUSTOMER');

CREATE TABLE support_messages (
  id           BIGSERIAL PRIMARY KEY,
  ticket_id    BIGINT NOT NULL REFERENCES support_tickets(id) ON DELETE CASCADE,
  author_id    UUID,
  author_email TEXT,
  author_kind  TEXT NOT NULL CHECK (author_kind IN ('CUSTOMER', 'STAFF', 'SYSTEM')),
  body         TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 4000),
  -- ghi chú nội bộ: chỉ nhân viên thấy
  internal     BOOLEAN NOT NULL DEFAULT false,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX support_messages_ticket ON support_messages (ticket_id, id);
-- Tin nhắn hỗ trợ là bằng chứng xử lý khiếu nại: không sửa / xoá.
-- Ngoại lệ duy nhất: xoá hẳn tài khoản thử ở môi trường chạy thử (SET LOCAL vss.purge = 'on').
CREATE OR REPLACE FUNCTION append_only_unless_purge() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' AND current_setting('vss.purge', true) = 'on' THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'Bảng % chỉ được ghi thêm, không được sửa hoặc xoá', TG_TABLE_NAME;
END $$;
CREATE TRIGGER support_messages_append_only BEFORE UPDATE OR DELETE ON support_messages
  FOR EACH ROW EXECUTE FUNCTION append_only_unless_purge();
