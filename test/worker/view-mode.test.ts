import {env} from 'cloudflare:test';
import {beforeEach, expect, it} from 'vitest';
import {app} from '../../src/worker';
import type {JsonInput} from '../../src/shared/json';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';

const origin = 'https://showntell.test';
beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM show_and_tell_events'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

it('persists member view per session and enforces it on reads and mutations', async () => {
  const admin = await userCookie('admin', true);
  const otherSession = await createSession(env.DB, admin.id);
  const member = await userCookie('member');
  const created = await request('/api/events', admin.cookie, 'POST', {title: 'Show'});
  const {event} = await created.json<{event: {id: string}}>();
  const submitted = await request(
    `/api/events/${event.id}/submissions`,
    member.cookie,
    'POST',
    {title: 'Hidden demo'},
  );
  const {submission} = await submitted.json<{submission: {id: string}}>();
  const path = `/api/events/${event.id}/submissions/${submission.id}`;
  await request(`${path}/visibility`, admin.cookie, 'POST', {hidden: true});
  const own = await request(`/api/events/${event.id}/submissions`, admin.cookie, 'POST', {
    title: 'Own demo',
  });
  const {submission: ownSubmission} = await own.json<{submission: {id: string}}>();

  const switched = await request('/api/session/view-mode', admin.cookie, 'POST', {
    mode: 'member',
  });
  expect(switched.status).toBe(200);
  expect(await switched.json()).toMatchObject({
    user: {role: 'member', actualRole: 'admin'},
  });
  expect(await (await request('/api/session', admin.cookie)).json()).toMatchObject({
    user: {role: 'member', actualRole: 'admin'},
  });
  expect(await (await request('/api/events', admin.cookie)).json()).toMatchObject({
    events: [{submissionCount: 1}],
  });
  expect(
    await (await request(`/api/events/${event.id}`, admin.cookie)).json(),
  ).toMatchObject({submissions: [{id: ownSubmission.id}]});
  expect(
    (await request('/api/events', admin.cookie, 'POST', {title: 'Nope'})).status,
  ).toBe(403);
  expect(
    (await request(`${path}/visibility`, admin.cookie, 'POST', {hidden: false})).status,
  ).toBe(403);
  expect(
    (
      await request(`/api/events/${event.id}/order`, admin.cookie, 'PUT', {
        ids: [],
        expectedIds: [],
      })
    ).status,
  ).toBe(403);
  expect((await request(path, admin.cookie, 'DELETE')).status).toBe(404);
  expect(
    (await request(`/api/submissions/${submission.id}/video`, admin.cookie)).status,
  ).toBe(404);
  expect(
    (
      await request(
        `/api/events/${event.id}/submissions/${ownSubmission.id}`,
        admin.cookie,
        'DELETE',
      )
    ).status,
  ).toBe(204);
  expect(
    await (
      await request('/api/session', `${SESSION_COOKIE_NAME}=${otherSession.token}`)
    ).json(),
  ).toMatchObject({user: {role: 'admin'}});

  expect(
    (await request('/api/session/view-mode', admin.cookie, 'POST', {mode: 'admin'}))
      .status,
  ).toBe(200);
  expect(
    await (await request(`/api/events/${event.id}`, admin.cookie)).json(),
  ).toMatchObject({submissions: [{id: submission.id}]});
  expect(
    (await request('/api/events', admin.cookie, 'POST', {title: 'Allowed'})).status,
  ).toBe(201);
});

it('does not let members or demoted admins obtain admin access through view mode', async () => {
  const member = await userCookie('member');
  for (const mode of ['member', 'admin'])
    expect(
      (await request('/api/session/view-mode', member.cookie, 'POST', {mode})).status,
    ).toBe(403);
  const admin = await userCookie('admin', true);
  await request('/api/session/view-mode', admin.cookie, 'POST', {mode: 'member'});
  await env.DB.prepare('UPDATE users SET is_admin = 0 WHERE id = ?').bind(admin.id).run();
  expect(
    (await request('/api/session/view-mode', admin.cookie, 'POST', {mode: 'admin'}))
      .status,
  ).toBe(403);
  expect(await (await request('/api/session', admin.cookie)).json()).toMatchObject({
    user: {role: 'member', actualRole: 'member'},
  });
});

it('requires a live session, same-origin mutation and valid view mode', async () => {
  const admin = await userCookie('admin', true);
  expect(
    (await request('/api/session/view-mode', '', 'POST', {mode: 'admin'})).status,
  ).toBe(401);
  for (const body of [{mode: 'owner'}, {mode: true}, {}, null])
    expect(
      (await request('/api/session/view-mode', admin.cookie, 'POST', body)).status,
    ).toBe(400);
  const crossOrigin = await app.request(
    `${origin}/api/session/view-mode`,
    {
      method: 'POST',
      headers: {Cookie: admin.cookie, Origin: 'https://evil.test'},
      body: JSON.stringify({mode: 'member'}),
    },
    env,
  );
  expect(crossOrigin.status).toBe(403);
  const malformed = await app.request(
    `${origin}/api/session/view-mode`,
    {method: 'POST', headers: {Cookie: admin.cookie, Origin: origin}, body: '{'},
    env,
  );
  expect(malformed.status).toBe(400);
  expect(await (await request('/api/session', admin.cookie)).json()).toMatchObject({
    user: {role: 'admin'},
  });
  await env.DB.prepare('UPDATE user_sessions SET revoked_at = created_at').run();
  expect(
    (await request('/api/session/view-mode', admin.cookie, 'POST', {mode: 'member'}))
      .status,
  ).toBe(401);
});

async function userCookie(name: string, admin = false) {
  const user = await synchronizeGoogleUser(env.DB, {
    subject: name,
    email: `${name}@sentry.io`,
    displayName: name,
    avatarUrl: null,
  });
  if (admin)
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?')
      .bind(user.id)
      .run();
  const session = await createSession(env.DB, user.id);
  return {id: user.id, cookie: `${SESSION_COOKIE_NAME}=${session.token}`};
}
function request(path: string, cookie: string, method = 'GET', body?: JsonInput) {
  return app.request(
    `${origin}${path}`,
    {
      method,
      headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
