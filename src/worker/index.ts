import {
  captureException,
  instrumentWorkflowWithSentry,
  setUser,
  setAttribute,
  withSentry,
} from '@sentry/cloudflare';
import {Hono} from 'hono';
import {HTTPException} from 'hono/http-exception';
import {sentryOptions, type SentryEnv} from './sentry';
import {VideoProcessingWorkflow as ProcessingWorkflow} from './workflows/video-processing';
import {
  authenticateRequest,
  protectMutationOrigin,
  type AuthBindings,
  type AuthVariables,
} from './middleware/auth';
import {requireRole} from './middleware/user';
import {authenticatedAuthRoutes, authRoutes} from './routes/auth';
import {eventRoutes} from './routes/events';
import {playlistRoutes} from './routes/playlists';
import {sessionRoutes} from './routes/session';
import {reminderRoutes} from './routes/reminders';
import {submissionVideoRoutes, videosRoutes} from './routes/videos';
import {reapExpiredMultipartVideoUploads} from './services/videos';
import {
  processShowReminders,
  ReminderConfigurationError,
  type ReminderEnv,
} from './services/show-reminders';

// Required by the Containers SDK for the processor's scoped R2 outbound handler.
export {ContainerProxy} from '@cloudflare/containers';
export {VideoProcessorContainer} from './containers/video-processor';
// Keep explicit wrappers: production Wrangler builds the source entry directly.
export type VideoProcessingWorkflow = ProcessingWorkflow;
export const VideoProcessingWorkflow = instrumentWorkflowWithSentry(
  sentryOptions,
  ProcessingWorkflow,
);

export type WorkerEnv = {
  Bindings: Omit<Env, keyof ReminderEnv | keyof SentryEnv> &
    ReminderEnv &
    SentryEnv &
    AuthBindings & {ASSETS: Fetcher; DB: D1Database};
  Variables: AuthVariables;
};
export const app = new Hono<WorkerEnv>();
app.onError((error, c) => {
  // Hono turns exceptions into responses, so the outer Worker wrapper never sees them.
  if (error instanceof HTTPException) {
    if (error.status >= 500) captureException(error);
    return error.getResponse();
  }
  captureException(error);
  console.error(error);
  return c.text('Internal Server Error', 500);
});
// Canonicalize before auth or assets so cookies and Google callbacks use one host.
app.use('*', async (c, next) => {
  const url = new URL(c.req.url);
  if (url.hostname === 'showntell.sentry.new') {
    url.protocol = 'https:';
    url.host = 'showandtell.sentry.new';
    url.port = '';
    return c.redirect(url.toString(), 308);
  }
  await next();
});
app.get('/api/health', (c) => c.json({ok: true}));
app.route('/api/auth', authRoutes);
app.use('/api/*', authenticateRequest<WorkerEnv>());
app.use('/api/*', async (c, next) => {
  const user = c.get('user');
  setUser({id: user.id, email: user.email, username: user.displayName});
  setAttribute('user.role', user.role);
  await next();
});
app.use('/api/*', protectMutationOrigin<WorkerEnv>());
app.route('/api/auth', authenticatedAuthRoutes);
app.route('/api/session', sessionRoutes);
app.route('/api/admin/reminders', reminderRoutes);
app.route('/api/events', playlistRoutes);
app.route('/api/events', eventRoutes);
app.route('/api/submissions', submissionVideoRoutes);
app.route('/api/videos', videosRoutes);
app.get('/api/admin/session', requireRole('admin'), (c) => c.json({user: c.get('user')}));
app.all('*', (c) => c.env.ASSETS.fetch(c.req.raw));
export default withSentry(sentryOptions, {
  fetch: app.fetch,
  async scheduled(
    _event: ScheduledController,
    env: ReminderEnv & Pick<Env, 'VIDEOS'> & SentryEnv,
    _ctx: ExecutionContext,
  ) {
    const results = await Promise.allSettled([
      reapExpiredMultipartVideoUploads(env.DB, env.VIDEOS),
      processShowReminders(env),
    ]);
    const reminders = results[1];
    // Preserve the actionable, fixed configuration diagnostic without exposing
    // arbitrary provider errors. Cleanup has still run independently.
    if (
      reminders.status === 'rejected' &&
      reminders.reason instanceof ReminderConfigurationError
    )
      throw reminders.reason;
    if (results.some((result) => result.status === 'rejected'))
      throw new Error(
        'Scheduled maintenance or reminders failed; inspect delivery status',
      );
  },
});
