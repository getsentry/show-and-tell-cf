import {Hono} from 'hono';
import type {SessionResponse} from '../../shared/api';
import {isJsonObject, type JsonInput} from '../../shared/json';
import type {AuthBindings, AuthVariables} from '../middleware/auth';
interface SessionEnv {
  Bindings: AuthBindings & {DB: D1Database};
  Variables: AuthVariables;
}
export const sessionRoutes = new Hono<SessionEnv>();
sessionRoutes.get('/', (c) => c.json({user: c.get('user')} satisfies SessionResponse));

sessionRoutes.post('/view-mode', async (c) => {
  let input: JsonInput;
  try {
    input = await c.req.json();
  } catch {
    input = null;
  }
  if (!isJsonObject(input) || (input.mode !== 'admin' && input.mode !== 'member'))
    return c.json(
      {error: {code: 'VALIDATION_FAILED', message: 'View mode is invalid'}},
      400,
    );

  // Check the real role, not the effective member view, so admins can switch back.
  // Re-check in SQL too: a concurrent demotion must never restore admin access.
  const result = await c.env.DB.prepare(
    `UPDATE user_sessions SET view_as_member = ?
     WHERE token_hash = ? AND revoked_at IS NULL AND expires_at > ?
       AND EXISTS (SELECT 1 FROM users WHERE id = user_sessions.user_id AND is_admin = 1)`,
  )
    .bind(
      input.mode === 'member' ? 1 : 0,
      c.get('sessionTokenHash'),
      Math.floor(Date.now() / 1000),
    )
    .run();
  if (result.meta.changes !== 1)
    return c.json(
      {
        error: {
          code: 'AUTH_FORBIDDEN',
          message: 'Admin role is required to change view mode',
        },
      },
      403,
    );
  return c.json({user: {...c.get('user'), role: input.mode}} satisfies SessionResponse);
});
