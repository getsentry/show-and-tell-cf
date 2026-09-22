import {applyD1Migrations, env} from 'cloudflare:test';
import {expect, it} from 'vitest';

it('drops project_url from populated databases without losing submissions or video relationships', async () => {
  const db = env.MIGRATION_DB;
  const index = env.TEST_MIGRATIONS.findIndex(
    (migration) => migration.name === '0004_remove_project_url.sql',
  );
  expect(index).toBeGreaterThan(0);
  await applyD1Migrations(db, env.TEST_MIGRATIONS.slice(0, index));
  await db.batch([
    db.prepare(
      "INSERT INTO users (id, email, display_name) VALUES ('owner', 'owner@sentry.io', 'Owner')",
    ),
    db.prepare(
      "INSERT INTO show_and_tell_events (id, title, created_by) VALUES ('event', 'Show & Tell', 'owner')",
    ),
    db.prepare(
      "INSERT INTO submissions (id, event_id, creator_id, title, description, project_url) VALUES ('submission', 'event', 'owner', 'Demo', 'Keep this description', 'https://example.com/obsolete')",
    ),
    db.prepare(`INSERT INTO video_uploads (id, video_id, submission_id, creator_id, r2_upload_id, original_r2_key, original_name, expected_size_bytes, part_size_bytes, status, expires_at, completed_at)
      VALUES ('upload', 'video', 'submission', 'owner', 'multipart', 'original.mp4', 'demo.mp4', 10, 52428800, 'completed', '2099-01-01', CURRENT_TIMESTAMP)`),
    db.prepare(
      "INSERT INTO video_upload_parts (upload_id, part_number, etag, size_bytes) VALUES ('upload', 1, 'etag', 10)",
    ),
    db.prepare(`INSERT INTO video_submissions (id, submission_id, original_name, size_bytes, original_r2_key, status)
      VALUES ('video', 'submission', 'demo.mp4', 10, 'original.mp4', 'queued')`),
    db.prepare(
      "INSERT INTO video_processing_attempts (video_id, attempt, status) VALUES ('video', 1, 'queued')",
    ),
  ]);

  await applyD1Migrations(db, env.TEST_MIGRATIONS);

  const columns = await db
    .prepare('PRAGMA table_info(submissions)')
    .all<{name: string}>();
  expect(columns.results.map((column) => column.name)).not.toContain('project_url');
  expect(
    await db
      .prepare("SELECT id, title, description FROM submissions WHERE id = 'submission'")
      .first(),
  ).toEqual({id: 'submission', title: 'Demo', description: 'Keep this description'});
  expect(
    await db
      .prepare(
        "SELECT submission_id, original_r2_key FROM video_submissions WHERE id = 'video'",
      )
      .first(),
  ).toEqual({submission_id: 'submission', original_r2_key: 'original.mp4'});
  expect(
    await db
      .prepare("SELECT etag FROM video_upload_parts WHERE upload_id = 'upload'")
      .first(),
  ).toEqual({etag: 'etag'});
  expect((await db.prepare('PRAGMA foreign_key_check').all()).results).toEqual([]);

  // Existing video-retirement triggers must still work after DROP COLUMN.
  await db
    .prepare(
      "UPDATE submissions SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'submission'",
    )
    .run();
  expect(
    await db.prepare("SELECT status FROM video_submissions WHERE id = 'video'").first(),
  ).toEqual({status: 'retired'});
  expect(
    await db
      .prepare("SELECT status FROM video_processing_attempts WHERE video_id = 'video'")
      .first(),
  ).toEqual({status: 'cancelled'});
});
