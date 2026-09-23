import {env} from 'cloudflare:test';
import {beforeEach, expect, it, vi} from 'vitest';
import {app} from '../../src/worker';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';
import type {ShowRemindersResponse} from '../../src/shared/reminders';
import {defaultEmailTemplate, renderEmail} from '../../src/shared/email-template';
import {reminderText} from '../../src/worker/services/show-reminders';

const origin = 'https://showntell.test';
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM show_and_tell_events'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});
async function user(name: string, admin = false) {
  const identity = await synchronizeGoogleUser(env.DB, {
    subject: name,
    email: `${name}@sentry.io`,
    displayName: name,
    avatarUrl: null,
  });
  if (admin)
    await env.DB.prepare('UPDATE users SET is_admin=1 WHERE id=?')
      .bind(identity.id)
      .run();
  const session = await createSession(env.DB, identity.id);
  return {id: identity.id, cookie: `${SESSION_COOKIE_NAME}=${session.token}`};
}
async function seed(actor: string, id = 'planned-show') {
  await env.DB.prepare(`INSERT INTO show_and_tell_events (id,title,created_by,slug,is_hidden,starts_at,reminder_at,timezone,meeting_url)
    VALUES (?, 'Special Show', ?, 'special-show', 1, '2099-10-08T16:00:00.000Z', '2099-10-01T16:00:00.000Z', 'America/Los_Angeles', 'https://meet.google.com/abc-defg-hij')`)
    .bind(id, actor)
    .run();
}
function get(cookie: string, query = '') {
  return app.request(
    `${origin}/api/admin/reminders${query}`,
    {headers: {Cookie: cookie}},
    env,
  );
}
it('requires an admin session and denies admins in member view', async () => {
  const admin = await user('admin', true);
  const member = await user('member');
  expect((await get('')).status).toBe(401);
  expect((await get(member.cookie)).status).toBe(403);
  expect((await get(admin.cookie)).status).toBe(200);
  await app.request(
    `${origin}/api/session/view-mode`,
    {
      method: 'POST',
      headers: {Cookie: admin.cookie, Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({mode: 'member'}),
    },
    env,
  );
  expect((await get(admin.cookie)).status).toBe(403);
});
it('returns exact previews, destinations, due time and status without sending or exposing credentials', async () => {
  const admin = await user('admin', true);
  await seed(admin.id);
  const send = vi.fn(async () => ({messageId: 'unused'}));
  const webhook = 'https://hooks.slack.com/services/test/test/SECRET';
  const response = await app.request(
    `${origin}/api/admin/reminders`,
    {headers: {Cookie: admin.cookie}},
    {
      ...env,
      SHOW_EMAIL: {send},
      SHOW_EMAIL_FROM: 'sender@example.test',
      SHOW_REMINDERS_ENABLED: 'true',
      SHOW_SLACK_WEBHOOK: webhook,
      SHOW_SLACK_CHANNEL: '#show-and-tell',
    },
  );
  expect(response.headers.get('Cache-Control')).toBe('private, no-store');
  const body = await response.json<ShowRemindersResponse>();
  expect(body.enabled).toBe(true);
  expect(body.reminders).toHaveLength(2);
  const [email, slack] = body.reminders;
  expect(email).toMatchObject({
    channel: 'email',
    status: 'pending',
    scheduledAt: '2099-10-01T16:00:00.000Z',
    timezone: 'America/Los_Angeles',
    destination: 'team@sentry.io',
    subject: 'Special Show — submissions are open',
    blockedReasons: [],
  });
  expect(slack).toMatchObject({
    channel: 'slack',
    destination: '#show-and-tell',
    subject: null,
    blockedReasons: [],
  });
  expect(email.message).toBe(
    renderEmail(
      defaultEmailTemplate,
      {
        id: 'planned-show',
        title: 'Special Show',
        slug: 'special-show',
        starts_at: '2099-10-08T16:00:00.000Z',
        meeting_url: 'https://meet.google.com/abc-defg-hij',
      },
      origin,
    ).text,
  );
  expect(email.html).toContain('Upload your demo');
  expect(slack.message).toBe(
    reminderText(
      {
        id: 'planned-show',
        title: 'Special Show',
        slug: 'special-show',
        starts_at: '2099-10-08T16:00:00.000Z',
        timezone: 'America/Los_Angeles',
        meeting_url: 'https://meet.google.com/abc-defg-hij',
      },
      origin,
    ),
  );
  expect(JSON.stringify(body)).not.toContain('SECRET');
  expect(JSON.stringify(body)).not.toContain('sender@example.test');
  expect(send).not.toHaveBeenCalled();
  expect(
    (await env.DB.prepare('SELECT status FROM show_reminders').all()).results,
  ).toEqual([{status: 'pending'}, {status: 'pending'}]);
});
it('shows disabled/unconfigured blockers and never returns a URL as a channel label', async () => {
  const admin = await user('admin', true);
  await seed(admin.id);
  const response = await app.request(
    `${origin}/api/admin/reminders`,
    {headers: {Cookie: admin.cookie}},
    {...env, SHOW_SLACK_CHANNEL: 'https://hooks.slack.com/services/SECRET'},
  );
  const body = await response.json<ShowRemindersResponse>();
  expect(body.enabled).toBe(false);
  expect(body.reminders[0].blockedReasons).toEqual([
    'Automatic reminders are disabled.',
    'Email binding or sender is not configured.',
  ]);
  expect(body.reminders[1]).toMatchObject({
    destination: 'Slack channel not labeled',
    blockedReasons: [
      'Automatic reminders are disabled.',
      'Slack webhook is not configured.',
    ],
  });
  expect(JSON.stringify(body)).not.toContain('SECRET');
});
it('paginates deterministically and rejects malformed offsets', async () => {
  const admin = await user('admin', true);
  for (let i = 0; i < 26; i++) await seed(admin.id, `show-${String(i).padStart(2, '0')}`);
  const first = await (await get(admin.cookie)).json<ShowRemindersResponse>();
  const second = await (
    await get(admin.cookie, '?offset=50')
  ).json<ShowRemindersResponse>();
  expect(first.reminders).toHaveLength(50);
  expect(first.nextOffset).toBe(50);
  expect(second.reminders).toHaveLength(2);
  expect(second.nextOffset).toBeNull();
  expect(
    new Set(
      [...first.reminders, ...second.reminders].map((r) => `${r.eventId}-${r.channel}`),
    ).size,
  ).toBe(52);
  for (const offset of ['-1', 'NaN', '1.2', '1000000'])
    expect((await get(admin.cookie, `?offset=${offset}`)).status).toBe(400);
});
it('identifies canceled plans and leaves delivery records untouched', async () => {
  const admin = await user('admin', true);
  await seed(admin.id);
  await env.DB.prepare(
    "UPDATE show_and_tell_events SET cancelled_at=CURRENT_TIMESTAMP WHERE id='planned-show'",
  ).run();
  const body = await (await get(admin.cookie)).json<ShowRemindersResponse>();
  expect(
    body.reminders.every((r) => r.blockedReasons.includes('This show was canceled.')),
  ).toBe(true);
  expect(body.reminders.every((r) => r.status === 'pending')).toBe(true);
});
