import {Hono} from 'hono';
import {
  exchangeAuthorizationCode,
  googleAuthorizationUrl,
  verifyGoogleIdToken,
} from '../integrations/google-oauth';
import {
  assertRequestUsesConfiguredOrigin,
  AuthenticationError,
  clearOauthStateCookie,
  clearSessionCookie,
  oauthStateCookie,
  readAuthConfig,
  readOauthStateCookie,
  sessionCookie,
  type AuthBindings,
  type AuthVariables,
} from '../middleware/auth';
import {
  cleanupExpiredAuthRecords,
  createSession,
  randomBase64Url,
  revokeSessionByTokenHash,
  sha256Hex,
} from '../services/sessions';
import {synchronizeGoogleUser} from '../services/users';

const LOGIN_ATTEMPT_TTL_SECONDS = 600;
interface AuthEnv {
  Bindings: AuthBindings & {DB: D1Database};
  Variables: AuthVariables;
}
export const authRoutes = new Hono<AuthEnv>();
export const authenticatedAuthRoutes = new Hono<AuthEnv>();

authRoutes.get('/login', async (c) => {
  try {
    const config = readAuthConfig(c.env);
    assertRequestUsesConfiguredOrigin(c.req.raw, config);
    const now = Math.floor(Date.now() / 1000);
    const state = randomBase64Url(32);
    const nonce = randomBase64Url(32);
    const codeVerifier = randomBase64Url(64);
    const codeChallenge = await sha256Base64Url(codeVerifier);
    await cleanupExpiredAuthRecords(c.env.DB, now);
    await c.env.DB.prepare(
      `INSERT INTO oauth_login_attempts (state_hash, nonce, code_verifier, expires_at, created_at) VALUES (?, ?, ?, ?, ?)`,
    )
      .bind(
        await sha256Hex(state),
        nonce,
        codeVerifier,
        now + LOGIN_ATTEMPT_TTL_SECONDS,
        now,
      )
      .run();
    c.header('Set-Cookie', oauthStateCookie(state, config, LOGIN_ATTEMPT_TTL_SECONDS));
    return c.redirect(googleAuthorizationUrl(config, {state, nonce, codeChallenge}));
  } catch (error) {
    return failure(
      c,
      error instanceof Error ? error : new Error('Authentication failed'),
    );
  }
});

authRoutes.get('/callback', async (c) => {
  try {
    const config = readAuthConfig(c.env);
    assertRequestUsesConfiguredOrigin(c.req.raw, config);
    const state = c.req.query('state');
    const code = c.req.query('code');
    const browserState = readOauthStateCookie(c.req.header('Cookie'), config);
    c.header('Set-Cookie', clearOauthStateCookie(config));
    if (
      c.req.query('error') ||
      !state ||
      !code ||
      !browserState ||
      browserState !== state ||
      state.length > 1024 ||
      code.length > 4096
    )
      throw new AuthenticationError('AUTH_INVALID', 'Google authorization failed', 401);
    const now = Math.floor(Date.now() / 1000);
    const attempt = await c.env.DB.prepare(
      `UPDATE oauth_login_attempts SET consumed_at = ? WHERE state_hash = ? AND consumed_at IS NULL AND expires_at > ? RETURNING nonce, code_verifier`,
    )
      .bind(now, await sha256Hex(state), now)
      .first<{nonce: string; code_verifier: string}>();
    if (!attempt)
      throw new AuthenticationError(
        'AUTH_INVALID',
        'Login attempt is invalid, expired, or already used',
        401,
      );
    const idToken = await exchangeAuthorizationCode(
      c.env,
      config,
      code,
      attempt.code_verifier,
    );
    const identity = await verifyGoogleIdToken(c.env, config, idToken, attempt.nonce);
    const user = await synchronizeGoogleUser(c.env.DB, identity);
    const session = await createSession(c.env.DB, user.id, now);
    c.header('Set-Cookie', sessionCookie(session.token, config), {append: true});
    return c.redirect('/');
  } catch (error) {
    return failure(
      c,
      error instanceof Error ? error : new Error('Authentication failed'),
    );
  }
});

authenticatedAuthRoutes.post('/logout', async (c) => {
  const config = readAuthConfig(c.env);
  await revokeSessionByTokenHash(c.env.DB, c.get('sessionTokenHash'));
  c.header('Set-Cookie', clearSessionCookie(config));
  return c.redirect('/', 303);
});

function failure(c: {redirect(url: string): Response}, error: Error) {
  const reason =
    error instanceof AuthenticationError && error.code === 'AUTH_FORBIDDEN'
      ? 'forbidden'
      : 'failed';
  return c.redirect(`/?auth_error=${reason}`);
}
async function sha256Base64Url(value: string) {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  let binary = '';
  for (const byte of new Uint8Array(digest)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
