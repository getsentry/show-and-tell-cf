import {
  consoleLoggingIntegration,
  httpServerIntegration,
  type CloudflareOptions,
} from '@sentry/cloudflare';

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
    tracesSampleRate: 1,
    integrations: [
      consoleLoggingIntegration(),
      // Capture textual bodies up to the SDK's 1 MiB cap; binary video is skipped.
      httpServerIntegration({maxRequestBodySize: 'always'}),
    ],
    // Intentionally opt into every v11 collection category. SDK sensitive-key
    // filtering still applies; this is not a guarantee that all PII is removed.
    dataCollection: {
      userInfo: true,
      cookies: true,
      httpHeaders: {request: true, response: true},
      httpBodies: [
        'incomingRequest',
        'outgoingRequest',
        'incomingResponse',
        'outgoingResponse',
      ],
      urlQueryParams: true,
      databaseQueryData: true,
      genAI: {inputs: true, outputs: true},
      graphQL: {document: true, variables: true},
      queues: true,
      stackFrameVariables: true,
      frameContextLines: 5,
    },
  };
}
