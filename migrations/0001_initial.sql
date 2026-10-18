CREATE SCHEMA IF NOT EXISTS instagram_automation;
CREATE TABLE IF NOT EXISTS instagram_automation.schema_migrations (version INTEGER PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now());
CREATE TABLE IF NOT EXISTS instagram_automation.account_settings (
  id INTEGER PRIMARY KEY CHECK (id = 1), paused BOOLEAN NOT NULL DEFAULT TRUE,
  revision INTEGER NOT NULL DEFAULT 1, updated_at DOUBLE PRECISION NOT NULL, actor TEXT NOT NULL,
  last_webhook_at DOUBLE PRECISION, last_recovery_at DOUBLE PRECISION
);
INSERT INTO instagram_automation.account_settings (id, paused, revision, updated_at, actor)
VALUES (1, TRUE, 1, extract(epoch from now()), 'migration') ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS instagram_automation.rules (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, revision INTEGER NOT NULL, enabled BOOLEAN NOT NULL,
  definition JSONB NOT NULL, created_at DOUBLE PRECISION NOT NULL, updated_at DOUBLE PRECISION NOT NULL, actor TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS rules_account ON instagram_automation.rules (account_id, enabled);
CREATE TABLE IF NOT EXISTS instagram_automation.rule_history (
  rule_id TEXT NOT NULL REFERENCES instagram_automation.rules(id), revision INTEGER NOT NULL, enabled BOOLEAN NOT NULL,
  definition JSONB NOT NULL, actor TEXT NOT NULL, changed_at DOUBLE PRECISION NOT NULL, PRIMARY KEY (rule_id, revision)
);
CREATE TABLE IF NOT EXISTS instagram_automation.account_history (
  revision INTEGER PRIMARY KEY, paused BOOLEAN NOT NULL, actor TEXT NOT NULL, changed_at DOUBLE PRECISION NOT NULL
);
CREATE TABLE IF NOT EXISTS instagram_automation.events (
  id TEXT PRIMARY KEY, account_id TEXT NOT NULL, comment_id TEXT NOT NULL, commenter_id TEXT NOT NULL,
  media_id TEXT NOT NULL, comment_text TEXT NOT NULL, comment_at DOUBLE PRECISION NOT NULL,
  received_at DOUBLE PRECISION NOT NULL, expires_at DOUBLE PRECISION NOT NULL,
  rule_id TEXT REFERENCES instagram_automation.rules(id), rule_revision INTEGER, reply_text TEXT,
  cooldown_seconds INTEGER NOT NULL DEFAULT 0,
  state TEXT NOT NULL CHECK (state IN ('pending', 'retry', 'sending', 'provider_accepted', 'send_unknown', 'skipped', 'blocked', 'failed', 'canceled')),
  reason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  safe_to_retry BOOLEAN NOT NULL DEFAULT FALSE, next_attempt_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  next_enqueue_at DOUBLE PRECISION NOT NULL DEFAULT 0, queued_at DOUBLE PRECISION, claim_token TEXT,
  sending_started_at DOUBLE PRECISION, updated_at DOUBLE PRECISION NOT NULL,
  provider_message_id TEXT, provider_recipient_id TEXT, provider_error_code INTEGER, provider_error_subcode INTEGER,
  UNIQUE (account_id, comment_id)
);
CREATE INDEX IF NOT EXISTS events_pending ON instagram_automation.events (state, next_enqueue_at, next_attempt_at);
CREATE INDEX IF NOT EXISTS events_recent ON instagram_automation.events (account_id, received_at DESC, id);
CREATE INDEX IF NOT EXISTS events_rule ON instagram_automation.events (rule_id, state);
CREATE TABLE IF NOT EXISTS instagram_automation.contact_gates (
  account_id TEXT NOT NULL, commenter_id TEXT NOT NULL, owner_event_id TEXT NOT NULL,
  next_allowed_at DOUBLE PRECISION NOT NULL, PRIMARY KEY (account_id, commenter_id)
);
CREATE TABLE IF NOT EXISTS instagram_automation.send_attempts (
  claim_token TEXT PRIMARY KEY, event_id TEXT NOT NULL REFERENCES instagram_automation.events(id) ON DELETE CASCADE,
  started_at DOUBLE PRECISION NOT NULL, finished_at DOUBLE PRECISION, outcome TEXT NOT NULL,
  provider_error_code INTEGER, provider_error_subcode INTEGER
);
CREATE INDEX IF NOT EXISTS attempts_event ON instagram_automation.send_attempts (event_id, started_at);
INSERT INTO instagram_automation.schema_migrations (version) VALUES (1) ON CONFLICT DO NOTHING;
CREATE TABLE IF NOT EXISTS instagram_automation.event_operations (
  id BIGSERIAL PRIMARY KEY, event_id TEXT NOT NULL REFERENCES instagram_automation.events(id) ON DELETE CASCADE,
  operation TEXT NOT NULL, actor TEXT NOT NULL, changed_at DOUBLE PRECISION NOT NULL
);
CREATE INDEX IF NOT EXISTS operations_event ON instagram_automation.event_operations (event_id, changed_at DESC);
