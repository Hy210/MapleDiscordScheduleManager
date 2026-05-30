ALTER TABLE schedules ADD COLUMN parent_schedule_id TEXT;
ALTER TABLE schedules ADD COLUMN reminder_kind TEXT;
ALTER TABLE schedules ADD COLUMN offset_minutes INTEGER;

UPDATE schedules
SET reminder_kind = 'main'
WHERE reminder_kind IS NULL;

CREATE INDEX IF NOT EXISTS idx_schedules_parent
ON schedules (parent_schedule_id);

CREATE INDEX IF NOT EXISTS idx_schedules_kind
ON schedules (reminder_kind);
