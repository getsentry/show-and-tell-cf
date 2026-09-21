import {Hono} from 'hono';
import type {SessionResponse} from '../../shared/api';
import type {AuthBindings, AuthVariables} from '../middleware/auth';
interface SessionEnv {
  Bindings: AuthBindings & {DB: D1Database};
  Variables: AuthVariables;
}
export const sessionRoutes = new Hono<SessionEnv>();
sessionRoutes.get('/', (c) => c.json({user: c.get('user')} satisfies SessionResponse));
