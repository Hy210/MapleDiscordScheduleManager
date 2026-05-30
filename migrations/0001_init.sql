CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  title TEXT NOT NULL,

  target_url TEXT,
  keywords_json TEXT,

  run_at TEXT,
  repeat_rule TEXT,
  interval_minutes INTEGER,

  timezone TEXT NOT NULL DEFAULT 'Asia/Seoul',
  notify_channel_id TEXT NOT NULL,

  is_active INTEGER NOT NULL DEFAULT 1,

  next_run_at TEXT,
  last_run_at TEXT,
  last_success_at TEXT,
  last_error TEXT,

  created_by TEXT,
  updated_by TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS detected_events (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  event_key TEXT NOT NULL,
  title TEXT,
  source_url TEXT,
  detected_at TEXT NOT NULL,

  UNIQUE(schedule_id, event_key)
);

CREATE TABLE IF NOT EXISTS alerts (
  id TEXT PRIMARY KEY,
  schedule_id TEXT,
  title TEXT NOT NULL,
  message TEXT NOT NULL,
  source_url TEXT,
  discord_message_id TEXT,
  discord_channel_id TEXT,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS alert_reads (
  alert_id TEXT NOT NULL,
  user_discord_id TEXT NOT NULL,
  read_at TEXT NOT NULL,

  PRIMARY KEY (alert_id, user_discord_id)
);

CREATE TABLE IF NOT EXISTS schedule_changes (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  changed_by TEXT NOT NULL,
  change_type TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedules_due
ON schedules (is_active, next_run_at);

CREATE INDEX IF NOT EXISTS idx_schedules_channel
ON schedules (notify_channel_id);

CREATE INDEX IF NOT EXISTS idx_alerts_schedule
ON alerts (schedule_id);

CREATE INDEX IF NOT EXISTS idx_alert_reads_alert
ON alert_reads (alert_id);