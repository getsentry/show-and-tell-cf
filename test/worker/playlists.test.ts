import {env} from 'cloudflare:test';
import {beforeEach, describe, expect, it} from 'vitest';
import {app} from '../../src/worker';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession, sha256Hex} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';
import type {PlaylistResponse} from '../../src/shared/playlist';
import type {EventResponse} from '../../src/shared/events';

const origin = 'https://showntell.test';
let admin: string;
let member: string;
beforeEach(async () => {
  await env.DB.batch(
    [
      'video_uploads',
      'video_submissions',
      'submissions',
      'show_and_tell_events',
      'user_sessions',
      'oauth_login_attempts',
      'users',
    ].map((table) => env.DB.prepare(`DELETE FROM ${table}`)),
  );
  const user = await synchronizeGoogleUser(env.DB, {
    subject: 'admin',
    email: 'admin@sentry.io',
    displayName: 'Admin',
    avatarUrl: null,
  });
  await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?').bind(user.id).run();
  admin = `${SESSION_COOKIE_NAME}=${(await createSession(env.DB, user.id)).token}`;
  const viewer = await synchronizeGoogleUser(env.DB, {
    subject: 'member',
    email: 'member@sentry.io',
    displayName: 'Member',
    avatarUrl: null,
  });
  member = `${SESSION_COOKIE_NAME}=${(await createSession(env.DB, viewer.id)).token}`;
  for (const id of ['event', 'other'])
    await env.DB.prepare(
      'INSERT INTO show_and_tell_events (id,title,created_by) VALUES (?, ?, ?)',
    )
      .bind(id, id, user.id)
      .run();
  for (const id of ['a', 'b', 'c']) {
    await env.DB.prepare(
      'INSERT INTO submissions (id,event_id,creator_id,title) VALUES (?, ?, ?, ?)',
    )
      .bind(id, 'event', user.id, id)
      .run();
    await env.DB.prepare(`INSERT INTO video_uploads
      (id,video_id,submission_id,creator_id,r2_upload_id,original_r2_key,original_name,expected_size_bytes,part_size_bytes,status,expires_at,completed_at)
      VALUES (?, ?, ?, ?, 'multipart', ?, 'demo.mp4', 10, 5242880, 'completed', '2099-01-01', CURRENT_TIMESTAMP)`)
      .bind(`upload-${id}`, `video-${id}`, id, user.id, `source-${id}`)
      .run();
    await env.DB.prepare(
      `INSERT INTO video_submissions (id,submission_id,original_name,size_bytes,original_r2_key,processed_r2_key,status,duration_seconds) VALUES (?, ?, 'demo.mp4', 10, ?, ?, 'ready', 12)`,
    )
      .bind(`video-${id}`, id, `source-${id}`, `output-${id}`)
      .run();
  }
});
function request(
  path: string,
  cookie = admin,
  method = 'GET',
  body?: {title?: string; expectedIds?: string[]; ids?: string[]},
) {
  return app.request(
    `${origin}/api/events${path && !path.startsWith('?') ? '/' : ''}${path}`,
    {
      method,
      headers: {Cookie: cookie, Origin: origin, 'Content-Type': 'application/json'},
      body: body === undefined ? undefined : JSON.stringify(body),
    },
    env,
  );
}
async function order(expectedIds: string[], ids: string[], cookie = admin) {
  return request('event/order', cookie, 'PUT', {expectedIds, ids});
}
async function ids() {
  const result = await (await request('event')).json<EventResponse>();
  return result.submissions.map((entry) => entry.id);
}

describe('playlist playback and ordering', () => {
  it('restricts trash and restore to admins, including member view and same-origin checks', async () => {
    for (const action of ['trash', 'restore']) {
      expect((await request(`event/${action}`, member, 'POST')).status).toBe(403);
      expect((await request(`event/${action}`, '', 'POST')).status).toBe(401);
      expect(
        (
          await app.request(
            `${origin}/api/events/event/${action}`,
            {
              method: 'POST',
              headers: {Cookie: admin, Origin: 'https://evil.test'},
            },
            env,
          )
        ).status,
      ).toBe(403);
    }
    expect((await request('?trash=true', member)).status).toBe(403);
    await app.request(
      `${origin}/api/session/view-mode`,
      {
        method: 'POST',
        headers: {Cookie: admin, Origin: origin, 'Content-Type': 'application/json'},
        body: JSON.stringify({mode: 'member'}),
      },
      env,
    );
    expect((await request('event/trash', admin, 'POST')).status).toBe(403);
    expect((await request('event/restore', admin, 'POST')).status).toBe(403);
    expect((await request('?trash=true', admin)).status).toBe(403);
  });

  it('trashes and restores populated playlists without changing submissions, uploads, or objects', async () => {
    await env.VIDEOS.put('source-a', 'original');
    await env.VIDEOS.put('output-a', 'processed');
    await env.DB.prepare(
      "UPDATE show_and_tell_events SET is_hidden = 1, slug = 'saved-slug' WHERE id = 'event'",
    ).run();
    await env.DB.prepare(
      "UPDATE submissions SET playlist_position = 9, is_hidden = 1 WHERE id = 'c'",
    ).run();
    const before = await Promise.all(
      ['submissions', 'video_uploads', 'video_submissions'].map(
        async (table) =>
          (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results,
      ),
    );
    expect((await request('event/trash', admin, 'POST')).status).toBe(204);
    for (const cookie of [admin, member]) {
      expect(await (await request('', cookie)).json()).toMatchObject({
        events: [{id: 'other'}],
      });
      for (const path of ['event', 'event/playlist', 'event/playlist/video-a/playback'])
        expect((await request(path, cookie)).status).toBe(404);
      expect(
        (await request('event/submissions', cookie, 'POST', {title: 'No'})).status,
      ).toBe(404);
      expect((await request('event/submissions/a', cookie, 'DELETE')).status).toBe(404);
      for (const path of [
        'submissions/a/video',
        'submissions/a/video/upload',
        'videos/video-a/playback',
        'videos/video-a/content',
      ])
        expect(
          (await app.request(`${origin}/api/${path}`, {headers: {Cookie: cookie}}, env))
            .status,
        ).toBe(404);
      expect(
        (
          await app.request(
            `${origin}/api/submissions/a/video/upload`,
            {
              method: 'POST',
              headers: {
                Cookie: cookie,
                Origin: origin,
                'Content-Type': 'application/json',
              },
              body: JSON.stringify({
                fileName: 'new.mp4',
                fileSize: 10,
                contentType: 'video/mp4',
              }),
            },
            env,
          )
        ).status,
      ).toBe(404);
    }
    expect((await order(['a', 'b', 'c'], ['c', 'b', 'a'])).status).toBe(404);
    expect(await (await request('?trash=true')).json()).toMatchObject({
      events: [{id: 'event', submissionCount: 3}],
    });
    expect((await request('event/trash', admin, 'POST')).status).toBe(404);
    expect((await request('missing/restore', admin, 'POST')).status).toBe(404);
    expect((await request('event/restore', admin, 'POST')).status).toBe(204);
    expect((await request('event/restore', admin, 'POST')).status).toBe(404);
    expect(await (await request('?trash=true')).json()).toEqual({events: []});
    expect(await (await request('event')).json()).toMatchObject({
      event: {hidden: true, slug: 'saved-slug', submissionCount: 3},
    });
    expect(await ids()).toEqual(['c', 'a', 'b']);
    expect((await request('event/playlist/video-a/playback', member)).status).toBe(200);
    expect(
      await Promise.all(
        ['submissions', 'video_uploads', 'video_submissions'].map(
          async (table) =>
            (await env.DB.prepare(`SELECT * FROM ${table} ORDER BY id`).all()).results,
        ),
      ),
    ).toEqual(before);
    expect(await (await env.VIDEOS.get('source-a'))?.text()).toBe('original');
    expect(await (await env.VIDEOS.get('output-a'))?.text()).toBe('processed');
  });

  it.each(['sending', 'uncertain'])(
    'blocks trash during %s reminder delivery',
    async (status) => {
      await env.DB.prepare(
        "INSERT INTO show_reminders (event_id, channel, status) VALUES ('event', 'email', ?)",
      )
        .bind(status)
        .run();
      expect((await request('event/trash', admin, 'POST')).status).toBe(409);
      expect((await request('event')).status).toBe(200);
    },
  );

  it('restores empty canceled playlists without uncanceling them', async () => {
    await env.DB.prepare(
      "UPDATE show_and_tell_events SET cancelled_at = CURRENT_TIMESTAMP WHERE id = 'other'",
    ).run();
    expect((await request('other/trash', admin, 'POST')).status).toBe(204);
    expect(await (await request('?trash=true')).json()).toMatchObject({
      events: [{id: 'other', submissionCount: 0}],
    });
    expect((await request('other/restore', admin, 'POST')).status).toBe(204);
    expect(await (await request('other')).json()).toMatchObject({
      event: {cancelledAt: expect.any(String)},
    });
    expect(await (await request('')).json()).toMatchObject({events: [{id: 'event'}]});
  });
  it('requires authentication and restricts ordering to admins with same-origin requests', async () => {
    expect((await request('event/playlist', '')).status).toBe(401);
    expect((await order(['a', 'b', 'c'], ['c', 'b', 'a'], member)).status).toBe(403);
    const response = await app.request(
      `${origin}/api/events/event/order`,
      {
        method: 'PUT',
        headers: {
          Cookie: admin,
          Origin: 'https://evil.test',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({expectedIds: ['a', 'b', 'c'], ids: ['c', 'b', 'a']}),
      },
      env,
    );
    expect(response.status).toBe(403);
    expect(await ids()).toEqual(['a', 'b', 'c']);
  });
  it('persists order atomically, includes hidden entries for editing, and rejects stale changes', async () => {
    await env.DB.prepare("UPDATE submissions SET is_hidden = 1 WHERE id = 'b'").run();
    expect((await order(['a', 'b', 'c'], ['c', 'b', 'a'])).status).toBe(204);
    expect(await ids()).toEqual(['c', 'b', 'a']);
    const memberDetail = await (await request('event', member)).json<EventResponse>();
    expect(memberDetail.submissions).toEqual([]);
    expect(memberDetail.event.submissionCount).toBe(0);
    const response = await request('event/playlist', member);
    expect(response.headers.get('Cache-Control')).toBe('private, no-store');
    expect(
      (await response.json<PlaylistResponse>()).items.map((item) => item.submissionId),
    ).toEqual(['c', 'a']);
    expect(
      (await (await request('event/playlist', admin)).json<PlaylistResponse>()).items.map(
        (item) => item.submissionId,
      ),
    ).toEqual(['c', 'a']);
    expect((await request('event/playlist/video-c/playback', member)).status).toBe(200);
    expect((await order(['c', 'b', 'a'], ['a', 'b', 'c'], member)).status).toBe(403);
    expect((await order(['a', 'b', 'c'], ['b', 'a', 'c'])).status).toBe(409);
    expect(await ids()).toEqual(['c', 'b', 'a']);
  });
  it('rejects duplicate, missing, foreign and deleted IDs without partial writes', async () => {
    expect((await order(['a', 'b', 'c'], ['a', 'a', 'c'])).status).toBe(400);
    expect((await order(['a', 'b'], ['b', 'a'])).status).toBe(409);
    expect((await order(['a', 'b', 'foreign'], ['foreign', 'a', 'b'])).status).toBe(409);
    await env.DB.prepare(
      "UPDATE submissions SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'b'",
    ).run();
    expect((await order(['a', 'b', 'c'], ['c', 'b', 'a'])).status).toBe(409);
    expect(await ids()).toEqual(['a', 'c']);
    expect(
      (await request('missing/order', admin, 'PUT', {expectedIds: ['a'], ids: ['a']}))
        .status,
    ).toBe(404);
  });
  it('allows only one winner for two concurrent reorders', async () => {
    const results = await Promise.all([
      order(['a', 'b', 'c'], ['b', 'c', 'a']),
      order(['a', 'b', 'c'], ['c', 'a', 'b']),
    ]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([204, 409]);
    expect([
      ['b', 'c', 'a'],
      ['c', 'a', 'b'],
    ]).toContainEqual(await ids());
  });
  it('appends new submissions after ordered entries and fences older snapshots', async () => {
    await order(['a', 'b', 'c'], ['c', 'a', 'b']);
    await request('event/submissions', member, 'POST', {title: 'New arrival'});
    expect((await ids()).slice(0, 3)).toEqual(['c', 'a', 'b']);
    expect((await order(['c', 'a', 'b'], ['a', 'c', 'b'])).status).toBe(409);
  });
  it('excludes hidden, deleted, failed, processing and retired videos even for admins', async () => {
    await env.DB.prepare("UPDATE submissions SET is_hidden = 1 WHERE id = 'a'").run();
    await env.DB.prepare(
      "UPDATE video_submissions SET status = 'processing' WHERE id = 'video-b'",
    ).run();
    await env.DB.prepare(
      "UPDATE submissions SET deleted_at = CURRENT_TIMESTAMP WHERE id = 'c'",
    ).run();
    expect(
      (await (await request('event/playlist')).json<PlaylistResponse>()).items,
    ).toEqual([]);
    await env.DB.prepare("UPDATE submissions SET is_hidden = 0 WHERE id = 'a'").run();
    await env.DB.prepare(
      "UPDATE video_submissions SET status = 'failed' WHERE id = 'video-a'",
    ).run();
    expect(
      (await (await request('event/playlist')).json<PlaylistResponse>()).items,
    ).toEqual([]);
    expect((await request('missing/playlist')).status).toBe(404);
  });
  it('revalidates preloaded video eligibility at every transition, including admin screenings', async () => {
    expect((await request('event/playlist/video-a/playback')).status).toBe(200);
    await env.DB.prepare("UPDATE submissions SET is_hidden = 1 WHERE id = 'a'").run();
    expect((await request('event/playlist/video-a/playback')).status).toBe(404);
    expect((await request('event/playlist/video-a/playback', member)).status).toBe(404);
    expect((await request('other/playlist/video-b/playback')).status).toBe(404);
    expect((await request('event/playlist/video-b/playback', '')).status).toBe(401);
  });
});

describe('canonical redirect and shared login destinations', () => {
  it('redirects the exact legacy hostname before authentication, preserving path and query', async () => {
    const response = await app.request(
      'https://showntell.sentry.new/playlists/event?view=screen&x=%2F',
      {},
      env,
    );
    expect(response.status).toBe(308);
    expect(response.headers.get('Location')).toBe(
      'https://showandtell.sentry.new/playlists/event?view=screen&x=%2F',
    );
    expect(response.headers.get('Set-Cookie')).toBeNull();
    const auth = await app.request('https://showntell.sentry.new/api/session', {}, env);
    expect(auth.status).toBe(308);
    expect(
      (await app.request('https://showandtell.sentry.new/api/health', {}, env)).status,
    ).toBe(200);
    expect(
      (
        await app.request('https://showntell.sentry.new.evil.test/api/health', {}, env)
      ).headers.get('Location'),
    ).toBeNull();
  });
  it.each([
    '/playlists/event',
    '/events/event',
    '/events/../api/auth/logout',
    '/events/%2f%2fevil.test',
    '/events/event?returnTo=https://evil.test',
    '//evil.test',
    'https://evil.test',
    '/\\evil.test',
    '/playlists/../api/auth/logout',
  ])(
    'stores only an allowlisted browser-bound OAuth destination: %s',
    async (returnTo) => {
      const response = await app.request(
        `${origin}/api/auth/login?returnTo=${encodeURIComponent(returnTo)}`,
        {},
        env,
      );
      const state = new URL(response.headers.get('Location')!).searchParams.get('state')!;
      const row = await env.DB.prepare(
        'SELECT return_to FROM oauth_login_attempts WHERE state_hash = ?',
      )
        .bind(await sha256Hex(state))
        .first<{return_to: string}>();
      expect(row?.return_to).toBe(
        ['/playlists/event', '/events/event'].includes(returnTo) ? returnTo : '/',
      );
      // D1's consumption trigger must preserve RETURNING for the destination too.
      const consumed = await env.DB.prepare(
        'UPDATE oauth_login_attempts SET consumed_at = created_at WHERE state_hash = ? RETURNING return_to',
      )
        .bind(await sha256Hex(state))
        .first<{return_to: string}>();
      expect(consumed?.return_to).toBe(row?.return_to);
    },
  );
});
