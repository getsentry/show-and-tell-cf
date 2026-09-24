-- Keep historical Slack outcomes for audit, but never create/requeue Slack work.
DROP TRIGGER planned_show_reminders;
CREATE TRIGGER planned_show_reminders AFTER INSERT ON show_and_tell_events
WHEN NEW.reminder_at IS NOT NULL
BEGIN
  INSERT INTO show_reminders (event_id, channel) VALUES (NEW.id, 'email');
END;

DROP TRIGGER reschedule_show_reminders;
CREATE TRIGGER reschedule_show_reminders AFTER UPDATE OF starts_at, reminder_at ON show_and_tell_events
BEGIN
  UPDATE show_reminders SET status = 'pending', attempted_at = NULL, completed_at = NULL
    WHERE event_id = NEW.id AND channel = 'email' AND status IN ('pending', 'skipped', 'failed');
END;

UPDATE show_reminders SET status = 'skipped' WHERE channel = 'slack' AND status IN ('pending', 'failed');
UPDATE show_reminders SET status = 'uncertain' WHERE channel = 'slack' AND status = 'sending';
-- Preserve the announced-show guard: an old accepted/uncertain Slack message still matters.

-- Separate from scheduled deliveries and template revisions.
CREATE TABLE show_email_tests (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  request_id TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('sending', 'sent', 'uncertain')),
  attempted_at INTEGER NOT NULL,
  PRIMARY KEY (user_id, request_id)
) STRICT;
CREATE INDEX show_email_tests_user_time ON show_email_tests(user_id, attempted_at);
