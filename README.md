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

Open `http://localhost:5173`. The Worker health endpoint is available at `/api/health`.

## Production

The production origin will be `https://showntell.sentry.new`. Every push to `main` runs the complete verification suite and deploys with `wrangler.production.json` through the `show-and-tell-cloudflare` GitHub environment.

The environment requires these GitHub Actions secrets:

- `CLOUDFLARE_ACCOUNT_ID`: Sentry's internal Cloudflare account ID.
- `CLOUDFLARE_API_TOKEN`: an account-scoped token with permission to deploy Workers.

The custom domain and application resources will be connected after the initial foundation lands.

## Quality gates

```bash
npm run verify
npm audit --omit=dev --audit-level=high
```

The verification gate generates Cloudflare binding types, typechecks, checks formatting and lint, runs tests, builds the application, and performs a credential-free deployment dry run.
