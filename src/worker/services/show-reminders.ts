import {eventSlug, submissionPath} from '../../shared/playlist';

export interface ReminderEnv {
  DB: D1Database;
  APP_ORIGIN?: string;
  SHOW_REMINDERS_ENABLED?: string;
  SHOW_EMAIL_FROM?: string;
  SHOW_SLACK_WEBHOOK?: string;
  SHOW_SLACK_CHANNEL?: string;
  SHOW_EMAIL?: SendEmail;
}
interface PlannedShow {
  id: string;
  title: string;
  slug: string;
  starts_at: string;
  timezone: string;
  meeting_url: string | null;
}

export function reminderText(show: PlannedShow, origin: string) {
  const date = new Intl.DateTimeFormat('en-US', {
    dateStyle: 'full',
    timeStyle: 'short',
    timeZone: show.timezone,
  }).format(new Date(show.starts_at));
  const link = new URL(
    submissionPath(show.id, show.slug || eventSlug(show.title)),
    origin,
  ).href;
  return `${show.title}\n${date} (${show.timezone})\n\nHave something to demo? Add your submission and upload your video:\n${link}\n\nSentry login required.${show.meeting_url ? `\nJoin the show: ${show.meeting_url}` : ''}`;
}

export function reminderSubject(title: string) {
  return `Submit your demo: ${title}`;
}

export function reminderOrigin(value?: string) {
  if (!value || !URL.canParse(value)) throw new ReminderConfigurationError();
  const origin = new URL(value);
  if (origin.protocol !== 'https:' || origin.username || origin.password)
    throw new ReminderConfigurationError();
  return origin.origin;
}

// Fixed diagnostic only: never include configured URLs or provider errors.
export class ReminderConfigurationError extends Error {
  constructor() {
    super('Configure an HTTPS APP_ORIGIN before enabling reminders');
  }
}

/** At-most-one automatic attempt per channel. Uncertain acceptance requires operator review. */
export async function processShowReminders(env: ReminderEnv, now = new Date()) {
  if (env.SHOW_REMINDERS_ENABLED !== 'true') return;
  const origin = reminderOrigin(env.APP_ORIGIN);
  const timestamp = now.toISOString();
  const stale = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE show_reminders SET status = 'uncertain'
      WHERE status = 'sending' AND attempted_at < ?`).bind(
      new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    ),
    env.DB.prepare(`UPDATE show_reminders SET status = 'skipped'
      WHERE status = 'pending' AND event_id IN (
        SELECT id FROM show_and_tell_events WHERE cancelled_at IS NOT NULL OR starts_at <= ? OR reminder_at < ?
      )`).bind(timestamp, stale),
    env.DB.prepare(`UPDATE show_and_tell_events SET is_hidden = 0, revealed_at = CURRENT_TIMESTAMP, updated_at = CURRENT_TIMESTAMP
      WHERE cancelled_at IS NULL AND reminder_at <= ? AND starts_at > ? AND revealed_at IS NULL`).bind(
      timestamp,
      timestamp,
    ),
  ]);
  const {results} = await env.DB.prepare(`SELECT DISTINCT e.id FROM show_and_tell_events e
    JOIN show_reminders r ON r.event_id = e.id
    WHERE e.cancelled_at IS NULL AND e.reminder_at <= ? AND e.reminder_at >= ? AND e.starts_at > ?
      AND r.status = 'pending' ORDER BY e.reminder_at LIMIT 20`)
    .bind(timestamp, stale, timestamp)
    .all<{id: string}>();
  for (const {id} of results) {
    for (const channel of ['email', 'slack'] as const) {
      if (channel === 'email' && (!env.SHOW_EMAIL || !env.SHOW_EMAIL_FROM)) continue;
      if (channel === 'slack' && !validSlackWebhook(env.SHOW_SLACK_WEBHOOK)) continue;
      const claimed =
        await env.DB.prepare(`UPDATE show_reminders SET status = 'sending', attempted_at = ?
        WHERE event_id = ? AND channel = ? AND status = 'pending'
        AND EXISTS (SELECT 1 FROM show_and_tell_events WHERE id = ? AND cancelled_at IS NULL
          AND reminder_at <= ? AND reminder_at >= ? AND starts_at > ?)
        RETURNING event_id`)
          .bind(timestamp, id, channel, id, timestamp, stale, timestamp)
          .first();
      if (!claimed) continue;
      // The DB trigger now prevents date changes/cancellation until delivery is reconciled.
      let status: 'sent' | 'failed' | 'uncertain' = 'uncertain';
      let providerId: string | null = null;
      try {
        const show = await env.DB.prepare(
          'SELECT * FROM show_and_tell_events WHERE id = ?',
        )
          .bind(id)
          .first<PlannedShow>();
        if (!show) throw new Error('Planned show missing');
        const text = reminderText(show, origin);
        if (channel === 'email') {
          const result = await env.SHOW_EMAIL!.send({
            from: env.SHOW_EMAIL_FROM!,
            to: 'team@sentry.io',
            subject: reminderSubject(show.title),
            text,
          });
          providerId = result.messageId;
          status = 'sent';
        } else {
          const submissionUrl = new URL(
            submissionPath(show.id, show.slug || eventSlug(show.title)),
            origin,
          ).href;
          const response = await fetch(env.SHOW_SLACK_WEBHOOK!, {
            method: 'POST',
            headers: {'Content-Type': 'application/json'},
            // plain_text avoids treating a title as mentions or Slack markup.
            body: JSON.stringify({
              text: `Show & Tell submissions are open: ${submissionUrl}`,
              mrkdwn: false,
              blocks: [
                {type: 'section', text: {type: 'plain_text', text}},
                {
                  type: 'actions',
                  elements: [
                    {
                      type: 'button',
                      text: {type: 'plain_text', text: 'Submit your demo'},
                      url: submissionUrl,
                    },
                  ],
                },
              ],
            }),
            redirect: 'error',
            signal: AbortSignal.timeout(15000),
          });
          if (response.ok && (await response.text()).trim() === 'ok') status = 'sent';
          else if (response.status >= 400 && response.status < 500) status = 'failed';
        }
      } catch {
        // Never log provider errors: they can contain webhook secrets or message bodies.
        console.error('show_reminder_delivery_uncertain', {eventId: id, channel});
      }
      await env.DB.prepare(`UPDATE show_reminders SET status = ?, completed_at = ?, provider_id = ?
        WHERE event_id = ? AND channel = ? AND status IN ('sending', 'uncertain')`)
        .bind(status, timestamp, providerId, id, channel)
        .run();
      console.info('show_reminder_delivery', {eventId: id, channel, status});
    }
  }
}

export function validSlackWebhook(value?: string) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === 'https:' &&
      url.hostname === 'hooks.slack.com' &&
      !url.port &&
      !url.username &&
      !url.password &&
      !url.search &&
      !url.hash &&
      /^\/services\/[A-Za-z0-9/_-]+$/.test(url.pathname)
    );
  } catch {
    return false;
  }
}
