import {Hono} from 'hono';
import {bodyLimit} from 'hono/body-limit';
import {isJsonObject, isJsonString} from '../../shared/json';
import {sendTestEmail} from '../services/test-email';
import type {WorkerEnv} from '../index';
import {requireRole} from '../middleware/user';
import {eventSlug, submissionPath} from '../../shared/playlist';
import type {ShowReminder, ShowRemindersResponse} from '../../shared/reminders';
import {reminderOrigin} from '../services/show-reminders';

import {
  renderEmail,
  InvalidMeetingUrlError,
  type EmailShow,
} from '../../shared/email-template';

export const reminderRoutes = new Hono<WorkerEnv>();
reminderRoutes.use('*', requireRole('admin'), async (c, next) => {
  c.header('Cache-Control', 'private, no-store');
  await next();
});

reminderRoutes.post('/test-email', bodyLimit({maxSize: 1024}), async (c) => {
  const input: unknown = await c.req.json().catch(() => null);
  if (
    !isJsonObject(input) ||
    !isJsonString(input.eventId) ||
    !isJsonString(input.requestId) ||
    !/^[a-f0-9-]{36}$/.test(input.requestId) ||
    Object.keys(input).some((key) => !['eventId', 'requestId'].includes(key))
  )
    return c.json(
      {
        error: {
          message:
            'Provide a show and test request ID only. Recipient overrides are not supported.',
        },
      },
      400,
    );

  const user = c.get('user');
  if (
    !/^[a-z0-9.!#$%&'*+/=?^_`{|}~-]+@sentry\.io$/i.test(user.email) ||
    user.email.toLowerCase() === 'team@sentry.io'
  )
    return c.json(
      {error: {message: 'Use your individual Sentry account for test mail.'}},
      403,
    );
  if (!c.env.SHOW_EMAIL || !c.env.SHOW_EMAIL_FROM)
    return c.json({error: {message: 'Email binding or sender is not configured.'}}, 503);

  const show = await c.env.DB.prepare(
    'SELECT id,title,slug,starts_at,meeting_url FROM show_and_tell_events WHERE id=? AND starts_at IS NOT NULL',
  )
    .bind(input.eventId)
    .first<EmailShow>();
  if (!show) return c.json({error: {message: 'Planned show not found.'}}, 404);
  let email;
  try {
    email = renderEmail(show, reminderOrigin(c.env.APP_ORIGIN));
  } catch (error) {
    return c.json(
      {
        error: {
          message:
            error instanceof InvalidMeetingUrlError
              ? error.message
              : 'Check the show date and HTTPS APP_ORIGIN.',
        },
      },
      400,
    );
  }
  const result = await sendTestEmail(c.env, user, input.requestId, email);
  if (result.status === 'rate_limited') {
    c.header('Retry-After', '60');
    return c.json({error: {message: 'Wait one minute between test emails.'}}, 429);
  }
  return c.json(result);
});

interface ReminderRow {
  id: string;
  title: string;
  slug: string;
  starts_at: string | null;
  reminder_at: string;
  timezone: string;
  meeting_url: string | null;
  cancelled_at: string | null;
  channel: ShowReminder['channel'];
  status: ShowReminder['status'];
  attempted_at: string | null;
  completed_at: string | null;
}

reminderRoutes.get('/', async (c) => {
  const offsetParam = c.req.query('offset') ?? '0';
  if (!/^\d{1,6}$/.test(offsetParam))
    return c.json({error: {message: 'Use a non-negative offset up to 999999'}}, 400);
  const offset = Number(offsetParam);
  const now = new Date();
  const timestamp = now.toISOString();
  const stale = new Date(now.getTime() - 86400000).toISOString();
  const enabled = c.env.SHOW_REMINDERS_ENABLED === 'true';
  const {results} =
    await c.env.DB.prepare(`SELECT e.id, e.title, e.slug, e.starts_at, e.reminder_at, e.timezone, e.meeting_url, e.cancelled_at,
      r.channel, r.status, r.attempted_at, r.completed_at
    FROM show_reminders r JOIN show_and_tell_events e ON e.id = r.event_id
    WHERE r.channel = 'email'
    ORDER BY CASE WHEN r.status = 'pending' AND e.cancelled_at IS NULL AND e.starts_at > ? AND e.reminder_at >= ? THEN 0 ELSE 1 END,
      e.reminder_at, e.id, r.channel LIMIT 51 OFFSET ?`)
      .bind(timestamp, stale, offset)
      .all<ReminderRow>();
  let origin: string | null = null;
  try {
    origin = reminderOrigin(c.env.APP_ORIGIN);
  } catch {
    /* Show configuration blocker without leaking the value. */
  }
  const reminders = results.slice(0, 50).map((row): ShowReminder => {
    const blockedReasons: string[] = [];
    if (!enabled) blockedReasons.push('Automatic reminders are disabled.');
    const startsAt = row.starts_at ? Date.parse(row.starts_at) : NaN;
    const hasStart = Number.isFinite(startsAt);
    if (!hasStart) blockedReasons.push('Set a valid show start date.');
    if (row.cancelled_at) blockedReasons.push('This show was canceled.');
    else if (hasStart && startsAt <= now.getTime())
      blockedReasons.push('This show has already started.');
    else if (row.reminder_at < stale && row.status === 'pending')
      blockedReasons.push('The 24-hour catch-up window has expired.');
    if (!origin) blockedReasons.push('Configure an HTTPS APP_ORIGIN.');
    if (!c.env.SHOW_EMAIL || !c.env.SHOW_EMAIL_FROM)
      blockedReasons.push('Email binding or sender is not configured.');
    let message: string | null = null;
    let subject: string | null = null;
    let html: string | null = null;
    if (origin && hasStart && row.starts_at !== null) {
      try {
        const email = renderEmail({...row, starts_at: row.starts_at}, origin);
        message = email.text;
        subject = email.subject;
        html = email.html;
      } catch (error) {
        blockedReasons.push(
          error instanceof InvalidMeetingUrlError
            ? error.message
            : 'The show date or timezone needs correction.',
        );
      }
    }
    return {
      eventId: row.id,
      eventTitle: row.title,
      channel: row.channel,
      status: row.status,
      scheduledAt: row.reminder_at,
      timezone: row.timezone,
      destination: 'team@sentry.io',
      blockedReasons,
      subject,
      html,
      message,
      submissionUrl: origin
        ? new URL(submissionPath(row.id, row.slug || eventSlug(row.title)), origin).href
        : null,
      attemptedAt: row.attempted_at,
      completedAt: row.completed_at,
    };
  });
  return c.json({
    enabled,
    reminders,
    nextOffset: results.length > 50 ? offset + 50 : null,
  } satisfies ShowRemindersResponse);
});
