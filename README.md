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

The canonical production origin will be `https://showandtell.sentry.new`. Every push to `main` runs the complete verification suite and deploys with `wrangler.production.json` through the `show-and-tell-cloudflare` GitHub environment.

The environment requires these GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`: Sentry's internal Cloudflare account ID.
- `CLOUDFLARE_API_TOKEN`: an account-scoped token with permission to deploy Workers.

Before deployment, replace the D1 ID and Google client ID placeholders in `wrangler.production.json`, add `GOOGLE_CLIENT_SECRET` with `wrangler secret put`, and create the OAuth web client with origin `https://showandtell.sentry.new` and callback `https://showandtell.sentry.new/api/auth/callback`. D1 is the role authority; promote initial admins after their first login with an explicit `users.is_admin` update.

Configure `showntell.sentry.new` as a Cloudflare redirect to `https://showandtell.sentry.new`, preserving path and query string, rather than serving the application under both hostnames. OAuth callbacks, host-only cookies, and same-origin checks use only the canonical hostname. This redirect still needs to be provisioned in Cloudflare.

## Quality gates

```bash
npm run verify
npm audit --omit=dev --audit-level=high
```

The verification gate generates Cloudflare binding types, typechecks, checks formatting and lint, runs tests, builds the application, and performs a credential-free deployment dry run.

Google OAuth uses Authorization Code with PKCE, state and nonce verification, exact verified `@sentry.io` enforcement, hashed opaque D1 sessions, and HttpOnly cookies. Authenticated mutations require the exact same-origin `Origin` header.
