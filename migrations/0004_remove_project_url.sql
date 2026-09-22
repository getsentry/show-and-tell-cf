-- Submissions are videos, not links to separate projects.
-- Permanently discard old project URLs; preserve submission IDs and video relations.
ALTER TABLE submissions DROP COLUMN project_url;
