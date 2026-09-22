import {env} from 'cloudflare:test';
import {afterEach, beforeEach, expect, it, vi} from 'vitest';
import {exportJWK, generateKeyPair, SignJWT} from 'jose';
import {app} from '../../src/worker';
import {OAUTH_STATE_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {sha256Hex} from '../../src/worker/services/sessions';

beforeEach(async () => {
  await env.DB.prepare('DELETE FROM oauth_login_attempts').run();
});
afterEach(() => vi.restoreAllMocks());

it('returns to the stored playlist after verified browser-bound login, ignoring callback returnTo tampering', async () => {
  const {publicKey, privateKey} = await generateKeyPair('RS256', {extractable: true});
  const jwk = await exportJWK(publicKey);
  const bindings = {
    ...env,
    GOOGLE_JWKS_JSON: JSON.stringify({keys: [{...jwk, kid: 'test-key', alg: 'RS256'}]}),
  };
  const login = await app.request(
    'https://showntell.test/api/auth/login?returnTo=%2Fplaylists%2Fevent',
    {},
    bindings,
  );
  const state = new URL(login.headers.get('Location')!).searchParams.get('state')!;
  const attempt = await env.DB.prepare(
    'SELECT nonce FROM oauth_login_attempts WHERE state_hash = ?',
  )
    .bind(await sha256Hex(state))
    .first<{nonce: string}>();
  const token = await new SignJWT({
    nonce: attempt!.nonce,
    email: 'playlist-login@sentry.io',
    email_verified: true,
    name: 'Test viewer',
  })
    .setProtectedHeader({alg: 'RS256', kid: 'test-key'})
    .setIssuer('https://accounts.google.com')
    .setAudience(env.GOOGLE_CLIENT_ID)
    .setSubject('playlist-login')
    .setIssuedAt()
    .setExpirationTime('5m')
    .sign(privateKey);
  const exchange = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
    new Response(JSON.stringify({id_token: token}), {
      headers: {'Content-Type': 'application/json'},
    }),
  );
  const result = await app.request(
    `https://showntell.test/api/auth/callback?code=test&state=${state}&returnTo=https://evil.test`,
    {
      headers: {Cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}`},
    },
    bindings,
  );
  expect(result.status).toBe(302);
  expect(result.headers.get('Location')).toBe('/playlists/event');
  expect(result.headers.get('Set-Cookie')).toContain('HttpOnly');
  expect(exchange).toHaveBeenCalledOnce();
  // Reusing the consumed state does not exchange another code or redirect back.
  const repeated = await app.request(
    `https://showntell.test/api/auth/callback?code=test&state=${state}`,
    {
      headers: {Cookie: `${OAUTH_STATE_COOKIE_NAME}=${state}`},
    },
    bindings,
  );
  expect(repeated.headers.get('Location')).toBe('/?auth_error=failed');
  expect(exchange).toHaveBeenCalledOnce();
});
