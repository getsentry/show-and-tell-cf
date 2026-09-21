import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {cloudflareTest, readD1Migrations} from '@cloudflare/vitest-pool-workers';
import {defineConfig} from 'vitest/config';

const root = path.dirname(fileURLToPath(import.meta.url));

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: {configPath: './wrangler.jsonc'},
      miniflare: {
        serviceBindings: {
          ASSETS: async () => new Response('<div id="root"></div>'),
        },
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(path.join(root, 'migrations')),
          APP_ORIGIN: 'https://showntell.test',
          GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-client-secret',
          GOOGLE_REDIRECT_URI: 'https://showntell.test/api/auth/callback',
          ALLOWED_EMAIL_DOMAIN: 'sentry.io',
          VIDEO_PROCESSING_AUTOSTART: 'false',
        },
      },
    })),
  ],
  test: {
    include: ['test/worker/**/*.test.ts'],
    setupFiles: ['./test/worker/setup.ts'],
    maxWorkers: 1,
  },
});
