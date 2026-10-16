-- Giám sát & cảnh báo vận hành: lịch sử cảnh báo (CSDL chậm, event loop nghẽn, lỗi 5xx, mất nguồn giá...)
CREATE TABLE system_alerts (
  id          BIGSERIAL PRIMARY KEY,
  key         TEXT NOT NULL,
  level       TEXT NOT NULL CHECK (level IN ('warning', 'critical')),
  title       TEXT NOT NULL,
  detail      TEXT NOT NULL DEFAULT '',
  started_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
  resolved_at TIMESTAMPTZ,
  notified    BOOLEAN NOT NULL DEFAULT false
);
CREATE INDEX system_alerts_started_idx ON system_alerts (started_at DESC);
CREATE INDEX system_alerts_open_idx ON system_alerts (key) WHERE resolved_at IS NULL;
