import {Hono} from 'hono';
import type {WorkerEnv} from '../index';
import {requireRole} from '../middleware/user';
import {eventSlug, submissionPath} from '../../shared/playlist';
import type {ShowReminder, ShowRemindersResponse} from '../../shared/reminders';
import {
  reminderOrigin,
  reminderSubject,
  reminderText,
  validSlackWebhook,
} from '../services/show-reminders';

export const reminderRoutes = new Hono<WorkerEnv>();
interface ReminderRow {
  id: string;
  title: string;
  slug: string;
  starts_at: string;
  reminder_at: string;
  timezone: string;
  meeting_url: string | null;
  cancelled_at: string | null;
  channel: ShowReminder['channel'];
  status: ShowReminder['status'];
  attempted_at: string | null;
  completed_at: string | null;
}

reminderRoutes.get('/', requireRole('admin'), async (c) => {
  c.header('Cache-Control', 'private, no-store');
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
  // This is a non-secret, operator-maintained channel label, never a webhook URL.
  const channelLabel = c.env.SHOW_SLACK_CHANNEL;
  const slackDestination =
    channelLabel && /^#[a-z0-9_-]{1,80}$/.test(channelLabel)
      ? channelLabel
      : 'Slack channel not labeled';
  const reminders = results.slice(0, 50).map((row): ShowReminder => {
    const blockedReasons: string[] = [];
    if (!enabled) blockedReasons.push('Automatic reminders are disabled.');
    if (row.cancelled_at) blockedReasons.push('This show was canceled.');
    else if (row.starts_at <= timestamp)
      blockedReasons.push('This show has already started.');
    else if (row.reminder_at < stale && row.status === 'pending')
      blockedReasons.push('The 24-hour catch-up window has expired.');
    if (!origin) blockedReasons.push('Configure an HTTPS APP_ORIGIN.');
    if (row.channel === 'email' && (!c.env.SHOW_EMAIL || !c.env.SHOW_EMAIL_FROM))
      blockedReasons.push('Email binding or sender is not configured.');
    if (row.channel === 'slack' && !validSlackWebhook(c.env.SHOW_SLACK_WEBHOOK))
      blockedReasons.push('Slack webhook is not configured.');
    let message: string | null = null;
    if (origin) {
      try {
        message = reminderText(row, origin);
      } catch {
        blockedReasons.push('The show date or timezone needs correction.');
      }
    }
    return {
      eventId: row.id,
      eventTitle: row.title,
      channel: row.channel,
      status: row.status,
      scheduledAt: row.reminder_at,
      timezone: row.timezone,
      destination: row.channel === 'email' ? 'team@sentry.io' : slackDestination,
      blockedReasons,
      subject: row.channel === 'email' ? reminderSubject(row.title) : null,
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
