import type {EmailPreview} from '../../shared/email-template';
import type {ReminderEnv} from './show-reminders';

export interface TestEmailResult {
  status: 'sending' | 'sent' | 'uncertain' | 'rate_limited';
  recipient: string;
}

/** Claim before contacting the provider. Replays never send twice, even after a timeout. */
export async function sendTestEmail(
  env: ReminderEnv,
  actor: {id: string; email: string},
  requestId: string,
  email: EmailPreview,
  now = Date.now(),
): Promise<TestEmailResult> {
  const previous = await env.DB.prepare(
    'SELECT status FROM show_email_tests WHERE user_id = ? AND request_id = ?',
  )
    .bind(actor.id, requestId)
    .first<{status: 'sending' | 'sent' | 'uncertain'}>();
  if (previous) return {status: previous.status, recipient: actor.email};
  // One attempt per admin per minute, persisted across Worker instances.
  const claim =
    await env.DB.prepare(`INSERT OR IGNORE INTO show_email_tests (user_id, request_id, status, attempted_at)
    SELECT ?, ?, 'sending', ? WHERE NOT EXISTS (
      SELECT 1 FROM show_email_tests WHERE user_id = ? AND attempted_at > ?
    ) RETURNING request_id`)
      .bind(actor.id, requestId, now, actor.id, now - 60000)
      .first();
  if (!claim) {
    const concurrent = await env.DB.prepare(
      'SELECT status FROM show_email_tests WHERE user_id = ? AND request_id = ?',
    )
      .bind(actor.id, requestId)
      .first<{status: 'sending' | 'sent' | 'uncertain'}>();
    return {status: concurrent?.status ?? 'rate_limited', recipient: actor.email};
  }
  let status: 'sent' | 'uncertain' = 'uncertain';
  try {
    await env.SHOW_EMAIL!.send({
      from: env.SHOW_EMAIL_FROM!,
      to: actor.email,
      ...email,
      subject: `[TEST] ${email.subject}`,
    });
    status = 'sent';
  } catch {
    // Errors may include sender details and provider acceptance is not always known.
    console.error('show_test_email_uncertain', {userId: actor.id, requestId});
  }
  await env.DB.prepare(
    'UPDATE show_email_tests SET status = ? WHERE user_id = ? AND request_id = ?',
  )
    .bind(status, actor.id, requestId)
    .run();
  return {status, recipient: actor.email};
}
