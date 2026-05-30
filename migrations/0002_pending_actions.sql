CREATE TABLE IF NOT EXISTS pending_actions (
  id TEXT PRIMARY KEY,
  action_type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',

  created_by TEXT NOT NULL,
  channel_id TEXT NOT NULL,
  guild_id TEXT,

  expires_at TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_pending_actions_status_expires
ON pending_actions (status, expires_at);

CREATE INDEX IF NOT EXISTS idx_pending_actions_created_by
ON pending_actions (created_by);