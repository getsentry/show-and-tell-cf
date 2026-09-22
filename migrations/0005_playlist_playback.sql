-- New submissions append after explicitly ordered entries; ties are stable by creation/id.
ALTER TABLE submissions ADD COLUMN playlist_position INTEGER NOT NULL DEFAULT 2147483647
  CHECK (playlist_position >= 0);
CREATE INDEX submissions_playlist_order_idx
  ON submissions(event_id, playlist_position, created_at, id);

-- Keep an authenticated, browser-bound login's destination with its OAuth state.
ALTER TABLE oauth_login_attempts ADD COLUMN return_to TEXT NOT NULL DEFAULT '/';
