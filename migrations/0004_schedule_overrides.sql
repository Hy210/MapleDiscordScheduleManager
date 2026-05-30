CREATE TABLE IF NOT EXISTS schedule_overrides (
  id TEXT PRIMARY KEY,
  schedule_id TEXT NOT NULL,
  title TEXT,
  run_at TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  created_by TEXT NOT NULL,
  consumed_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_schedule_overrides_schedule_status_run
ON schedule_overrides (schedule_id, status, run_at);

CREATE INDEX IF NOT EXISTS idx_schedule_overrides_status_run
ON schedule_overrides (status, run_at);
