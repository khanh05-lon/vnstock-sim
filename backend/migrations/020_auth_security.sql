-- Bảo mật tài khoản: xác thực email, xác thực 2 lớp (TOTP), tuỳ chọn thông báo & riêng tư

-- Xác thực email: link gửi khi đăng ký (chỉ lưu SHA-256 của token, dùng 1 lần)
ALTER TABLE users ADD COLUMN email_verified_at TIMESTAMPTZ;
-- Tài khoản quản trị có sẵn coi như đã xác thực
UPDATE users SET email_verified_at = created_at WHERE role = 'ADMIN';

CREATE TABLE email_verification_tokens (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token_hash TEXT NOT NULL UNIQUE,
  expires_at TIMESTAMPTZ NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX email_verification_user_idx ON email_verification_tokens (user_id, created_at DESC);

-- 2FA bằng ứng dụng xác thực (Google Authenticator, Microsoft Authenticator...)
-- Bí mật được mã hoá AES-256-GCM khi có DATA_ENCRYPTION_KEY
ALTER TABLE users ADD COLUMN totp_secret TEXT;
ALTER TABLE users ADD COLUMN totp_pending_secret TEXT;     -- đang chờ người dùng nhập mã đầu tiên để bật
ALTER TABLE users ADD COLUMN totp_pending_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN totp_enabled_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN totp_last_step BIGINT;        -- bước thời gian của mã vừa dùng (chống dùng lại)

-- Mã khôi phục 2FA (dùng 1 lần khi mất điện thoại), chỉ lưu SHA-256
CREATE TABLE recovery_codes (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  code_hash  TEXT NOT NULL,
  used_at    TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX recovery_codes_user_idx ON recovery_codes (user_id);

-- Tuỳ chọn của người dùng
ALTER TABLE users ADD COLUMN notify_fills BOOLEAN NOT NULL DEFAULT false;      -- email tổng hợp lệnh khớp
ALTER TABLE users ADD COLUMN display_name TEXT;                               -- tên hiển thị trên bảng xếp hạng
ALTER TABLE users ADD COLUMN show_on_leaderboard BOOLEAN NOT NULL DEFAULT true;
