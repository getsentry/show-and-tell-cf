import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';

import {app} from '../../src/worker';
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
  it('hides playlists from every overview but preserves authenticated direct URLs and submissions', async () => {
    const admin = await userCookie('admin', true);
    const member = await userCookie('member', false);
    const created = await request('/api/events', admin.cookie, 'POST', {
      title: 'Special Show',
      hidden: true,
      slug: 'October / special!',
    });
    const {event} = await created.json<{
      event: {id: string; slug: string; hidden: boolean};
    }>();
    expect(event).toMatchObject({slug: 'october-special', hidden: true});
    for (const cookie of [admin.cookie, member.cookie]) {
      expect(await (await request('/api/events', cookie, 'GET')).json()).toEqual({
        events: [],
      });
      expect((await request(`/api/events/${event.id}`, cookie, 'GET')).status).toBe(200);
      expect(
        (await request(`/api/events/${event.id}/playlist`, cookie, 'GET')).status,
      ).toBe(200);
    }
    expect(
      (
        await request(`/api/events/${event.id}/submissions`, member.cookie, 'POST', {
          title: 'Demo',
        })
      ).status,
    ).toBe(201);
    expect(
      (
        await request(`/api/events/${event.id}/visibility`, member.cookie, 'POST', {
          hidden: false,
        })
      ).status,
    ).toBe(403);
    expect(
      (
        await request(`/api/events/${event.id}/visibility`, admin.cookie, 'POST', {
          hidden: false,
        })
      ).status,
    ).toBe(200);
    expect(
      await (await request('/api/events', member.cookie, 'GET')).json(),
    ).toMatchObject({events: [{id: event.id, hidden: false}]});
    expect((await request(`/api/events/${event.id}`, '', 'GET')).status).toBe(401);
  });
  it('exposes cancellation on direct links without allowing a cancelled show to be revealed', async () => {
    const admin = await userCookie('admin', true);
    const member = await userCookie('member', false);
    const eventId = await createEvent(admin.cookie);
    const cancelledAt = '2030-09-01T00:00:00Z';
    await env.DB.prepare(
      'UPDATE show_and_tell_events SET plan_key = ?, plan_updated_by = ?, cancelled_at = ?, is_hidden = 1 WHERE id = ?',
    )
      .bind('cancelled-show', admin.id, cancelledAt, eventId)
      .run();
    for (const cookie of [admin.cookie, member.cookie]) {
      expect(
        await (await request(`/api/events/${eventId}`, cookie, 'GET')).json(),
      ).toMatchObject({event: {id: eventId, hidden: true, cancelledAt}});
      expect(await (await request('/api/events', cookie, 'GET')).json()).toEqual({
        events: [],
      });
    }
    expect(
      (
        await request(`/api/events/${eventId}/visibility`, admin.cookie, 'POST', {
          hidden: false,
        })
      ).status,
    ).toBe(404);
    expect(
      await env.DB.prepare(
        'SELECT is_hidden, cancelled_at FROM show_and_tell_events WHERE id = ?',
      )
        .bind(eventId)
        .first(),
    ).toEqual({is_hidden: 1, cancelled_at: cancelledAt});
  });
  it('rejects malformed visibility and slugs', async () => {
    const admin = await userCookie('admin', true);
    expect(
      (
        await request('/api/events', admin.cookie, 'POST', {
          title: 'Show',
          hidden: 'false',
        })
      ).status,
    ).toBe(400);
    expect(
      (
        await request('/api/events', admin.cookie, 'POST', {
          title: 'Show',
          slug: 'x'.repeat(121),
        })
      ).status,
    ).toBe(400);
  });
  it('includes the current creator avatar on create, detail and visibility responses', async () => {
    const admin = await userCookie('admin', true);
    const eventId = await createEvent(admin.cookie);
    await env.DB.prepare('UPDATE users SET avatar_url = ? WHERE id = ?')
      .bind('https://example.test/avatar.jpg', admin.id)
      .run();
    const created = await request(
      `/api/events/${eventId}/submissions`,
      admin.cookie,
      'POST',
      {title: 'Demo'},
    );
    const {submission} = await created.json<{
      submission: {id: string; creatorAvatarUrl: string | null};
    }>();
    expect(submission.creatorAvatarUrl).toBe('https://example.test/avatar.jpg');
    expect(
      await (await request(`/api/events/${eventId}`, admin.cookie, 'GET')).json(),
    ).toMatchObject({
      submissions: [{creatorAvatarUrl: 'https://example.test/avatar.jpg'}],
    });
    await env.DB.prepare('UPDATE users SET avatar_url = NULL WHERE id = ?')
      .bind(admin.id)
      .run();
    expect(
      await (
        await request(
          `/api/events/${eventId}/submissions/${submission.id}/visibility`,
          admin.cookie,
          'POST',
          {hidden: true},
        )
      ).json(),
    ).toMatchObject({submission: {creatorAvatarUrl: null}});
  });

  it('accepts only a title with no project link column or response field', async () => {
    const admin = await userCookie('admin', true);
    const eventResponse = await request('/api/events', admin.cookie, 'POST', {
      title: 'Show & Tell — October 2026',
    });
    const {event} = await eventResponse.json<{event: {id: string; description: null}}>();
    expect(event.description).toBeNull();
    const created = await request(
      `/api/events/${event.id}/submissions`,
      admin.cookie,
      'POST',
      {title: 'My demo'},
    );
    expect(created.status).toBe(201);
    const body = await created.json<{
      submission: {id: string; description: null; projectUrl?: string};
    }>();
    expect(body.submission.description).toBeNull();
    expect(body.submission).not.toHaveProperty('projectUrl');
    const detail = await request(`/api/events/${event.id}`, admin.cookie, 'GET');
    expect(await detail.json()).toMatchObject({
      submissions: [{id: body.submission.id, title: 'My demo'}],
    });
    const columns = await env.DB.prepare('PRAGMA table_info(submissions)').all<{
      name: string;
    }>();
    expect(columns.results.map((column) => column.name)).not.toContain('project_url');
  });

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
    const ownerList = await app.request(
      `${origin}/api/events`,
      {
        headers: {Cookie: owner.cookie},
      },
      env,
    );
    expect(await ownerList.json()).toMatchObject({
      events: [{id: eventId, submissionCount: 1}],
    });
    const ownerDetail = await app.request(
      `${origin}/api/events/${eventId}`,
      {
        headers: {Cookie: owner.cookie},
      },
      env,
    );
    expect(await ownerDetail.json()).toMatchObject({
      event: {submissionCount: 1},
      submissions: [{id: submission.submission.id, hidden: true}],
    });
    const otherList = await app.request(
      `${origin}/api/events`,
      {
        headers: {Cookie: other.cookie},
      },
      env,
    );
    expect(await otherList.json()).toMatchObject({
      events: [{id: eventId, submissionCount: 0}],
    });
    await expect(
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(owner.id).run(),
    ).rejects.toThrow();

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
