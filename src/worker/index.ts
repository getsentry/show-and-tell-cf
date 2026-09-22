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
import {submissionVideoRoutes, videosRoutes} from './routes/videos';
import {reapExpiredMultipartVideoUploads} from './services/videos';

// Required by the Containers SDK for the processor's scoped R2 outbound handler.
export {ContainerProxy} from '@cloudflare/containers';
export {VideoProcessorContainer} from './containers/video-processor';
export {VideoProcessingWorkflow} from './workflows/video-processing';

export type WorkerEnv = {
  Bindings: Env & AuthBindings & {ASSETS: Fetcher; DB: D1Database};
  Variables: AuthVariables;
};
export const app = new Hono<WorkerEnv>();
app.get('/api/health', (c) => c.json({ok: true}));
app.route('/api/auth', authRoutes);
app.use('/api/*', authenticateRequest<WorkerEnv>());
app.use('/api/*', protectMutationOrigin<WorkerEnv>());
app.route('/api/auth', authenticatedAuthRoutes);
app.route('/api/session', sessionRoutes);
app.route('/api/events', eventRoutes);
app.route('/api/submissions', submissionVideoRoutes);
app.route('/api/videos', videosRoutes);
app.get('/api/admin/session', requireRole('admin'), (c) => c.json({user: c.get('user')}));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledController, env: Env) {
    await reapExpiredMultipartVideoUploads(env.DB, env.VIDEOS);
  },
};
