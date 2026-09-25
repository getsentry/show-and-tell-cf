import {type CloudflareOptions} from '@sentry/cloudflare';

export interface SentryEnv {
  SENTRY_DSN?: string;
  SENTRY_ENVIRONMENT?: string;
  CF_VERSION_METADATA?: {id: string};
}

export function sentryOptions(env: SentryEnv): CloudflareOptions {
  return {
    dsn: env.SENTRY_DSN,
    enabled: Boolean(env.SENTRY_DSN),
    // HTTP and Workflow invocations have different lifecycles and SDK defaults.
    cacheClient: false,
    environment: env.SENTRY_ENVIRONMENT ?? 'development',
    release: env.CF_VERSION_METADATA?.id,
    tracesSampleRate: 0.1,
    // v11 collects more by default. Upload bodies and OAuth/session data must
    // not become telemetry; video IDs and processing attempts are enough context.
    dataCollection: {
      userInfo: false,
      cookies: false,
      httpHeaders: false,
      httpBodies: [],
      urlQueryParams: false,
      databaseQueryData: false,
      genAI: {inputs: false, outputs: false},
      graphQL: {document: false, variables: false},
    },
  };
}
