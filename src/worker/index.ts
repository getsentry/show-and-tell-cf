import {Hono} from 'hono';
import {
  authenticateRequest,
  protectMutationOrigin,
  type AuthBindings,
  type AuthVariables,
} from './middleware/auth';
import {requireRole} from './middleware/user';
import {authenticatedAuthRoutes, authRoutes} from './routes/auth';
import {eventRoutes} from './routes/events';
import {sessionRoutes} from './routes/session';

export type WorkerEnv = {
  Bindings: Env & AuthBindings & {ASSETS: Fetcher; DB: D1Database};
  Variables: AuthVariables;
};
const app = new Hono<WorkerEnv>();
app.get('/api/health', (c) => c.json({ok: true}));
app.route('/api/auth', authRoutes);
app.use('/api/*', authenticateRequest<WorkerEnv>());
app.use('/api/*', protectMutationOrigin<WorkerEnv>());
app.route('/api/auth', authenticatedAuthRoutes);
app.route('/api/session', sessionRoutes);
app.route('/api/events', eventRoutes);
app.get('/api/admin/session', requireRole('admin'), (c) => c.json({user: c.get('user')}));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export default app;
