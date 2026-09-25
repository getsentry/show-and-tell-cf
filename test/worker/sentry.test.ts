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
  getIsolationScope,
  type CloudflareOptions,
  type Event,
} from '@sentry/cloudflare';
import {afterEach, describe, expect, it, vi} from 'vitest';
import worker, {app, VideoProcessingWorkflow} from '../../src/worker';
import {sentryOptions} from '../../src/worker/sentry';
import {errorResponse, ServiceError} from '../../src/worker/services/errors';
import {VideoProcessingWorkflow as ProcessingWorkflow} from '../../src/worker/workflows/video-processing';

const dsn = 'https://public@sentry.example/1';
afterEach(() => vi.restoreAllMocks());

function collectEvents(events: Event[]): CloudflareOptions {
  return {
    ...sentryOptions({SENTRY_DSN: dsn, SENTRY_ENVIRONMENT: 'test'}),
    tracesSampleRate: 0,
    beforeSend(event) {
      events.push(event);
      return null;
    },
  };
}

describe('Sentry Worker coverage', () => {
  it('disables local delivery and configures restrictive v11 collection', () => {
    expect(sentryOptions({})).toMatchObject({enabled: false});
    expect(
      sentryOptions({SENTRY_DSN: dsn, CF_VERSION_METADATA: {id: 'version-id'}}),
    ).toMatchObject({
      enabled: true,
      release: 'version-id',
      dataCollection: {
        userInfo: false,
        cookies: false,
        httpHeaders: false,
        httpBodies: [],
        urlQueryParams: false,
        databaseQueryData: false,
      },
    });
    expect(VideoProcessingWorkflow).not.toBe(ProcessingWorkflow);
    expect(VideoProcessingWorkflow.prototype).toBe(ProcessingWorkflow.prototype);
  });

  it('captures a Hono-handled exception once, without request secrets', async () => {
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
      new Request('https://showntell.test/screening?code=oauth-secret', {
        method: 'POST',
        headers: {cookie: 'session=cookie-secret', authorization: 'Bearer token-secret'},
        body: 'private-video-body',
      }),
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
    for (const secret of [
      'oauth-secret',
      'cookie-secret',
      'token-secret',
      'private-video-body',
    ]) {
      expect(serialized).not.toContain(secret);
    }
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
  it('lets the SDK capture a real step callback failure with video context', async () => {
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
    'captures handled %s failure with video/attempt/stage context',
    async (stage) => {
      // Local DSN stays empty: spy at the SDK client boundary, not on our code.
      const capturedTags: Array<Event['tags']> = [];
      // Preserve the SDK implementation and receiver while observing isolation tags.
      // eslint-disable-next-line @typescript-eslint/unbound-method
      const originalCapture = CloudflareClient.prototype.captureException;
      const capture = vi
        .spyOn(CloudflareClient.prototype, 'captureException')
        .mockImplementation(function (this: CloudflareClient, ...args) {
          capturedTags.push(getIsolationScope().getScopeData().tags);
          return originalCapture.apply(this, args);
        });
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
      expect(capture).toHaveBeenCalledTimes(1);
      expect(capture.mock.calls[0][0]).toMatchObject({message: `${stage} failed`});
      expect(capturedTags[0]).toMatchObject({
        component: 'video-processing',
        videoId: id,
        attempt: '2',
        'video.stage': stage,
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
