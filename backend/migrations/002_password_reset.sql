-- Quên mật khẩu: token đặt lại (chỉ lưu SHA-256, dùng 1 lần, hết hạn sau 30 phút)
CREATE TABLE password_reset_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  request_ip TEXT,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX password_reset_user_idx ON password_reset_tokens (user_id, created_at DESC);

-- JWT phát hành trước thời điểm này bị từ chối (đăng xuất mọi phiên sau khi đổi / đặt lại mật khẩu)
ALTER TABLE users ADD COLUMN password_changed_at TIMESTAMPTZ;
