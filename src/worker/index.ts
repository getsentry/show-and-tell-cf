import {Hono} from 'hono';

interface WorkerBindings {
  ASSETS: Fetcher;
}

const app = new Hono<{Bindings: WorkerBindings}>();

app.get('/api/health', (context) => context.json({ok: true}));
app.all('*', (context) => context.env.ASSETS.fetch(context.req.raw));

export default app;
