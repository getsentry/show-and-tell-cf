# Show & Tell

Sentry's internal Show & Tell video playlist application. The React application and Hono API are served by a single Cloudflare Worker.

## Requirements

- Node.js 24.11 or newer (Volta and CI pin 24.19)
- npm 11 or newer

## Local development

```bash
npm ci
npm run dev
```

Copy `.dev.vars.example` to `.dev.vars`, add the local Google OAuth client secret, and allow the exact callback `http://localhost:5173/api/auth/callback`. Then open `http://localhost:5173`. The Worker health endpoint is available at `/api/health`.

## Production

The canonical production origin will be `https://showandtell.sentry.new`. Production deployments use [Cloudflare Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) with `wrangler.production.json`. GitHub Actions verifies pull requests and `main` but does not deploy; no GitHub deployment environment or Cloudflare secrets in GitHub are required.

### Connect Workers Builds

The `show-and-tell-cf` Worker in Sentry Internal initially serves only a temporary `503` not-ready response, with no custom domain. Merge the Workers Builds configuration before enabling automatic builds; older commits do not contain the deployment script below.

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

The first production build migrates the existing `show-and-tell-db` database and replaces the placeholder Worker. Attaching `showandtell.sentry.new` as a custom domain and configuring the legacy redirect are separate infrastructure steps, requiring explicit approval. Login cannot be tested end to end until the canonical domain and runtime secret are ready. D1 is the role authority; promote initial admins after their first login with an explicitly approved `users.is_admin` update.

Configure `showntell.sentry.new` as a Cloudflare redirect to `https://showandtell.sentry.new`, preserving path and query string, rather than serving the application under both hostnames. OAuth callbacks, host-only cookies, and same-origin checks use only the canonical hostname. This redirect still needs to be provisioned in Cloudflare.

## Quality gates

```bash
npm run verify
npm audit --omit=dev --audit-level=high
```

The verification gate generates Cloudflare binding types, typechecks, checks formatting and lint, runs tests, builds the application, and performs a credential-free deployment dry run.

Google OAuth uses Authorization Code with PKCE, state and nonce verification, exact verified `@sentry.io` enforcement, hashed opaque D1 sessions, and HttpOnly cookies. Authenticated mutations require the exact same-origin `Origin` header.
