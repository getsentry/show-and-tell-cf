import {env} from 'cloudflare:test';
import {beforeEach, expect, it, vi} from 'vitest';
import {app} from '../../src/worker';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';
import {defaultEmailTemplate, renderEmail} from '../../src/shared/email-template';

const origin = 'https://showntell.test';
const send = vi.fn(async () => ({messageId: 'test-only'}));
let cookie: string;
let adminId: string;
const template = {...defaultEmailTemplate, headline: 'Unsaved draft'};
const payload = () => ({eventId: 'show', template, requestId: crypto.randomUUID()});
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM show_email_tests'),
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM show_and_tell_events'),
    env.DB.prepare('DELETE FROM show_email_templates'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  const admin = await synchronizeGoogleUser(env.DB, {
    subject: 'tester',
    email: 'tester@sentry.io',
    displayName: 'Tester',
    avatarUrl: null,
  });
  adminId = admin.id;
  await env.DB.prepare('UPDATE users SET is_admin=1 WHERE id=?').bind(admin.id).run();
  cookie = `${SESSION_COOKIE_NAME}=${(await createSession(env.DB, admin.id)).token}`;
  await env.DB.prepare(`INSERT INTO show_and_tell_events (id,title,created_by,slug,is_hidden,starts_at,reminder_at,timezone)
    VALUES ('show','October Show',?,'october',1,'2099-10-08T16:00:00.000Z','2099-10-01T16:00:00.000Z','America/Los_Angeles')`)
    .bind(admin.id)
    .run();
  send.mockReset().mockResolvedValue({messageId: 'test-only'});
});
function request(
  body = JSON.stringify(payload()),
  session = cookie,
  requestOrigin = origin,
  configured = true,
) {
  return app.request(
    `${origin}/api/admin/email-template/test`,
    {
      method: 'POST',
      headers: {
        Cookie: session,
        Origin: requestOrigin,
        'Content-Type': 'application/json',
      },
      body,
    },
    {
      ...env,
      SHOW_EMAIL: configured ? {send} : undefined,
      SHOW_EMAIL_FROM: configured ? 'sender@example.test' : undefined,
      SHOW_REMINDERS_ENABLED: 'false',
    },
  );
}
it('sends the unsaved rendered draft only to the authenticated admin, even with scheduling disabled', async () => {
  const response = await request();
  expect(response.status).toBe(200);
  expect(await response.json()).toEqual({status: 'sent', recipient: 'tester@sentry.io'});
  const email = renderEmail(
    template,
    {
      id: 'show',
      title: 'October Show',
      slug: 'october',
      starts_at: '2099-10-08T16:00:00.000Z',
      meeting_url: null,
    },
    origin,
  );
  expect(send).toHaveBeenCalledExactlyOnceWith({
    ...email,
    subject: `[TEST] ${email.subject}`,
    from: 'sender@example.test',
    to: 'tester@sentry.io',
  });
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS count FROM show_email_templates').first(),
  ).toEqual({count: 0});
  expect(
    (await env.DB.prepare('SELECT channel,status,attempted_at FROM show_reminders').all())
      .results,
  ).toEqual([{channel: 'email', status: 'pending', attempted_at: null}]);
  expect(
    await env.DB.prepare(
      "SELECT is_hidden,revealed_at FROM show_and_tell_events WHERE id='show'",
    ).first(),
  ).toEqual({is_hidden: 1, revealed_at: null});
});
it('denies anonymous users, members, member view and cross-origin sends', async () => {
  expect((await request(undefined, '')).status).toBe(401);
  expect((await request(undefined, cookie, 'https://evil.test')).status).toBe(403);
  await app.request(
    `${origin}/api/session/view-mode`,
    {
      method: 'POST',
      headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({mode: 'member'}),
    },
    env,
  );
  expect((await request()).status).toBe(403);
  await env.DB.prepare('UPDATE users SET is_admin=0 WHERE id=?').bind(adminId).run();
  expect((await request()).status).toBe(403);
  expect(send).not.toHaveBeenCalled();
});
it('rejects address overrides, bad templates, unknown shows and oversized requests before claiming', async () => {
  for (const extra of [
    {to: 'team@sentry.io'},
    {recipient: 'other@sentry.io'},
    {bcc: 'other@example.com'},
    {from: 'fake@sentry.io'},
  ]) {
    expect((await request(JSON.stringify({...payload(), ...extra}))).status).toBe(400);
  }
  expect((await request('{')).status).toBe(400);
  expect((await request(JSON.stringify({...payload(), requestId: 'bad'}))).status).toBe(
    400,
  );
  expect(
    (
      await request(
        JSON.stringify({...payload(), template: {...template, intro: '{{unknown}}'}}),
      )
    ).status,
  ).toBe(400);
  expect((await request(JSON.stringify({...payload(), eventId: 'missing'}))).status).toBe(
    404,
  );
  expect((await request('x'.repeat(33000))).status).toBe(413);
  expect(send).not.toHaveBeenCalled();
  expect(
    await env.DB.prepare('SELECT COUNT(*) AS count FROM show_email_tests').first(),
  ).toEqual({count: 0});
});
it('rejects missing email configuration and never falls back to team mail', async () => {
  const response = await request(undefined, cookie, origin, false);
  expect(response.status).toBe(503);
  expect(await response.text()).toContain('binding');
  expect(send).not.toHaveBeenCalled();
});
it('claims once across concurrent duplicate requests and rate limits distinct attempts', async () => {
  const body = JSON.stringify(payload());
  const responses = await Promise.all([request(body), request(body)]);
  expect(responses.every((response) => response.status === 200)).toBe(true);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await request(body)).status).toBe(200);
  const throttled = await request();
  expect(throttled.status).toBe(429);
  expect(throttled.headers.get('Retry-After')).toBe('60');
  expect(send).toHaveBeenCalledTimes(1);
  await env.DB.prepare(
    'UPDATE show_email_tests SET attempted_at = attempted_at - 61000',
  ).run();
  await request(body);
  expect(send).toHaveBeenCalledTimes(1);
  expect((await request()).status).toBe(200);
  expect(send).toHaveBeenCalledTimes(2);
});
it('rate limits concurrent requests with different IDs', async () => {
  const responses = await Promise.all([request(), request()]);
  expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
    200, 429,
  ]);
  expect(send).toHaveBeenCalledTimes(1);
});
it('preserves uncertain acceptance without leaking provider errors or resending', async () => {
  send.mockRejectedValueOnce(new Error('SECRET provider detail'));
  const body = JSON.stringify(payload());
  const response = await request(body);
  const result = await response.text();
  expect(result).toContain('uncertain');
  expect(result).not.toContain('SECRET');
  await env.DB.prepare(
    'UPDATE show_email_tests SET attempted_at = attempted_at - 61000',
  ).run();
  await request(body);
  expect(send).toHaveBeenCalledTimes(1);
});
