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

`wrangler.production.json` declares both custom domains. The Worker redirects the exact legacy hostname `showntell.sentry.new` to `https://showandtell.sentry.new` with HTTP 308, preserving path and query before auth or asset handling. The legacy host never serves the application. OAuth callbacks, host-only cookies, and same-origin checks use only the canonical hostname; do not add a second Google callback.

**Rollout approval required:** deploying the playlist PR applies additive D1 migration `0005_playlist_playback.sql`, updates the Worker, and provisions the legacy custom domain/DNS/certificate via Wrangler. The existing canonical custom domain is retained. Ensure the Workers Builds token can manage custom domains in the `sentry.new` zone as well as deploy Workers and migrate D1. Do not merge/deploy until the Cloudflare writes are approved. No separate redirect Worker or R2 public access is needed. After deployment/TLS issuance, check `curl -I 'https://showntell.sentry.new/playlists/<event-id>?view=screen'` returns a 308 to the matching canonical URL.

## Quality gates

```bash
npm run verify
npm audit --omit=dev --audit-level=high
```

The verification gate generates Cloudflare binding types, typechecks, checks formatting and lint, runs app/Worker tests, builds the pinned Docker processor and runs real FFmpeg regressions, builds the application, and performs a credential-free deployment dry run. No Cloudflare resources are created by verification.

Google OAuth uses Authorization Code with PKCE, state and nonce verification, exact verified `@sentry.io` enforcement, hashed opaque D1 sessions, and HttpOnly cookies. Authenticated mutations require the exact same-origin `Origin` header.

## Overview and admin/user views

The home page lists shows as text-and-CSS cards with a prominent **Watch playlist** link and a smaller **Upload & submissions** link. It does not automatically open a show. Admins can expand **New playlist** on the overview; its title defaults to `Show & Tell {Month} - {Year}` using the browser's current local month. Creating it adds it to the list and opens its submission page.

Share `/events/<event-id>` for submissions or `/playlists/<event-id>` for screening. Both destinations survive Google sign-in through the same browser-bound, allowlisted OAuth flow. The submission page has **Copy submission link**; the player has **Copy playlist link**. Legacy `/?event=<event-id>` links still open the submission page and normalize to the new path for sign-in.

Like Hack Week, admins can **Switch to user view** / **Back to admin** in the header. Migration `0006_session_view_mode.sql` adds a per-session preference; it does not change `users.is_admin`. The Worker enforces the effective member role for visibility, counts, uploads, moderation and creation—not just the UI. Another browser session is unaffected; demotion still takes effect on the next request. Switching views resets page data and stops active media/uploads, avoiding stale admin-only content. Submission bylines use the creator's current Google profile photo with an initials fallback.

**Rollout:** this polish PR adds one backward-compatible D1 column and deploys the Worker/frontend. No new resources or credentials. Production migration/deployment still require explicit approval; local verification does not apply them remotely. The API/plugin/transcript idea in #4 remains deferred.

## Submissions and video uploads

Playlists and submissions need only a title and optional description. For dated events, use a title such as `Show & Tell — October 2026`. Project links are no longer accepted as a required field or exposed in the API/UI. Migration `0004_remove_project_url.sql` drops the unused `project_url` column and permanently discards its old values. Submission records and video relationships are preserved; no compatibility placeholder remains.

Create a submission first, then use **Choose video → Upload video** on its card. The browser uploads 50 MiB parts and shows saved-byte progress. Pause/resume, retry interrupted uploads, or discard an unfinished upload without deleting the submission. Reloading/switching playlists pauses transfers; reselect the **original, unchanged file** to resume. Completed parts and active upload discovery live on the server, including recovery when a create response is lost. The browser remembers `lastModified` when storage is available to catch accidental file revisions; this is a convenience check, not a content hash.

Queued/processing status refreshes every five seconds. Failed processing offers retry or confirmed video removal for replacement. Ready videos have authenticated, native **Watch video** controls.

### Company playlist player

Open **Open the screening** on a playlist, or share `/playlists/<event-id>`. Google sign-in returns to this allowlisted local player path using the existing browser-bound OAuth state. The player ports Hack Week's screening reel: **Play all** opens with a start card, then every clip is announced on a title card (video number, title, presenter) with a five-second countdown while the next clip preloads in the second video buffer. The countdown circle or **Start now** skips the wait. While a clip plays, a caption with the title and presenter fades in and out; pausing keeps it visible. The reel ends on a wrap card with **Play again**.

Controls under the stage cover seek, previous/next, pause/resume, mute, playback speed and fullscreen; keyboard shortcuts are `space`, `←`, `→`, `m` and `f`. In fullscreen the controls and cursor hide after a short idle period and return on pointer movement. The lineup below the player jumps to any clip. Audio is already loudness-normalized in the processed MP4; no second gain adjustment is applied. The app follows the Hack Week look with Rubik, the Sentry palette and a light/dark toggle that respects the system preference.

The screening endpoint includes only ready, non-hidden, non-deleted videos, identically for admins and members. It revalidates each clip before playback/transition; content requests remain session-authenticated. A browser may block automatic playback: **Retry video** recovers without silently skipping, and **Skip video** moves on. Fullscreen support varies by browser. Already buffered/playing bytes cannot be revoked immediately.

Admins use **Arrange playlist** and the up/down buttons; changes save immediately. Ordering includes hidden/unfinished submissions so they keep their place. New submissions append after ordered entries. A single atomic D1 statement compares the full previous order before changing positions; stale/concurrent edits or membership changes return 409 and refresh the editor. Reorder requests support up to 1,000 submissions. A screening uses a snapshot: **Refresh playlist** stops playback and reloads the latest order/readiness.

Before launch, smoke-test two real videos through title cards, automatic advancement and replay; previous/next, seek, pause, mute, speed, keyboard shortcuts and fullscreen; sharing through a signed-out Google login; admin reorder persistence; member reorder denial; hidden/deleted clips and expired sessions; failed media retry/skip; mobile layout; and the legacy-domain redirect. Test Safari/iOS as well as Chromium. The Junior admin/discovery API and transcripts remain deferred in issue #4.

The backend ports Hack Week's private R2 multipart lifecycle, Workflow, and pinned FFmpeg 8.0.1 processor, without years, groups, voting, or team membership. Failed uploads or processing never remove the saved submission.

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
- `GET /submissions/:id/video/upload`: discover an active upload (owner/admin only), including after a lost create response. Read-only; expired sessions are cleaned by the existing recovery/cleanup paths.
- `POST /submissions/:id/video/upload`: `{fileName, fileSize, contentType}` → `{upload, video}`.
- `GET /submissions/:id/video/upload/:uploadId`: resume metadata and completed parts.
- `PUT /submissions/:id/video/upload/:uploadId/parts/:partNumber`: raw bytes with exact `Content-Length` → `{part: {partNumber, etag, sizeBytes}}`.
- `POST /submissions/:id/video/upload/:uploadId/complete`: `{parts: [{partNumber, etag}]}` → `{video}`.
- `DELETE /submissions/:id/video/upload/:uploadId`: abort an unfinished upload.
- `POST /submissions/:id/video/retry`: retry failed processing / queued Workflow handoff.
- `DELETE /submissions/:id/video`: `{confirmed: true}` retires the video without deleting the submission or original bytes.
- `GET /videos/:videoId/playback`: authenticated MP4 descriptor.
- `GET /videos/:videoId/content`: full or single-range canonical MP4.

### Production rollout and smoke test

Main automatically deploys through Workers Builds. The video infrastructure was approved and deployed with PR #5; the upload UI needs no new bindings or secrets. Migration `0004_remove_project_url.sql` runs on deployment and permanently removes stored project URLs. The previously deployed Worker requires this column, so event-detail reads and submission creation can fail between migration and Worker deployment; roll forward to this PR's Worker rather than rolling back to the old code. Additional Cloudflare writes still require explicit approval.

1. For a new environment, approve and create the private R2 bucket `show-and-tell-videos-production` in Sentry Internal. Keep public access disabled; same-origin Worker uploads do not need R2 CORS or S3 credentials.
2. Verify the Workers Builds token can deploy Workers, D1 migrations, Workflows, Containers/images, and R2 bindings. Container deployment needs Docker in the build environment. Do not paste tokens into Slack or the repository.
3. For a new environment, approve the deploy that applies D1 migration `0003_video_pipeline.sql` and creates `show-and-tell-video-processing-production`, `show-and-tell-video-processor-production`, its SQLite Durable Object namespace, and hourly cleanup trigger. Config lives in `wrangler.production.json`; development uses local emulated resources.
4. After deploy, smoke-test using an authenticated session: create a submission, choose a short MP4 in the upload UI, observe queued → processing → ready, play/seek the output, hide it and verify another user cannot read it, then delete it. Repeat with corrupt input and retry. Reload during an interrupted upload and verify resume; confirm the browser supplies Content-Length for Blob parts.

For isolated processor regressions run `npm run test:processor:docker` (included in `verify`). This extracts the pinned binaries from the built image into a temporary directory; tests fail rather than skip if the correct FFmpeg version is unavailable. Worker integration tests use emulated D1/R2 with Workflow autostart disabled, so local verification is not proof of deployed Cloudflare orchestration.
