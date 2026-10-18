CREATE TABLE IF NOT EXISTS instagram_automation.post_contact_gates (
  account_id TEXT NOT NULL, media_id TEXT NOT NULL, commenter_id TEXT NOT NULL,
  owner_event_id TEXT NOT NULL, next_allowed_at DOUBLE PRECISION NOT NULL,
  PRIMARY KEY (account_id, media_id, commenter_id)
);
INSERT INTO instagram_automation.post_contact_gates AS gate (account_id,media_id,commenter_id,owner_event_id,next_allowed_at)
SELECT g.account_id,e.media_id,g.commenter_id,g.owner_event_id,g.next_allowed_at
FROM instagram_automation.contact_gates g LEFT JOIN instagram_automation.events e
  ON e.id=g.owner_event_id AND e.account_id=g.account_id AND e.commenter_id=g.commenter_id
ON CONFLICT (account_id,media_id,commenter_id) DO UPDATE
  SET owner_event_id=EXCLUDED.owner_event_id,next_allowed_at=EXCLUDED.next_allowed_at
  WHERE gate.next_allowed_at < EXCLUDED.next_allowed_at;
INSERT INTO instagram_automation.schema_migrations (version) VALUES (4) ON CONFLICT DO NOTHING;
