import {Hono, type Context} from 'hono';

import {
  isJsonBoolean,
  isJsonObject,
  isJsonString,
  type JsonInput,
} from '../../shared/json';
import type {
  EventResponse,
  EventsResponse,
  ShowAndTellEvent,
  Submission,
} from '../../shared/events';
import type {WorkerEnv} from '../index';
import {requireRole} from '../middleware/user';
import {eventSlug} from '../../shared/playlist';

export const eventRoutes = new Hono<WorkerEnv>();

eventRoutes.onError((error, c) => {
  if (error instanceof ValidationError) {
    return c.json({error: {code: 'VALIDATION_FAILED', message: error.message}}, 400);
  }
  throw error;
});

eventRoutes.get('/', async (c) => {
  const result = await c.env.DB.prepare(
    `SELECT e.id, e.title, e.description, e.created_at, e.slug, e.is_hidden, e.starts_at, e.timezone, e.meeting_url,
      COUNT(s.id) submission_count
     FROM show_and_tell_events e
     LEFT JOIN submissions s ON s.event_id = e.id AND s.deleted_at IS NULL
       AND (s.is_hidden = 0 OR ? = 'admin' OR s.creator_id = ?)
     WHERE e.is_hidden = 0 AND e.cancelled_at IS NULL
     GROUP BY e.id ORDER BY e.created_at DESC`,
  )
    .bind(c.get('user').role, c.get('user').id)
    .all<EventRow>();
  const response: EventsResponse = {events: result.results.map(toEvent)};
  return c.json(response);
});

eventRoutes.post('/', requireRole('admin'), async (c) => {
  const input = parseEvent(await readJson(c.req.raw));
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO show_and_tell_events (id, title, description, created_by, slug, is_hidden)
     VALUES (?, ?, ?, ?, ?, ?)`,
  )
    .bind(
      id,
      input.title,
      input.description,
      c.get('user').id,
      input.slug,
      input.hidden ? 1 : 0,
    )
    .run();
  return c.json(
    {event: await getEvent(c.env.DB, id, c.get('user').role, c.get('user').id)},
    201,
  );
});

eventRoutes.post('/:eventId/visibility', requireRole('admin'), async (c) => {
  const hidden = parseVisibility(await readJson(c.req.raw));
  const result = await c.env.DB.prepare(
    `UPDATE show_and_tell_events SET is_hidden = ?, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND cancelled_at IS NULL`,
  )
    .bind(hidden ? 1 : 0, c.req.param('eventId'))
    .run();
  if (!result.meta.changes) return notFound(c);
  return c.json({
    event: await getEvent(
      c.env.DB,
      c.req.param('eventId'),
      c.get('user').role,
      c.get('user').id,
    ),
  });
});

eventRoutes.get('/:eventId', async (c) => {
  const event = await getEvent(
    c.env.DB,
    c.req.param('eventId'),
    c.get('user').role,
    c.get('user').id,
  );
  if (!event) return notFound(c);
  const result = await c.env.DB.prepare(
    `SELECT s.id, s.event_id, s.creator_id, u.display_name creator_name, u.avatar_url creator_avatar_url,
      s.title, s.description, s.is_hidden, s.created_at
     FROM submissions s JOIN users u ON u.id = s.creator_id
     WHERE s.event_id = ? AND s.deleted_at IS NULL
       AND (s.is_hidden = 0 OR ? = 'admin' OR s.creator_id = ?)
     ORDER BY s.playlist_position, s.created_at, s.id`,
  )
    .bind(c.req.param('eventId'), c.get('user').role, c.get('user').id)
    .all<SubmissionRow>();
  const response: EventResponse = {event, submissions: result.results.map(toSubmission)};
  return c.json(response);
});

eventRoutes.post('/:eventId/submissions', async (c) => {
  const eventId = c.req.param('eventId');
  if (!(await getEvent(c.env.DB, eventId, c.get('user').role, c.get('user').id)))
    return notFound(c);
  const input = parseSubmission(await readJson(c.req.raw));
  const id = crypto.randomUUID();
  await c.env.DB.prepare(
    `INSERT INTO submissions
      (id, event_id, creator_id, title, description)
     VALUES (?, ?, ?, ?, ?)`,
  )
    .bind(id, eventId, c.get('user').id, input.title, input.description)
    .run();
  return c.json({submission: await getSubmission(c.env.DB, id)}, 201);
});

eventRoutes.delete('/:eventId/submissions/:submissionId', async (c) => {
  const user = c.get('user');
  const result = await c.env.DB.prepare(
    `UPDATE submissions SET deleted_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
     WHERE id = ? AND event_id = ? AND deleted_at IS NULL
       AND (creator_id = ? OR ? = 'admin')`,
  )
    .bind(c.req.param('submissionId'), c.req.param('eventId'), user.id, user.role)
    .run();
  // D1 includes the video-retirement trigger's updates in the change count.
  if (result.meta.changes < 1) return notFound(c);
  return c.body(null, 204);
});

eventRoutes.post(
  '/:eventId/submissions/:submissionId/visibility',
  requireRole('admin'),
  async (c) => {
    const hidden = parseVisibility(await readJson(c.req.raw));
    const result = await c.env.DB.prepare(
      `UPDATE submissions SET is_hidden = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND event_id = ? AND deleted_at IS NULL`,
    )
      .bind(hidden ? 1 : 0, c.req.param('submissionId'), c.req.param('eventId'))
      .run();
    if (result.meta.changes !== 1) return notFound(c);
    return c.json({
      submission: await getSubmission(c.env.DB, c.req.param('submissionId')),
    });
  },
);

interface EventRow {
  slug: string;
  is_hidden: number;
  starts_at: string | null;
  timezone: string | null;
  meeting_url: string | null;
  id: string;
  title: string;
  description: string | null;
  created_at: string;
  submission_count: number;
}
interface SubmissionRow {
  id: string;
  event_id: string;
  creator_id: string;
  creator_name: string;
  creator_avatar_url: string | null;
  title: string;
  description: string | null;
  is_hidden: number;
  created_at: string;
}

async function getEvent(db: D1Database, id: string, role: string, userId: string) {
  const row = await db
    .prepare(
      `SELECT e.id, e.title, e.description, e.created_at, e.slug, e.is_hidden, e.starts_at, e.timezone, e.meeting_url,
      COUNT(s.id) submission_count
     FROM show_and_tell_events e LEFT JOIN submissions s
       ON s.event_id = e.id AND s.deleted_at IS NULL
         AND (s.is_hidden = 0 OR ? = 'admin' OR s.creator_id = ?)
     WHERE e.id = ? GROUP BY e.id`,
    )
    .bind(role, userId, id)
    .first<EventRow>();
  return row ? toEvent(row) : null;
}

async function getSubmission(db: D1Database, id: string) {
  const row = await db
    .prepare(
      `SELECT s.id, s.event_id, s.creator_id, u.display_name creator_name, u.avatar_url creator_avatar_url,
      s.title, s.description, s.is_hidden, s.created_at
     FROM submissions s JOIN users u ON u.id = s.creator_id WHERE s.id = ?`,
    )
    .bind(id)
    .first<SubmissionRow>();
  if (!row) throw new Error('Submission disappeared');
  return toSubmission(row);
}

function toEvent(row: EventRow): ShowAndTellEvent {
  return {
    id: row.id,
    title: row.title,
    description: row.description,
    createdAt: row.created_at,
    submissionCount: row.submission_count,
    slug: row.slug || eventSlug(row.title),
    hidden: row.is_hidden === 1,
    startsAt: row.starts_at,
    timezone: row.timezone,
    meetingUrl: row.meeting_url,
  };
}
function toSubmission(row: SubmissionRow): Submission {
  return {
    id: row.id,
    eventId: row.event_id,
    creatorId: row.creator_id,
    creatorName: row.creator_name,
    creatorAvatarUrl: row.creator_avatar_url,
    title: row.title,
    description: row.description,
    hidden: row.is_hidden === 1,
    createdAt: row.created_at,
  };
}

async function readJson(request: Request): Promise<JsonInput> {
  try {
    return await request.json();
  } catch {
    throw new ValidationError('Request body must be JSON');
  }
}
function parseEvent(value: JsonInput) {
  if (!isJsonObject(value)) throw new ValidationError('Event must be an object');
  if (value.hidden !== undefined && !isJsonBoolean(value.hidden))
    throw new ValidationError('Hidden must be a boolean');
  const title = requiredText(value.title, 'Title', 120);
  return {
    title,
    description: optionalText(value.description, 'Description', 1000),
    slug: eventSlug(optionalText(value.slug, 'Slug', 120) || title),
    hidden: value.hidden === true,
  };
}
function parseSubmission(value: JsonInput) {
  if (!isJsonObject(value)) throw new ValidationError('Submission must be an object');
  return {
    title: requiredText(value.title, 'Title', 120),
    description: optionalText(value.description, 'Description', 1000),
  };
}
function parseVisibility(value: JsonInput) {
  if (!isJsonObject(value) || !isJsonBoolean(value.hidden))
    throw new ValidationError('Visibility is invalid');
  return value.hidden;
}
function requiredText(value: JsonInput, label: string, max: number) {
  if (!isJsonString(value)) throw new ValidationError(`${label} is required`);
  const text = value.trim();
  if (!text || text.length > max) throw new ValidationError(`${label} is invalid`);
  return text;
}
function optionalText(value: JsonInput, label: string, max: number) {
  if (value === null || value === undefined || value === '') return null;
  if (!isJsonString(value) || value.trim().length > max)
    throw new ValidationError(`${label} is invalid`);
  return value.trim() || null;
}
function notFound(c: Context<WorkerEnv>) {
  return c.json({error: {code: 'NOT_FOUND', message: 'Resource not found'}}, 404);
}
export class ValidationError extends Error {}
