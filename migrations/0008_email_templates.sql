-- Versioned global email copy. Saves never enqueue or retry a reminder.
CREATE TABLE show_email_templates (
  revision INTEGER PRIMARY KEY CHECK (revision > 0),
  template_json TEXT NOT NULL CHECK (json_valid(template_json)),
  updated_by TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
