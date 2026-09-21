import {env} from 'cloudflare:test';
import {Hono} from 'hono';
import {beforeEach, describe, expect, it} from 'vitest';

import app from '../../src/worker';
import type {AuthBindings, AuthVariables} from '../../src/worker/middleware/auth';
import {
  authenticateRequest,
  OAUTH_STATE_COOKIE_NAME,
  SESSION_COOKIE_NAME,
} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';

beforeEach(async () => {
  await env.DB.batch([
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM oauth_login_attempts'),
    env.DB.prepare('DELETE FROM users'),
  ]);
});

describe('authentication regressions', () => {
  it('binds OAuth state to the browser that started login', async () => {
    const login = await app.request('https://showntell.test/api/auth/login', {}, env);
    const authorization = new URL(login.headers.get('Location')!);
    const state = authorization.searchParams.get('state');
    const stateCookie = login.headers.get('Set-Cookie');

    expect(state).toHaveLength(43);
    expect(stateCookie).toContain(`${OAUTH_STATE_COOKIE_NAME}=${state}`);
    expect(stateCookie).toContain('HttpOnly');
    expect(stateCookie).toContain('Secure');
    expect(stateCookie).toContain('SameSite=Lax');

    const unboundCallback = await app.request(
      `https://showntell.test/api/auth/callback?code=attacker-code&state=${state}`,
      {},
      env,
    );
    expect(unboundCallback.headers.get('Location')).toBe('/?auth_error=failed');
    expect(unboundCallback.headers.get('Set-Cookie')).toContain(
      `${OAUTH_STATE_COOKIE_NAME}=; Max-Age=0`,
    );

    const wrongCookieCallback = await app.request(
      `https://showntell.test/api/auth/callback?code=attacker-code&state=${state}`,
      {headers: {Cookie: `${OAUTH_STATE_COOKIE_NAME}=wrong-browser-state`}},
      env,
    );
    expect(wrongCookieCallback.headers.get('Location')).toBe('/?auth_error=failed');
  });

  it('accepts a verified email change for an existing Google subject', async () => {
    const initial = await synchronizeGoogleUser(env.DB, {
      subject: 'google-user',
      email: 'old-name@sentry.io',
      displayName: 'Old Name',
      avatarUrl: null,
    });

    const updated = await synchronizeGoogleUser(env.DB, {
      subject: 'google-user',
      email: 'new-name@sentry.io',
      displayName: 'New Name',
      avatarUrl: null,
    });

    expect(updated).toMatchObject({id: initial.id, email: 'new-name@sentry.io'});
    expect(
      await env.DB.prepare('SELECT email FROM users WHERE id = ?')
        .bind(initial.id)
        .first(),
    ).toEqual({email: 'new-name@sentry.io'});
  });

  it('does not convert downstream route failures into authentication errors', async () => {
    const user = await synchronizeGoogleUser(env.DB, {
      subject: 'google-user',
      email: 'member@sentry.io',
      displayName: 'Member',
      avatarUrl: null,
    });
    const session = await createSession(env.DB, user.id);
    const app = new Hono<{
      Bindings: AuthBindings & {DB: D1Database};
      Variables: AuthVariables;
    }>();
    app.use('*', authenticateRequest());
    app.get('/failure', () => {
      throw new Error('route failed');
    });

    const response = await app.request(
      'https://showntell.test/failure',
      {headers: {Cookie: `${SESSION_COOKIE_NAME}=${session.token}`}},
      env,
    );

    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
  });
});
