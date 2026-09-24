-- Trash preserves submissions, upload records, and R2 objects for restoration.
ALTER TABLE show_and_tell_events ADD COLUMN trashed_at TEXT;
