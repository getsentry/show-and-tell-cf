import {Hono} from 'hono';

import {isJsonObject, isJsonString} from '../../shared/json';
import type {JsonInput} from '../../shared/json';
import type {PlaylistItem, PlaylistResponse} from '../../shared/playlist';
import type {WorkerEnv} from '../index';
import {requireRole} from '../middleware/user';
import {issuePlayback} from '../services/videos';
import {eventSlug} from '../../shared/playlist';

export const playlistRoutes = new Hono<WorkerEnv>();

playlistRoutes.get('/:eventId/playlist', async (c) => {
  const event = await c.env.DB.prepare(
    'SELECT id, title, description, slug FROM show_and_tell_events WHERE id = ?',
  )
    .bind(c.req.param('eventId'))
    .first<PlaylistResponse['event']>();
  if (!event) return c.json({error: {message: 'Playlist not found'}}, 404);
  event.slug = event.slug || eventSlug(event.title);
  // A screening is identical for every viewer, including admins and uploaders.
  // Playback/content routes independently re-check authentication and visibility.
  const {results} = await c.env.DB.prepare(
    `SELECT s.id submissionId, v.id videoId, s.title, s.description,
       u.display_name creatorName, COALESCE(v.duration_seconds, 0) durationSeconds
     FROM submissions s JOIN users u ON u.id = s.creator_id
     JOIN video_submissions v ON v.submission_id = s.id
     WHERE s.event_id = ? AND s.deleted_at IS NULL AND s.is_hidden = 0
       AND v.status = 'ready' AND v.retired_at IS NULL AND v.processed_r2_key IS NOT NULL
     ORDER BY s.playlist_position, s.created_at, s.id`,
  )
    .bind(event.id)
    .all<PlaylistItem>();
  return c.json({event, items: results} satisfies PlaylistResponse, 200, {
    'Cache-Control': 'private, no-store',
  });
});

// Re-check screening eligibility before each transition, including for admins.
playlistRoutes.get('/:eventId/playlist/:videoId/playback', async (c) => {
  const row = await c.env.DB.prepare(
    `SELECT v.id FROM video_submissions v JOIN submissions s ON s.id = v.submission_id
     WHERE s.event_id = ? AND v.id = ? AND s.deleted_at IS NULL AND s.is_hidden = 0
       AND v.status = 'ready' AND v.retired_at IS NULL AND v.processed_r2_key IS NOT NULL`,
  )
    .bind(c.req.param('eventId'), c.req.param('videoId'))
    .first<{id: string}>();
  if (!row)
    return c.json(
      {
        error: {
          message: 'Video is no longer available in this playlist. Skip it or refresh.',
        },
      },
      404,
    );
  return c.json(await issuePlayback(c.env.DB, row.id), 200, {
    'Cache-Control': 'private, no-store',
  });
});

playlistRoutes.put('/:eventId/order', requireRole('admin'), async (c) => {
  let input: JsonInput;
  try {
    input = await c.req.json();
  } catch {
    input = null;
  }
  const ids = isJsonObject(input) ? input.ids : null;
  const expectedIds = isJsonObject(input) ? input.expectedIds : null;
  if (
    !isOrder(ids) ||
    !isOrder(expectedIds) ||
    ids.length !== expectedIds.length ||
    ids.some((id) => !expectedIds.includes(id))
  ) {
    return c.json(
      {error: {message: 'Provide the complete existing and desired submission order'}},
      400,
    );
  }
  const eventId = c.req.param('eventId');
  const event = await c.env.DB.prepare('SELECT id FROM show_and_tell_events WHERE id = ?')
    .bind(eventId)
    .first();
  if (!event) return c.json({error: {message: 'Playlist not found'}}, 404);
  // One statement: the materialized snapshot fences concurrent reorders, inserts,
  // and deletions. No partial updates or cross-event IDs, even under races.
  const result = await c.env.DB.prepare(
    `WITH current_order AS MATERIALIZED (
       SELECT COALESCE(json_group_array(id), '[]') ids FROM (
         SELECT id FROM submissions WHERE event_id = ? AND deleted_at IS NULL
         ORDER BY playlist_position, created_at, id
       )
     )
     UPDATE submissions SET playlist_position = (
       SELECT CAST(key AS INTEGER) FROM json_each(?) WHERE value = submissions.id
     ), updated_at = CURRENT_TIMESTAMP
     WHERE event_id = ? AND deleted_at IS NULL
       AND (SELECT ids FROM current_order) = ?
     RETURNING id`,
  )
    .bind(eventId, JSON.stringify(ids), eventId, JSON.stringify(expectedIds))
    .all<{id: string}>();
  if (result.results.length !== ids.length) {
    return c.json(
      {error: {message: 'Playlist changed. Refresh and try ordering again.'}},
      409,
    );
  }
  return c.body(null, 204);
});

function isOrder(value: JsonInput): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.length <= 1000 &&
    value.every((id) => isJsonString(id) && id.length > 0 && id.length <= 128) &&
    new Set(value).size === value.length
  );
}
