import {
  createExecutionContext,
  createScheduledController,
  env,
  introspectWorkflowInstance,
  waitOnExecutionContext,
} from 'cloudflare:test';
import {
  withSentry,
  CloudflareClient,
  metrics,
  type CloudflareOptions,
  type Event,
} from '@sentry/cloudflare';
import {afterEach, describe, expect, it, vi} from 'vitest';
import worker, {app, VideoProcessingWorkflow} from '../../src/worker';
import {sentryOptions} from '../../src/worker/sentry';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';
import {errorResponse, ServiceError} from '../../src/worker/services/errors';
import {VideoProcessingWorkflow as ProcessingWorkflow} from '../../src/worker/workflows/video-processing';

const dsn = 'https://public@sentry.example/1';
afterEach(() => vi.restoreAllMocks());

function collectEvents(events: Event[]): CloudflareOptions {
  return {
    ...sentryOptions({SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'test'}),
    tracesSampleRate: 0,
    beforeSendLog: () => null,
    beforeSendMetric: () => null,
    beforeSend(event) {
      events.push(event);
      return null;
    },
  };
}

describe('Sentry Worker coverage', () => {
  it('disables local delivery and enables all v11 collection categories', () => {
    expect(sentryOptions({})).toMatchObject({enabled: false});
    expect(
      sentryOptions({SENTRY_DSN: dsn, CF_VERSION_METADATA: {id: 'version-id'}}),
    ).toMatchObject({
      enabled: true,
      release: 'version-id',
      tracesSampleRate: 1,
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
    });
    expect(VideoProcessingWorkflow).not.toBe(ProcessingWorkflow);
    expect(VideoProcessingWorkflow.prototype).toBe(ProcessingWorkflow.prototype);
  });

  it('collects request context while keeping SDK sensitive-key filtering', async () => {
    const events: Event[] = [];
    const handler = withSentry(() => collectEvents(events), {
      fetch: (
        request: Request,
        bindings: Parameters<typeof app.fetch>[1],
        ctx: ExecutionContext,
      ) => app.fetch(request, bindings, ctx),
    });
    const ctx = createExecutionContext();
    const assets = {
      fetch: vi.fn(async () => {
        throw new Error('Asset fetch failed');
      }),
      // These service binding methods are not used by this route.
      connect: env.ASSETS.connect.bind(env.ASSETS),
    };
    const response = await handler.fetch(
      new Request(
        'https://showntell.test/screening?view=screen&access_token=oauth-secret',
        {
          method: 'POST',
          headers: {
            cookie: 'session=cookie-secret; theme=dark',
            authorization: 'Bearer token-secret',
            'content-type': 'application/json',
            'x-debug-context': 'screening',
          },
          body: JSON.stringify({
            title: 'Test screening',
            description: 'Full request context',
          }),
        },
      ),
      {...env, ASSETS: assets},
      ctx,
    );
    await waitOnExecutionContext(ctx);
    expect(response.status).toBe(500);
    expect(await response.text()).toBe('Internal Server Error');
    expect(events).toHaveLength(1);
    expect(events[0].exception?.values?.[0].value).toBe('Asset fetch failed');
    // sdkProcessingMetadata is internal and removed before sending the envelope.
    const serialized = JSON.stringify({
      request: events[0].request,
      user: events[0].user,
      breadcrumbs: events[0].breadcrumbs,
    });
    expect(serialized).toContain('Test screening');
    expect(serialized).toContain('screen');
    expect(serialized).toContain('dark');
    expect(events[0].request?.headers?.['x-debug-context']).toBe('screening');
    for (const secret of ['oauth-secret', 'cookie-secret', 'token-secret']) {
      expect(serialized).not.toContain(secret);
    }
  });

  it('attaches authenticated user context without leaking it into another request', async () => {
    const user = await synchronizeGoogleUser(env.DB, {
      subject: 'sentry-context-test',
      email: 'sentry-context-test@sentry.io',
      displayName: 'Telemetry Test',
      avatarUrl: null,
    });
    const session = await createSession(env.DB, user.id);
    const events: Event[] = [];
    const handler = withSentry(() => collectEvents(events), {
      fetch: (
        request: Request,
        bindings: Parameters<typeof app.fetch>[1],
        ctx: ExecutionContext,
      ) => app.fetch(request, bindings, ctx),
    });
    const bindings = {
      ...env,
      ASSETS: {
        fetch: async () => {
          throw new Error('User context test');
        },
        connect: env.ASSETS.connect.bind(env.ASSETS),
      },
    };
    const authenticated = createExecutionContext();
    await handler.fetch(
      new Request('https://showntell.test/api/unknown', {
        headers: {cookie: `${SESSION_COOKIE_NAME}=${session.token}`},
      }),
      bindings,
      authenticated,
    );
    await waitOnExecutionContext(authenticated);
    const anonymous = createExecutionContext();
    await handler.fetch(
      new Request('https://showntell.test/unknown'),
      bindings,
      anonymous,
    );
    await waitOnExecutionContext(anonymous);
    expect(events).toHaveLength(2);
    expect(events[0].user).toMatchObject({
      id: user.id,
      email: user.email,
      username: 'Telemetry Test',
    });
    expect(events[1].user?.id).toBeUndefined();
    expect(events[1].user?.email).toBeUndefined();
  });

  it('captures handled server errors but not validation/conflict errors', async () => {
    const events: Event[] = [];
    const handler = withSentry(() => collectEvents(events), {
      async fetch(_request: Request, _env: Env, _ctx: ExecutionContext) {
        errorResponse(new ServiceError('CONFLICT', 'Already uploading', 409));
        errorResponse(new SyntaxError('Invalid JSON'));
        errorResponse(new ServiceError('STORAGE_FAILED', 'Storage unavailable', 503));
        return new Response('ok');
      },
    });
    const ctx = createExecutionContext();
    await handler.fetch(new Request('https://showntell.test/'), env, ctx);
    await waitOnExecutionContext(ctx);
    expect(events).toHaveLength(1);
    expect(events[0].tags?.code).toBe('STORAGE_FAILED');
  });

  it('flushes console logs, metrics, and streamed spans', async () => {
    const deliveries: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      deliveries.push(await new Response(init?.body).text());
      return new Response('{}');
    });
    const handler = withSentry(() => sentryOptions({SENTRY_DSN: dsn}), {
      async fetch(_request: Request, _env: Env, _ctx: ExecutionContext) {
        console.info('Sentry console log test');
        metrics.count('video.processing.run_outcome', 1, {attributes: {status: 'ready'}});
        return new Response('ok');
      },
    });
    const ctx = createExecutionContext();
    const response = await handler.fetch(
      new Request('https://showntell.test/'),
      env,
      ctx,
    );
    await response.text();
    await waitOnExecutionContext(ctx);
    const envelopes = deliveries.join('\n');
    expect(envelopes).toContain('Sentry console log test');
    expect(envelopes).toContain('video.processing.run_outcome');
    expect(envelopes).toContain('"type":"span"');
  });

  it('flushes scheduled failures through the production wrapper', async () => {
    const deliveries: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) => {
      deliveries.push(await new Response(init?.body).text());
      return new Response('{}');
    });
    const ctx = createExecutionContext();
    await expect(
      worker.scheduled(
        createScheduledController(),
        {...env, SENTRY_DSN: dsn, APP_ORIGIN: 'invalid', SHOW_REMINDERS_ENABLED: 'true'},
        ctx,
      ),
    ).rejects.toThrow('Configure an HTTPS APP_ORIGIN before enabling reminders');
    await waitOnExecutionContext(ctx);
    expect(deliveries.join('\n')).toContain(
      'Configure an HTTPS APP_ORIGIN before enabling reminders',
    );
  });
});

// Run the actual deployed workflow export in workerd, with platform step faults.
describe('Sentry video workflow coverage', () => {
  it('reports a real callback failure once after exhausting retries', async () => {
    const capture = vi.spyOn(CloudflareClient.prototype, 'captureException');
    await using instance = await introspectWorkflowInstance(
      env.VIDEO_PROCESSING_WORKFLOW,
      'sentry-output-missing',
    );
    await instance.modify(async (m) => {
      await m.disableRetryDelays();
      await m.mockStepResult(
        {name: 'claim current processing attempt'},
        {status: 'claimed', outputKey: 'missing-canonical-output.mp4'},
      );
      await m.mockStepResult(
        {name: 'run pinned ffmpeg processor'},
        {status: 'processed', result: {sha256: 'checksum'}},
      );
      await m.mockStepResult({name: 'record publication failure'}, false);
    });
    await env.VIDEO_PROCESSING_WORKFLOW.create({
      id: 'sentry-output-missing',
      params: {videoId: 'output-missing', attempt: 1},
    });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toEqual({status: 'failed', stage: 'publication'});
    expect(capture).toHaveBeenCalledTimes(1);
    expect(
      capture.mock.calls.some(
        ([error]) =>
          error instanceof Error &&
          error.message ===
            'Canonical output is missing or checksum metadata does not match',
      ),
    ).toBe(true);
  });

  it.each(['claim', 'processor', 'publication'] as const)(
    'does not recapture a cached %s step error',
    async (stage) => {
      const capture = vi.spyOn(CloudflareClient.prototype, 'captureException');
      const id = `sentry-${stage}`;
      await using instance = await introspectWorkflowInstance(
        env.VIDEO_PROCESSING_WORKFLOW,
        id,
      );
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
        if (stage !== 'claim') {
          await m.mockStepResult(
            {name: 'claim current processing attempt'},
            {status: 'claimed', outputKey: 'output.mp4'},
          );
        }
        if (stage === 'publication') {
          await m.mockStepResult(
            {name: 'run pinned ffmpeg processor'},
            {status: 'processed', result: {sha256: 'checksum'}},
          );
        }
        const name =
          stage === 'claim'
            ? 'claim current processing attempt'
            : stage === 'processor'
              ? 'run pinned ffmpeg processor'
              : 'publish only if attempt is current';
        await m.mockStepError({name}, new Error(`${stage} failed`));
        await m.mockStepResult({name: `record ${stage} failure`}, false);
      });
      await env.VIDEO_PROCESSING_WORKFLOW.create({id, params: {videoId: id, attempt: 2}});
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toEqual({status: 'failed', stage});
      expect(capture).not.toHaveBeenCalled();
    },
  );

  it.each(['claim', 'processor', 'publication'] as const)(
    'reports a platform %s timeout once after the failure write succeeds',
    async (stage) => {
      const capture = vi.spyOn(CloudflareClient.prototype, 'captureException');
      const id = `sentry-timeout-${stage}`;
      await using instance = await introspectWorkflowInstance(
        env.VIDEO_PROCESSING_WORKFLOW,
        id,
      );
      await instance.modify(async (m) => {
        await m.disableRetryDelays();
        if (stage !== 'claim') {
          await m.mockStepResult(
            {name: 'claim current processing attempt'},
            {status: 'claimed', outputKey: 'output.mp4'},
          );
        }
        if (stage === 'publication') {
          await m.mockStepResult(
            {name: 'run pinned ffmpeg processor'},
            {status: 'processed', result: {sha256: 'checksum'}},
          );
        }
        const name =
          stage === 'claim'
            ? 'claim current processing attempt'
            : stage === 'processor'
              ? 'run pinned ffmpeg processor'
              : 'publish only if attempt is current';
        await m.forceStepTimeout({name});
        // Retry the persistence step once before executing its real callback.
        await m.mockStepError(
          {name: `record ${stage} failure`},
          new Error('Transient D1 failure'),
          1,
        );
      });
      await env.VIDEO_PROCESSING_WORKFLOW.create({id, params: {videoId: id, attempt: 1}});
      await instance.waitForStatus('complete');
      expect(await instance.getOutput()).toEqual({status: 'failed', stage});
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0][0]).toMatchObject({
        message: 'Execution timed out after 0ms',
      });
    },
  );

  it('preserves a stale attempt through the instrumented Workflow entrypoint', async () => {
    const capture = vi.spyOn(CloudflareClient.prototype, 'captureException');
    await using instance = await introspectWorkflowInstance(
      env.VIDEO_PROCESSING_WORKFLOW,
      'sentry-stale',
    );
    await instance.modify(async (m) => {
      await m.mockStepResult(
        {name: 'claim current processing attempt'},
        {status: 'stale'},
      );
    });
    await env.VIDEO_PROCESSING_WORKFLOW.create({
      id: 'sentry-stale',
      params: {videoId: 'stale', attempt: 1},
    });
    await instance.waitForStatus('complete');
    expect(await instance.getOutput()).toEqual({status: 'stale'});
    expect(capture).not.toHaveBeenCalled();
  });
});
