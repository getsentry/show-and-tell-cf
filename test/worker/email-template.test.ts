import {env} from 'cloudflare:test';
import {beforeEach, expect, it, vi} from 'vitest';
import {app} from '../../src/worker';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';
import {defaultEmailTemplate, type EmailPreview} from '../../src/shared/email-template';
import type {ShowRemindersResponse} from '../../src/shared/reminders';
import {processShowReminders} from '../../src/worker/services/show-reminders';

const origin = 'https://showntell.test';
let cookie: string;
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM show_and_tell_events'),
    env.DB.prepare('DELETE FROM show_email_templates'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  const admin = await synchronizeGoogleUser(env.DB, {
    subject: 'admin',
    email: 'admin@sentry.io',
    displayName: 'Admin',
    avatarUrl: null,
  });
  await env.DB.prepare('UPDATE users SET is_admin=1 WHERE id=?').bind(admin.id).run();
  const session = await createSession(env.DB, admin.id);
  cookie = `${SESSION_COOKIE_NAME}=${session.token}`;
  await env.DB.prepare(`INSERT INTO show_and_tell_events (id,title,created_by,slug,is_hidden,starts_at,reminder_at,timezone)
    VALUES ('show', 'October Show', ?, 'october-show', 1, '2099-10-08T16:00:00.000Z', '2099-10-01T16:00:00.000Z', 'America/Los_Angeles')`)
    .bind(admin.id)
    .run();
});
function request(
  path = '',
  method = 'GET',
  body?: string,
  session = cookie,
  requestOrigin = origin,
) {
  return app.request(
    `${origin}/api/admin/email-template${path}`,
    {
      method,
      headers: {
        Cookie: session,
        Origin: requestOrigin,
        'Content-Type': 'application/json',
      },
      body,
    },
    env,
  );
}
it('requires admin view for read, save and preview and rejects cross-origin writes', async () => {
  const body = JSON.stringify({
    revision: 0,
    template: defaultEmailTemplate,
    eventId: 'show',
  });
  expect((await request('', 'GET', undefined, '')).status).toBe(401);
  expect((await request('', 'PUT', body, cookie, 'https://evil.test')).status).toBe(403);
  await app.request(
    `${origin}/api/session/view-mode`,
    {
      method: 'POST',
      headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'},
      body: JSON.stringify({mode: 'member'}),
    },
    env,
  );
  for (const [path, method] of [
    ['', 'GET'],
    ['', 'PUT'],
    ['/preview', 'POST'],
  ]) {
    expect(
      (await request(path, method, method === 'GET' ? undefined : body)).status,
    ).toBe(403);
  }
});
it('versioned saves persist, record the actor, and prevent stale overwrites without scheduling or sending', async () => {
  const first = await request();
  expect(first.headers.get('Cache-Control')).toBe('private, no-store');
  expect(await first.json()).toEqual({revision: 0, template: defaultEmailTemplate});
  const template = {...defaultEmailTemplate, headline: 'Ship it. Show it.'};
  const body = JSON.stringify({revision: 0, template});
  const responses = await Promise.all([
    request('', 'PUT', body),
    request('', 'PUT', body),
  ]);
  expect(responses.map((response) => response.status).sort((a, b) => a - b)).toEqual([
    200, 409,
  ]);
  expect(await (await request()).json()).toEqual({revision: 1, template});
  expect(
    await env.DB.prepare(
      'SELECT count(*) AS count FROM show_email_templates WHERE updated_by IS NOT NULL',
    ).first(),
  ).toEqual({count: 1});
  expect(
    (await env.DB.prepare('SELECT status FROM show_reminders').all()).results,
  ).toEqual([{status: 'pending'}, {status: 'pending'}]);
});
it('previews unsaved copy without writes and delivery uses exactly the saved HTML and text', async () => {
  const template = {
    ...defaultEmailTemplate,
    headline: 'Demo time!',
    subject: 'Your demo: {{title}}',
  };
  const body = JSON.stringify({revision: 0, template, eventId: 'show'});
  const draft = await (await request('/preview', 'POST', body)).json<EmailPreview>();
  expect(draft.html).toContain('Demo time!');
  expect(
    await env.DB.prepare('SELECT count(*) AS count FROM show_email_templates').first(),
  ).toEqual({count: 0});
  await request('', 'PUT', body);
  const list = await app.request(
    `${origin}/api/admin/reminders`,
    {headers: {Cookie: cookie}},
    env,
  );
  const reminder = (await list.json<ShowRemindersResponse>()).reminders.find(
    (row) => row.channel === 'email',
  )!;
  expect(reminder.subject).toBe(draft.subject);
  expect(reminder.message).toBe(draft.text);
  expect(reminder.html).toBe(draft.html);
  const send = vi.fn(async () => ({messageId: 'email-id'}));
  await processShowReminders(
    {
      ...env,
      SHOW_REMINDERS_ENABLED: 'true',
      SHOW_EMAIL: {send},
      SHOW_EMAIL_FROM: 'sender@example.test',
    },
    new Date('2099-10-01T16:00:00.000Z'),
  );
  expect(send).toHaveBeenCalledExactlyOnceWith({
    from: 'sender@example.test',
    to: 'team@sentry.io',
    ...draft,
  });
  // Updating the shared template never resets an accepted delivery.
  await request('', 'PUT', JSON.stringify({revision: 1, template: defaultEmailTemplate}));
  await processShowReminders(
    {
      ...env,
      SHOW_REMINDERS_ENABLED: 'true',
      SHOW_EMAIL: {send},
      SHOW_EMAIL_FROM: 'sender@example.test',
    },
    new Date('2099-10-01T16:00:00.000Z'),
  );
  expect(send).toHaveBeenCalledTimes(1);
});
it('rejects malformed templates and missing shows without mutations', async () => {
  expect((await request('', 'PUT', '{')).status).toBe(400);
  expect(
    (
      await request(
        '',
        'PUT',
        JSON.stringify({
          revision: 0,
          template: {...defaultEmailTemplate, intro: '{{unknown}}'},
        }),
      )
    ).status,
  ).toBe(400);
  expect(
    (
      await request(
        '/preview',
        'POST',
        JSON.stringify({eventId: 'missing', template: defaultEmailTemplate}),
      )
    ).status,
  ).toBe(404);
  expect(
    await env.DB.prepare('SELECT count(*) AS count FROM show_email_templates').first(),
  ).toEqual({count: 0});
});

it('reads earlier saved drafts without retired deadline and closing fields', async () => {
  const legacy = {
    ...defaultEmailTemplate,
    headline: 'Less slide deck. More show & tell.',
    participation: 'Submit by {{deadline_times}}.',
    deadlineHoursBefore: 3,
    closing: 'TL;DR — again',
    questions: 'Ask the hosts.',
  };
  await env.DB.prepare(
    'INSERT INTO show_email_templates (revision,template_json,updated_by) VALUES (1,?,?)',
  )
    .bind(JSON.stringify(legacy), 'admin')
    .run();
  const saved = await (
    await request()
  ).json<{template: typeof defaultEmailTemplate; revision: number}>();
  expect(saved).toEqual({
    revision: 1,
    template: {...defaultEmailTemplate, questions: 'Ask the hosts.'},
  });
  const response = await request(
    '/preview',
    'POST',
    JSON.stringify({...saved, eventId: 'show'}),
  );
  expect(response.status).toBe(200);
  expect((await response.json<EmailPreview>()).text).not.toContain('TL;DR');
});

it('refreshes unchanged footer defaults while preserving custom template copy', async () => {
  const earlier = {
    ...defaultEmailTemplate,
    subject: '{{title}} — submissions are open',
    questions:
      'Questions? Jump into Slack #discuss-show-n-tell. More questions? Ask @jr or @sergical — we’ll help!',
    headline: 'Our custom headline',
  };
  await env.DB.prepare(
    'INSERT INTO show_email_templates (revision,template_json,updated_by) VALUES (1,?,?)',
  )
    .bind(JSON.stringify(earlier), 'admin')
    .run();
  const saved = await (await request()).json<{template: typeof defaultEmailTemplate}>();
  expect(saved.template).toEqual({
    ...defaultEmailTemplate,
    headline: 'Our custom headline',
  });
});
