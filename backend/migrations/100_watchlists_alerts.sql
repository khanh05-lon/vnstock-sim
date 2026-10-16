-- Nhiều danh sách theo dõi cho mỗi người dùng
CREATE TABLE watchlist_lists (
  id         BIGSERIAL PRIMARY KEY,
  user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name       TEXT NOT NULL CHECK (char_length(name) BETWEEN 1 AND 40),
  sort       INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, name)
);
CREATE INDEX watchlist_lists_user ON watchlist_lists (user_id, sort, id);

-- Danh sách cũ (1 danh sách / người) thành danh sách mặc định
INSERT INTO watchlist_lists (user_id, name) SELECT DISTINCT user_id, 'Theo dõi' FROM watchlists;
ALTER TABLE watchlists ADD COLUMN list_id BIGINT REFERENCES watchlist_lists(id) ON DELETE CASCADE;
UPDATE watchlists w SET list_id = l.id FROM watchlist_lists l WHERE l.user_id = w.user_id;
ALTER TABLE watchlists ALTER COLUMN list_id SET NOT NULL;
ALTER TABLE watchlists DROP CONSTRAINT watchlists_pkey;
ALTER TABLE watchlists ADD PRIMARY KEY (list_id, symbol);
CREATE INDEX watchlists_user ON watchlists (user_id);

-- Cảnh báo giá: kích hoạt 1 lần rồi dừng
CREATE TABLE price_alerts (
  id              BIGSERIAL PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  symbol          TEXT NOT NULL REFERENCES stocks(symbol),
  -- PRICE_ABOVE / PRICE_BELOW: value = giá (đ); CHANGE_UP / CHANGE_DOWN: value = % so với tham chiếu × 100;
  -- VOLUME_ABOVE: value = tổng khối lượng khớp trong phiên
  kind            TEXT NOT NULL CHECK (kind IN ('PRICE_ABOVE', 'PRICE_BELOW', 'CHANGE_UP', 'CHANGE_DOWN', 'VOLUME_ABOVE')),
  value           BIGINT NOT NULL CHECK (value > 0),
  note            TEXT,
  notify_email    BOOLEAN NOT NULL DEFAULT false,
  status          TEXT NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE', 'TRIGGERED', 'CANCELLED')),
  triggered_price BIGINT,
  triggered_at    TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
);
CREATE INDEX price_alerts_active ON price_alerts (symbol) WHERE status = 'ACTIVE';
CREATE INDEX price_alerts_user ON price_alerts (user_id, created_at DESC);
