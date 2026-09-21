import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';

import app from '../../src/worker';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';

const origin = 'https://showntell.test';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM show_and_tell_events'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM oauth_login_attempts'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

describe('events and submissions', () => {
  it('lets admins create events and members create durable submissions', async () => {
    const admin = await userCookie('admin', true);
    const member = await userCookie('member', false);

    const eventResponse = await request('/api/events', admin.cookie, 'POST', {
      title: 'October 2026',
      description: 'Monthly demos',
    });
    expect(eventResponse.status).toBe(201);
    const event = await eventResponse.json<{event: {id: string}}>();

    const submissionResponse = await request(
      `/api/events/${event.event.id}/submissions`,
      member.cookie,
      'POST',
      {
        title: 'New profiler',
        description: 'A reliable project record',
        projectUrl: 'https://github.com/getsentry/sentry',
      },
    );
    expect(submissionResponse.status).toBe(201);

    const detail = await app.request(
      `${origin}/api/events/${event.event.id}`,
      {
        headers: {Cookie: member.cookie},
      },
      env,
    );
    expect(await detail.json()).toMatchObject({
      event: {title: 'October 2026', submissionCount: 1},
      submissions: [{title: 'New profiler', creatorId: member.id}],
    });
  });

  it('enforces ownership for deletion and admin-only visibility', async () => {
    const admin = await userCookie('admin', true);
    const owner = await userCookie('owner', false);
    const other = await userCookie('other', false);
    const eventId = await createEvent(admin.cookie);
    const created = await request(
      `/api/events/${eventId}/submissions`,
      owner.cookie,
      'POST',
      {
        title: 'Demo',
        description: '',
        projectUrl: 'https://example.com/demo',
      },
    );
    const submission = await created.json<{submission: {id: string}}>();

    expect(
      (
        await request(
          `/api/events/${eventId}/submissions/${submission.submission.id}`,
          other.cookie,
          'DELETE',
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await request(
          `/api/events/${eventId}/submissions/${submission.submission.id}/visibility`,
          owner.cookie,
          'POST',
          {hidden: true},
        )
      ).status,
    ).toBe(403);
    expect(
      (
        await request(
          `/api/events/${eventId}/submissions/${submission.submission.id}/visibility`,
          admin.cookie,
          'POST',
          {hidden: true},
        )
      ).status,
    ).toBe(200);
    expect(
      (
        await request(
          `/api/events/${eventId}/submissions/${submission.submission.id}`,
          owner.cookie,
          'DELETE',
        )
      ).status,
    ).toBe(204);
  });
});

async function userCookie(name: string, admin: boolean) {
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
async function createEvent(cookie: string) {
  const response = await request('/api/events', cookie, 'POST', {
    title: 'Event',
    description: '',
  });
  return (await response.json<{event: {id: string}}>()).event.id;
}
interface RequestBody {
  [key: string]: string | boolean;
}
function request(path: string, cookie: string, method: string, body?: RequestBody) {
  const headers = new Headers({Cookie: cookie, Origin: origin});
  if (body) headers.set('Content-Type', 'application/json');
  return app.request(
    `${origin}${path}`,
    {method, headers, body: body ? JSON.stringify(body) : undefined},
    env,
  );
}
