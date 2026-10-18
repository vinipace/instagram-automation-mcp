CREATE TABLE IF NOT EXISTS instagram_automation.credentials (
  account_id TEXT PRIMARY KEY,
  ciphertext TEXT NOT NULL,
  revision INTEGER NOT NULL DEFAULT 1,
  stored_at DOUBLE PRECISION NOT NULL,
  expires_at DOUBLE PRECISION,
  refresh_not_before DOUBLE PRECISION NOT NULL,
  next_refresh_at DOUBLE PRECISION NOT NULL,
  refreshed_at DOUBLE PRECISION,
  refresh_claim TEXT,
  refresh_lease_until DOUBLE PRECISION NOT NULL DEFAULT 0,
  last_refresh_error TEXT,
  last_refresh_error_at DOUBLE PRECISION
);
CREATE TABLE IF NOT EXISTS instagram_automation.credential_operations (
  id BIGSERIAL PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES instagram_automation.credentials(account_id),
  operation TEXT NOT NULL,
  actor TEXT NOT NULL,
  changed_at DOUBLE PRECISION NOT NULL,
  revision INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS events_failure_recent ON instagram_automation.events (account_id, updated_at DESC, id) WHERE state IN ('failed','blocked','send_unknown');
INSERT INTO instagram_automation.schema_migrations (version) VALUES (2) ON CONFLICT DO NOTHING;
