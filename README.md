# Show & Tell

Sentry's internal Show & Tell video playlist application. The React application and Hono API are served by a single Cloudflare Worker.

## Requirements

- Node.js 24.11 or newer (Volta and CI pin 24.19)
- npm 11 or newer
- Docker (linux/amd64) for local Containers, pinned processor tests, and deployment dry runs

## Local development

```bash
npm ci
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars`, add the local Google OAuth client secret, and allow the exact callback `http://localhost:5173/api/auth/callback`. Then open `http://localhost:5173`. The Worker health endpoint is available at `/api/health`.

## Production

The canonical production origin is `https://showandtell.sentry.new`. Production deployments use [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) with `wrangler.production.json`. GitHub Actions verifies pull requests and `main` but does not deploy; no GitHub deployment environment or Cloudflare secrets in GitHub are required.

### Connect Workers Builds

The `show-and-tell-cf` Worker in Sentry Internal is connected to Workers Builds and serves the authenticated application. Video infrastructure has a separate approval gate below.

In **Workers & Pages → show-and-tell-cf → Settings → Builds**, connect `getsentry/show-and-tell-cf` through the Cloudflare GitHub app and configure:

- Production branch: `main`.
- Root directory: repository root.
- Build command: `npm run verify` (includes the production build and credential-free deployment dry run). Workers Builds installs dependencies automatically.
- Deploy command: `npm run deploy:production` (applies remote D1 migrations, then deploys only if migrations succeed).
- Build variable: `NODE_VERSION=24.19.0`.
- **Disable builds for non-production branches**. Do not run production migrations or deploy PR branches against the production database.
- Build API token: scoped to Sentry Internal (`20d94f53c7cab0b469521b703ff1923c`), with Workers deployment and **D1 edit** permission for migrations. The default Workers Builds token may need additional D1 permission.

Cloudflare runs verification itself before deployment; it does not wait for the separate GitHub Actions check. Keep the GitHub `Verify` check required for merging. Avoid overlapping production builds or manual deploys, especially when migrations change.

### Runtime configuration and first deployment

The D1 database ID and Google client ID are already configured in `wrangler.production.json`. In the Worker's **Settings → Variables & Secrets**, add `GOOGLE_CLIENT_SECRET` as an encrypted runtime secret, **not** a build variable. Never commit it. The Google OAuth web client must allow origin `https://showandtell.sentry.new` and callback `https://showandtell.sentry.new/api/auth/callback`.

The canonical domain and Google login have been verified. D1 is the role authority; promote initial admins after their first login with an explicitly approved `users.is_admin` update. Every Cloudflare write requires explicit approval, including resource provisioning and production migrations/deployment.

Configure `showntell.sentry.new` as a Cloudflare redirect to `https://showandtell.sentry.new`, preserving path and query string, rather than serving the application under both hostnames. OAuth callbacks, host-only cookies, and same-origin checks use only the canonical hostname. This redirect still needs to be provisioned in Cloudflare.

## Quality gates

```bash
npm run verify
npm audit --omit=dev --audit-level=high
```

The verification gate generates Cloudflare binding types, typechecks, checks formatting and lint, runs app/Worker tests, builds the pinned Docker processor and runs real FFmpeg regressions, builds the application, and performs a credential-free deployment dry run. No Cloudflare resources are created by verification.

Google OAuth uses Authorization Code with PKCE, state and nonce verification, exact verified `@sentry.io` enforcement, hashed opaque D1 sessions, and HttpOnly cookies. Authenticated mutations require the exact same-origin `Origin` header.

## Video pipeline (backend)

This PR ports Hack Week's private R2 multipart lifecycle, Workflow, and pinned FFmpeg 8.0.1 processor, without years, groups, voting, or team membership. The upload UI and playlist player are subsequent PRs. Create the submission first; failed uploads or processing never remove that record.

- One active video or upload per submission, enforced in D1. Only the owner or an admin can upload, abort, retry, or retire it.
- Maximum 5 GiB; 50 MiB streamed parts, 24-hour upload sessions, resumable via the stored part list. Completion validates every part and final object size, and is idempotent. Repeating completion or retrying a queued video recovers an interrupted Workflow handoff.
- Workflow attempt IDs and derivative keys are deterministic. Failed processing can be retried from the immutable original without reuploading. Stale attempts cannot publish over a replacement.
- Same Hack Week output contract: up to ten minutes (longer inputs are rejected, not trimmed), H.264/AAC MP4, yuv420p, max 1920×1080, fast-start, -16 LUFS ±0.7 LU, generated silence when required. Metadata and R2 SHA-256 are checked before publication.
- Containers run as a non-root user, without general internet access. Their only outbound route is attempt-scoped `video-r2` storage/progress. No public bucket, signed public URL, or processor HTTP endpoint is exposed by the Worker.
- Authenticated byte-range playback checks visibility on every request (`private, no-store`). Hidden entries are readable only by their owner/admin; deleted entries are unavailable to everyone. Deletion retires the video and cancels its processing attempt atomically.
- Hourly cleanup reaps up to 100 expired multipart sessions, including abandoned/deleted submissions. Originals and completed derivatives are retained privately after retirement; physical deletion/retention policy is deferred, not silently destructive.
- Application processing concurrency starts at one, with a two-container production ceiling to allow teardown overlap. Workflow execution failures are recorded in D1. A platform-terminated Workflow may require operator recovery; no claim of automatic recovery from all platform failures.

### API contract

All paths below start with `/api`; all writes require the same-origin `Origin` header and session cookie.

- `GET /submissions/:id/video`: current video, status, processing stage/percent, duration, failure message.
- `POST /submissions/:id/video/upload`: `{fileName, fileSize, contentType}` → `{upload, video}`.
- `GET /submissions/:id/video/upload/:uploadId`: resume metadata and completed parts.
- `PUT /submissions/:id/video/upload/:uploadId/parts/:partNumber`: raw bytes with exact `Content-Length` → `{part: {partNumber, etag, sizeBytes}}`.
- `POST /submissions/:id/video/upload/:uploadId/complete`: `{parts: [{partNumber, etag}]}` → `{video}`.
- `DELETE /submissions/:id/video/upload/:uploadId`: abort an unfinished upload.
- `POST /submissions/:id/video/retry`: retry failed processing / queued Workflow handoff.
- `DELETE /submissions/:id/video`: `{confirmed: true}` retires the video without deleting the submission or original bytes.
- `GET /videos/:videoId/playback`: authenticated MP4 descriptor.
- `GET /videos/:videoId/content`: full or single-range canonical MP4.

### Approval gate before merging/deploying video support

**Do not merge until resource creation and this production deployment are explicitly approved.** Main automatically deploys. This branch does not provision anything by itself.

1. Approve and create the private R2 bucket `show-and-tell-videos-production` in Sentry Internal. Keep public access disabled; same-origin Worker uploads do not need R2 CORS or S3 credentials.
2. Verify the Workers Builds token can deploy Workers, D1 migrations, Workflows, Containers/images, and R2 bindings. Container deployment needs Docker in the build environment. Do not paste tokens into Slack or the repository.
3. Approve the deploy that applies D1 migration `0003_video_pipeline.sql` and creates `show-and-tell-video-processing-production`, `show-and-tell-video-processor-production`, its SQLite Durable Object namespace, and hourly cleanup trigger. Config lives in `wrangler.production.json`; development uses local emulated resources.
4. After deploy, smoke-test using an authenticated session: create a submission, upload a short MP4 through the API, observe queued → processing → ready, play/seek the output, hide it and verify another user cannot read it, then delete it. Repeat with corrupt input and retry. Browser upload controls arrive in the next PR.

For isolated processor regressions run `npm run test:processor:docker` (included in `verify`). This extracts the pinned binaries from the built image into a temporary directory; tests fail rather than skip if the correct FFmpeg version is unavailable. Worker integration tests use emulated D1/R2 with Workflow autostart disabled, so local verification is not proof of deployed Cloudflare orchestration.
