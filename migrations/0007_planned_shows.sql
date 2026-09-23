ALTER TABLE show_and_tell_events ADD COLUMN slug TEXT NOT NULL DEFAULT '';
ALTER TABLE show_and_tell_events ADD COLUMN is_hidden INTEGER NOT NULL DEFAULT 0 CHECK (is_hidden IN (0, 1));
ALTER TABLE show_and_tell_events ADD COLUMN starts_at TEXT;
ALTER TABLE show_and_tell_events ADD COLUMN timezone TEXT;
ALTER TABLE show_and_tell_events ADD COLUMN meeting_url TEXT;
ALTER TABLE show_and_tell_events ADD COLUMN reminder_at TEXT;
ALTER TABLE show_and_tell_events ADD COLUMN revealed_at TEXT;
ALTER TABLE show_and_tell_events ADD COLUMN cancelled_at TEXT;
ALTER TABLE show_and_tell_events ADD COLUMN plan_key TEXT;
ALTER TABLE show_and_tell_events ADD COLUMN plan_updated_by TEXT REFERENCES users(id);
CREATE UNIQUE INDEX events_plan_key ON show_and_tell_events(plan_key) WHERE plan_key IS NOT NULL;
CREATE INDEX events_reminder_at ON show_and_tell_events(reminder_at) WHERE cancelled_at IS NULL;

CREATE TABLE show_reminders (
  event_id TEXT NOT NULL REFERENCES show_and_tell_events(id) ON DELETE CASCADE,
  channel TEXT NOT NULL CHECK (channel IN ('email', 'slack')),
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'sending', 'sent', 'uncertain', 'failed', 'skipped')),
  attempted_at TEXT,
  completed_at TEXT,
  provider_id TEXT,
  retry_by TEXT REFERENCES users(id),
  PRIMARY KEY (event_id, channel)
) STRICT;

-- The plan and delivery records are created in the same transaction, even through Wrangler.
CREATE TRIGGER planned_show_reminders AFTER INSERT ON show_and_tell_events
WHEN NEW.reminder_at IS NOT NULL
BEGIN
  INSERT INTO show_reminders (event_id, channel) VALUES (NEW.id, 'email'), (NEW.id, 'slack');
END;

CREATE TRIGGER reschedule_show_reminders AFTER UPDATE OF starts_at, reminder_at ON show_and_tell_events
BEGIN
  UPDATE show_reminders SET status = 'pending', attempted_at = NULL, completed_at = NULL
    WHERE event_id = NEW.id AND status IN ('pending', 'skipped', 'failed');
END;

-- Never silently race a send or re-send an already announced event after a date edit.
CREATE TRIGGER guard_announced_show_update BEFORE UPDATE OF starts_at, reminder_at, cancelled_at ON show_and_tell_events
WHEN EXISTS (SELECT 1 FROM show_reminders WHERE event_id = OLD.id AND status IN ('sending', 'uncertain', 'sent'))
BEGIN
  SELECT RAISE(ABORT, 'Delivery started: reconcile reminders and send an explicit correction before changing the plan');
END;

CREATE TABLE show_plan_audit (
  id INTEGER PRIMARY KEY,
  event_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  recorded_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
) STRICT;
CREATE TRIGGER audit_show_plan_create AFTER INSERT ON show_and_tell_events
WHEN NEW.plan_key IS NOT NULL
BEGIN
  INSERT INTO show_plan_audit (event_id, actor_id, action) VALUES (NEW.id, NEW.created_by, 'create');
END;
CREATE TRIGGER audit_show_plan_update AFTER UPDATE OF starts_at, reminder_at, cancelled_at ON show_and_tell_events
WHEN NEW.plan_key IS NOT NULL
BEGIN
  INSERT INTO show_plan_audit (event_id, actor_id, action) VALUES
    (NEW.id, NEW.plan_updated_by, CASE WHEN NEW.cancelled_at IS NULL THEN 'reschedule' ELSE 'cancel' END);
END;
CREATE TRIGGER audit_show_reminder_retry AFTER UPDATE OF status ON show_reminders
WHEN OLD.status = 'failed' AND NEW.status = 'pending'
BEGIN
  INSERT INTO show_plan_audit (event_id, actor_id, action) VALUES (NEW.event_id, COALESCE(NEW.retry_by, (SELECT plan_updated_by FROM show_and_tell_events WHERE id = NEW.event_id)), 'retry-' || NEW.channel);
END;
