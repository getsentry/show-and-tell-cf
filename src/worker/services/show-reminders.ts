import {renderEmail, type EmailShow} from '../../shared/email-template';

export interface ReminderEnv {
  DB: D1Database;
  APP_ORIGIN?: string;
  SHOW_REMINDERS_ENABLED?: string;
  SHOW_EMAIL_FROM?: string | {email: string; name: string};
  SHOW_EMAIL?: SendEmail;
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

/** At-most-one automatic attempt per email reminder. Uncertain acceptance requires operator review. */
export async function processShowReminders(env: ReminderEnv, now = new Date()) {
  if (env.SHOW_REMINDERS_ENABLED !== 'true') return;
  const origin = reminderOrigin(env.APP_ORIGIN);
  const timestamp = now.toISOString();
  const stale = new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`UPDATE show_reminders SET status = 'uncertain'
      WHERE channel = 'email' AND status = 'sending' AND attempted_at < ?`).bind(
      new Date(now.getTime() - 60 * 60 * 1000).toISOString(),
    ),
    env.DB.prepare(`UPDATE show_reminders SET status = 'skipped'
      WHERE channel = 'email' AND status = 'pending' AND event_id IN (
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
      AND r.channel = 'email' AND r.status = 'pending' ORDER BY e.reminder_at LIMIT 20`)
    .bind(timestamp, stale, timestamp)
    .all<{id: string}>();
  for (const {id} of results) {
    const channel = 'email';
    if (!env.SHOW_EMAIL || !env.SHOW_EMAIL_FROM) continue;
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
    let deliveryStarted = false;
    try {
      const show = await env.DB.prepare('SELECT * FROM show_and_tell_events WHERE id = ?')
        .bind(id)
        .first<EmailShow>();
      if (!show) throw new Error('Planned show missing');
      const email = renderEmail(show, origin);
      deliveryStarted = true;
      const result = await env.SHOW_EMAIL.send({
        from: env.SHOW_EMAIL_FROM,
        to: 'team@sentry.io',
        ...email,
      });
      providerId = result.messageId;
      status = 'sent';
    } catch {
      // Rendering failures cannot have reached a provider and are safe to retry
      // after correction. Once a provider call starts, preserve at-most-once safety.
      status = deliveryStarted ? 'uncertain' : 'failed';
      // Never log raw errors: they can contain sender details or message bodies.
      console.error(
        deliveryStarted
          ? 'show_reminder_delivery_uncertain'
          : 'show_reminder_render_failed',
        {eventId: id, channel},
      );
    }
    await env.DB.prepare(`UPDATE show_reminders SET status = ?, completed_at = ?, provider_id = ?
        WHERE event_id = ? AND channel = ? AND status IN ('sending', 'uncertain')`)
      .bind(status, timestamp, providerId, id, channel)
      .run();
    console.info('show_reminder_delivery', {eventId: id, channel, status});
  }
}
