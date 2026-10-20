-- Cộng đồng VNCoin (kiểu Binance Square) + kiểm duyệt nội dung. Nghiệp vụ: docs/CONG-DONG.md

-- Vai trò Kiểm duyệt nội dung
ALTER TABLE users DROP CONSTRAINT IF EXISTS users_role_check;
ALTER TABLE users ADD CONSTRAINT users_role_check
  CHECK (role IN ('USER', 'SUPPORT', 'SUPPORT_LEAD', 'ADMIN', 'MARKET_OPS', 'FINANCE', 'RISK', 'P2P_OPS', 'COMPLIANCE', 'MLRO', 'DPO',
                  'CONTENT_MOD', 'AUDITOR'));

-- Cấm vĩnh viễn / gỡ cấm dài hạn cần người thứ hai
ALTER TABLE approval_requests DROP CONSTRAINT IF EXISTS approval_requests_kind_check;
ALTER TABLE approval_requests ADD CONSTRAINT approval_requests_kind_check
  CHECK (kind IN ('PRICE_SET', 'SYMBOL_LIST', 'SYMBOL_DELIST', 'MARKET_HALT', 'MARKET_RESUME', 'DATA_RESTORE', 'ROLE_SET', 'ACCOUNT_RESET',
                  'AML_UNFREEZE', 'STR_FILE', 'SQUARE_BAN', 'SQUARE_UNBAN'));

-- Hồ sơ cộng đồng (bắt buộc trước khi đăng): @handle công khai, không lộ email / họ tên thật
CREATE TABLE square_profiles (
  user_id                UUID PRIMARY KEY REFERENCES users (id) ON DELETE CASCADE,
  handle                 TEXT NOT NULL UNIQUE CHECK (handle ~ '^[a-z0-9_]{3,20}$'),
  display_name           TEXT NOT NULL,
  bio                    TEXT NOT NULL DEFAULT '',
  guidelines_accepted_at TIMESTAMPTZ NOT NULL,
  banned_until           TIMESTAMPTZ,
  ban_permanent          BOOLEAN NOT NULL DEFAULT false,
  ban_reason             TEXT,
  created_at             TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE TABLE square_posts (
  id             BIGSERIAL PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  body           TEXT NOT NULL,
  sentiment      TEXT CHECK (sentiment IN ('BULLISH', 'BEARISH')),
  assets         TEXT[] NOT NULL DEFAULT '{}',
  hashtags       TEXT[] NOT NULL DEFAULT '{}',
  share          JSONB,
  status         TEXT NOT NULL CHECK (status IN ('PUBLISHED', 'PENDING', 'REMOVED', 'DELETED')),
  mod_hits       JSONB NOT NULL DEFAULT '[]',
  body_hash      TEXT NOT NULL,
  like_count     INT NOT NULL DEFAULT 0,
  comment_count  INT NOT NULL DEFAULT 0,
  reviewed_by    TEXT,
  reviewed_at    TIMESTAMPTZ,
  removed_by     TEXT,
  removed_rule   TEXT,
  removed_note   TEXT,
  removed_at     TIMESTAMPTZ,
  appeal_note    TEXT,
  appeal_at      TIMESTAMPTZ,
  appeal_status  TEXT CHECK (appeal_status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  created_at     TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX square_posts_status_idx ON square_posts (status, id DESC);
CREATE INDEX square_posts_user_idx ON square_posts (user_id, id DESC);
CREATE INDEX square_posts_assets_idx ON square_posts USING GIN (assets);
CREATE INDEX square_posts_hashtags_idx ON square_posts USING GIN (hashtags);

CREATE TABLE square_comments (
  id            BIGSERIAL PRIMARY KEY,
  post_id       BIGINT NOT NULL REFERENCES square_posts (id) ON DELETE CASCADE,
  user_id       UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  parent_id     BIGINT REFERENCES square_comments (id) ON DELETE CASCADE,
  body          TEXT NOT NULL,
  status        TEXT NOT NULL CHECK (status IN ('PUBLISHED', 'PENDING', 'REMOVED', 'DELETED')),
  mod_hits      JSONB NOT NULL DEFAULT '[]',
  reviewed_by   TEXT,
  reviewed_at   TIMESTAMPTZ,
  removed_by    TEXT,
  removed_rule  TEXT,
  removed_note  TEXT,
  removed_at    TIMESTAMPTZ,
  appeal_note   TEXT,
  appeal_at     TIMESTAMPTZ,
  appeal_status TEXT CHECK (appeal_status IN ('PENDING', 'ACCEPTED', 'REJECTED')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX square_comments_post_idx ON square_comments (post_id, id);
CREATE INDEX square_comments_user_idx ON square_comments (user_id, id DESC);

CREATE TABLE square_likes (
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  post_id    BIGINT NOT NULL REFERENCES square_posts (id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (user_id, post_id)
);
CREATE INDEX square_likes_post_idx ON square_likes (post_id);

CREATE TABLE square_follows (
  follower_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  followee_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  PRIMARY KEY (follower_id, followee_id),
  CHECK (follower_id <> followee_id)
);
CREATE INDEX square_follows_followee_idx ON square_follows (followee_id);

CREATE TABLE square_reports (
  id          BIGSERIAL PRIMARY KEY,
  target_type TEXT NOT NULL CHECK (target_type IN ('POST', 'COMMENT', 'PROFILE')),
  -- mã bài / bình luận; với hồ sơ là user_id
  target_id   TEXT NOT NULL,
  reporter_id UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  reason      TEXT NOT NULL CHECK (reason IN ('SPAM', 'SCAM', 'PII', 'ABUSE', 'OBSCENE', 'MANIPULATION', 'IMPERSONATION', 'OTHER')),
  note        TEXT NOT NULL DEFAULT '',
  status      TEXT NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN', 'ACTIONED', 'DISMISSED')),
  handled_by  TEXT,
  handled_at  TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (target_type, target_id, reporter_id)
);
CREATE INDEX square_reports_open_idx ON square_reports (status, target_type, target_id);

-- Vi phạm (thang phạt); gỡ khi khiếu nại thành công
CREATE TABLE square_strikes (
  id          BIGSERIAL PRIMARY KEY,
  user_id     UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  rule        TEXT NOT NULL,
  target_type TEXT NOT NULL CHECK (target_type IN ('POST', 'COMMENT', 'PROFILE')),
  target_id   TEXT,
  by_email    TEXT NOT NULL,
  note        TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  expires_at  TIMESTAMPTZ NOT NULL,
  revoked_at  TIMESTAMPTZ
);
CREATE INDEX square_strikes_user_idx ON square_strikes (user_id, expires_at);

CREATE TABLE square_notifications (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  kind       TEXT NOT NULL,
  actor_id   UUID REFERENCES users (id) ON DELETE SET NULL,
  post_id    BIGINT REFERENCES square_posts (id) ON DELETE CASCADE,
  comment_id BIGINT REFERENCES square_comments (id) ON DELETE CASCADE,
  detail     JSONB NOT NULL DEFAULT '{}',
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  read_at    TIMESTAMPTZ
);
CREATE INDEX square_notifications_user_idx ON square_notifications (user_id, id DESC);
