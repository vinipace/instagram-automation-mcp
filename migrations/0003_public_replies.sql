ALTER TABLE instagram_automation.events ADD COLUMN IF NOT EXISTS public_reply_text TEXT;
CREATE TABLE IF NOT EXISTS instagram_automation.comment_replies (
  event_id TEXT PRIMARY KEY REFERENCES instagram_automation.events(id) ON DELETE CASCADE,
  account_id TEXT NOT NULL, comment_id TEXT NOT NULL, reply_text TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('pending','retry','sending','provider_accepted','send_unknown','blocked','failed','canceled')),
  reason TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0, max_attempts INTEGER NOT NULL DEFAULT 5,
  next_attempt_at DOUBLE PRECISION NOT NULL DEFAULT 0, next_enqueue_at DOUBLE PRECISION NOT NULL DEFAULT 0,
  queued_at DOUBLE PRECISION, claim_token TEXT, sending_started_at DOUBLE PRECISION,
  created_at DOUBLE PRECISION NOT NULL, updated_at DOUBLE PRECISION NOT NULL,
  provider_reply_id TEXT, provider_error_code INTEGER, provider_error_subcode INTEGER
);
CREATE INDEX IF NOT EXISTS comment_replies_pending ON instagram_automation.comment_replies (account_id,state,next_attempt_at,next_enqueue_at);
CREATE TABLE IF NOT EXISTS instagram_automation.comment_reply_attempts (
  claim_token TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES instagram_automation.comment_replies(event_id) ON DELETE CASCADE,
  started_at DOUBLE PRECISION NOT NULL, finished_at DOUBLE PRECISION, outcome TEXT NOT NULL,
  provider_error_code INTEGER, provider_error_subcode INTEGER
);
CREATE INDEX IF NOT EXISTS comment_reply_attempts_event ON instagram_automation.comment_reply_attempts (event_id,started_at);
INSERT INTO instagram_automation.schema_migrations (version) VALUES (3) ON CONFLICT DO NOTHING;
