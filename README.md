# Show & Tell

Sentry's internal app for submitting demo videos and watching them together.
[Open Show & Tell](https://showandtell.sentry.new) and sign in with your Sentry Google account.

- Create a submission, upload a video, and share the submission or screening link.
- Admins manage shows and arrange the screening order.
- For scheduling shows and email reminders, see [Planned Shows](PLANNED_SHOWS.md).

## Local Development

Use the Node version pinned in [package.json](package.json), npm, and Docker for the
video processor.

```bash
npm ci
cp .dev.vars.example .dev.vars
```

Fill in `GOOGLE_CLIENT_ID` and `GOOGLE_CLIENT_SECRET` in `.dev.vars`. The OAuth client
must allow `http://localhost:5173/api/auth/callback` as a redirect URI. Never commit secrets.

```bash
npm run dev
```

Open <http://localhost:5173>. The dev command applies local database migrations before
starting the app.

## Checks

```bash
npm run verify
```

Runs type generation, typechecking, formatting, lint, tests (including the Docker video
processor), a production build, and a deployment dry run. It does not deploy or apply
production migrations. See [package.json](package.json) for individual commands.

## Find Your Way Around

The code is the source of truth for behavior and configuration:

- [src/app/](src/app/) — React UI and screening player.
- [src/worker/](src/worker/) — Hono API, authentication, reminders, and video workflows.
- [processor/](processor/) — FFmpeg video processing.
- [migrations/](migrations/) — D1 database schema changes.
- [wrangler.jsonc](wrangler.jsonc) / [wrangler.production.json](wrangler.production.json) — local and production Cloudflare configuration.
- [.github/workflows/test.yml](.github/workflows/test.yml) — CI checks.

Production runs on Cloudflare Workers with D1, private R2 storage, Workflows, and
Containers. Deployments use Workers Builds; `npm run deploy:production` applies remote
migrations before deploying, so it is not a local check.

[Worker error monitoring](https://sentry.sentry.io/organizations/sentry/issues/?project=4512146574475264)
is in Sentry; telemetry configuration lives in [src/worker/sentry.ts](src/worker/sentry.ts).
