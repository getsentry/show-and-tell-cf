import {env, SELF} from 'cloudflare:test';
import worker from '../../src/worker';
import {beforeEach, describe, expect, it} from 'vitest';

import type {JsonInput} from '../../src/shared/json';
import {videoR2Handler} from '../../src/worker/containers/video-processor';
import {SESSION_COOKIE_NAME} from '../../src/worker/middleware/auth';
import {createSession} from '../../src/worker/services/sessions';
import {synchronizeGoogleUser} from '../../src/worker/services/users';
import {
  claimVideoProcessingAttempt,
  completeVideoUpload,
  createMultipartVideoUpload,
  failVideoProcessingAttempt,
  MAX_VIDEO_BYTES,
  publishVideoProcessingAttempt,
  reapExpiredMultipartVideoUploads,
  reportVideoProcessingProgress,
  VIDEO_PART_SIZE,
} from '../../src/worker/services/videos';
import {isContainerCapacityResponse} from '../../src/worker/workflows/video-processing';
import type {VideoProcessorResult} from '../../src/worker/video-processing';

const base = 'https://showntell.test/api';
let suffix = 0;
let ownerToken: string;
let outsiderToken: string;
let ownerId: string;
let submissionId: string;
let eventId: string;

beforeEach(async () => {
  suffix += 1;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM video_uploads'),
    env.DB.prepare('DELETE FROM video_submissions'),
    env.DB.prepare('DELETE FROM submissions'),
    env.DB.prepare('DELETE FROM show_and_tell_events'),
    env.DB.prepare('DELETE FROM user_sessions'),
    env.DB.prepare('DELETE FROM oauth_login_attempts'),
    env.DB.prepare('DELETE FROM users'),
  ]);
  const owner = await userCookie(`video-owner-${suffix}`);
  ownerToken = owner.cookie;
  ownerId = owner.id;
  outsiderToken = (await userCookie(`video-outsider-${suffix}`)).cookie;
  eventId = `video-event-${suffix}`;
  await env.DB.prepare(
    'INSERT INTO show_and_tell_events (id, title, created_by) VALUES (?, ?, ?)',
  )
    .bind(eventId, 'Video event', ownerId)
    .run();
  submissionId = await createSubmission('Video submission');
});

async function userCookie(name: string) {
  const user = await synchronizeGoogleUser(env.DB, {
    subject: name,
    email: `${name}@sentry.io`,
    displayName: name,
    avatarUrl: null,
  });
  const session = await createSession(env.DB, user.id);
  return {id: user.id, cookie: `${SESSION_COOKIE_NAME}=${session.token}`};
}

describe('R2 multipart video lifecycle', () => {
  it('cleans up expired uploads for deleted submissions on schedule', async () => {
    const created = await createUpload(submissionId, ownerToken, 3);
    const uploadId = created.body.upload.uploadId;
    await api(`/events/${eventId}/submissions/${submissionId}`, ownerToken, {
      method: 'DELETE',
    });
    await expireUpload(uploadId);
    await worker.scheduled(
      {scheduledTime: Date.now(), cron: '17 * * * *', noRetry() {}},
      env,
    );
    expect(
      await env.DB.prepare('SELECT status FROM video_uploads WHERE id = ?')
        .bind(uploadId)
        .first('status'),
    ).toBe('expired');
  });

  it('retries queued handoff without incrementing the processing attempt', async () => {
    const {video} = await completeSmallUpload(submissionId, ownerToken, 'source');
    const retried = await api(`/submissions/${submissionId}/video/retry`, ownerToken, {
      method: 'POST',
    });
    expect(retried.status).toBe(202);
    expect(retried.body.video).toMatchObject({
      id: video.id,
      processingAttempt: 1,
      status: 'queued',
    });
    expect(
      await env.DB.prepare(
        'SELECT COUNT(*) count FROM video_processing_attempts WHERE video_id = ?',
      )
        .bind(video.id)
        .first('count'),
    ).toBe(1);
  });

  it('recognizes only the platform instance ceiling as transient capacity', () => {
    expect(
      isContainerCapacityResponse(
        500,
        'Failed to start container: Maximum number of running container instances exceeded. Try again later',
      ),
    ).toBe(true);
    expect(isContainerCapacityResponse(422, 'Input does not contain a video')).toBe(
      false,
    );
    expect(isContainerCapacityResponse(500, 'Derivative R2 write failed')).toBe(false);
  });

  it('streams resumable parts, completes idempotently, and records the queued handoff', async () => {
    const forbidden = await createUpload(submissionId, outsiderToken, 11);
    expect(forbidden.status).toBe(403);

    const created = await createUpload(submissionId, ownerToken, 11);
    expect(created.status).toBe(201);
    expect(created.body.video).toBeNull();
    expect(created.body.upload).toMatchObject({
      submissionId,
      fileSize: 11,
      partSize: VIDEO_PART_SIZE,
      status: 'uploading',
      completedParts: [],
    });

    const uploadId = created.body.upload.uploadId;
    const firstPart = await putPart(
      submissionId,
      uploadId,
      1,
      new TextEncoder().encode('hello video'),
      ownerToken,
    );
    const duplicatePart = await putPart(
      submissionId,
      uploadId,
      1,
      new TextEncoder().encode('hello video'),
      ownerToken,
    );
    expect(firstPart.status).toBe(200);
    expect(duplicatePart.body.part.etag).toBe(firstPart.body.part.etag);

    const resumed = await api(
      `/submissions/${submissionId}/video/upload/${uploadId}`,
      ownerToken,
    );
    expect(resumed.body.upload.completedParts).toEqual([firstPart.body.part]);

    const parts = [
      {
        partNumber: firstPart.body.part.partNumber,
        etag: firstPart.body.part.etag,
      },
    ];
    const completed = await api(
      `/submissions/${submissionId}/video/upload/${uploadId}/complete`,
      ownerToken,
      {method: 'POST', body: {parts}},
    );
    const duplicateCompletion = await api(
      `/submissions/${submissionId}/video/upload/${uploadId}/complete`,
      ownerToken,
      {method: 'POST', body: {parts}},
    );

    expect(completed.status).toBe(200);
    expect(completed.body.video).toMatchObject({
      submissionId,
      status: 'queued',
      sizeBytes: 11,
      originalName: 'demo.mp4',
      processingAttempt: 1,
    });
    expect(duplicateCompletion.body.video.id).toBe(completed.body.video.id);

    const stored = await env.DB.prepare(
      `SELECT original_r2_key FROM video_submissions WHERE id = ?`,
    )
      .bind(completed.body.video.id)
      .first<{original_r2_key: string}>();
    const attempt = await env.DB.prepare(
      `SELECT attempt, status FROM video_processing_attempts WHERE video_id = ?`,
    )
      .bind(completed.body.video.id)
      .first<{attempt: number; status: string}>();
    expect((await env.VIDEOS.head(stored!.original_r2_key))?.size).toBe(11);
    expect(attempt).toEqual({attempt: 1, status: 'queued'});
  });

  it('enforces one active submission slot in D1 while different submissions stay independent', async () => {
    const sameProject = await Promise.all([
      createUpload(submissionId, ownerToken, 20),
      createUpload(submissionId, ownerToken, 20),
    ]);
    expect(sameProject.map(({status}) => status).sort((a, b) => a - b)).toEqual([
      201, 409,
    ]);

    const left = await createSubmission('Independent left');
    const right = await createSubmission('Independent right');
    const independent = await Promise.all([
      createUpload(left, ownerToken, 20),
      createUpload(right, ownerToken, 20),
    ]);
    expect(independent.map(({status}) => status)).toEqual([201, 201]);

    const activeIndex = await env.DB.prepare(
      `SELECT sql FROM sqlite_master WHERE type = 'index'
       AND name = 'video_submissions_active_submission_idx'`,
    ).first<{sql: string}>();
    expect(activeIndex?.sql).toContain('WHERE retired_at IS NULL');
  });

  it('reaps an expired upload with lost resume state before creating a fresh upload', async () => {
    const stale = await createUpload(submissionId, ownerToken, 11);
    const staleUploadId = stale.body.upload.uploadId;
    expect(
      (
        await putPart(
          submissionId,
          staleUploadId,
          1,
          new TextEncoder().encode('stale video'),
          ownerToken,
        )
      ).status,
    ).toBe(200);
    const staleStorage = await uploadStorage(staleUploadId);
    await expireUpload(staleUploadId);

    const fresh = await createUpload(submissionId, ownerToken, 12);
    expect(fresh.status).toBe(201);
    expect(fresh.body.upload.uploadId).not.toBe(staleUploadId);
    expect(
      await env.DB.prepare('SELECT status FROM video_uploads WHERE id = ?')
        .bind(staleUploadId)
        .first('status'),
    ).toBe('expired');
    expect(await env.VIDEOS.head(staleStorage.original_r2_key)).toBeNull();
    await expect(
      env.VIDEOS.resumeMultipartUpload(
        staleStorage.original_r2_key,
        staleStorage.r2_upload_id,
      ).uploadPart(1, new Uint8Array([1]).buffer),
    ).rejects.toThrow(/multipart upload does not exist|10024/i);
  });

  it('retries idempotent expiry cleanup without releasing after transient R2 failure', async () => {
    const stale = await createUpload(submissionId, ownerToken, 10);
    const staleUploadId = stale.body.upload.uploadId;
    await expireUpload(staleUploadId);
    const failingBucket: R2Bucket = Object.assign(Object.create(env.VIDEOS), {
      resumeMultipartUpload() {
        return {
          abort: async () => {
            throw new Error('temporary R2 outage');
          },
        };
      },
    });

    await expect(
      reapExpiredMultipartVideoUploads(env.DB, failingBucket, {submissionId, limit: 1}),
    ).rejects.toMatchObject({code: 'SERVICE_UNAVAILABLE', status: 503});
    expect(
      await env.DB.prepare('SELECT status FROM video_uploads WHERE id = ?')
        .bind(staleUploadId)
        .first('status'),
    ).toBe('expiring');
    expect((await createUpload(submissionId, ownerToken, 12)).status).toBe(201);
    expect(
      await env.DB.prepare('SELECT status FROM video_uploads WHERE id = ?')
        .bind(staleUploadId)
        .first('status'),
    ).toBe('expired');
  });

  it('handles missing multipart state and simultaneous fresh creates idempotently', async () => {
    const stale = await createUpload(submissionId, ownerToken, 10);
    const staleUploadId = stale.body.upload.uploadId;
    const staleStorage = await uploadStorage(staleUploadId);
    await env.VIDEOS.resumeMultipartUpload(
      staleStorage.original_r2_key,
      staleStorage.r2_upload_id,
    ).abort();
    await expireUpload(staleUploadId);

    const fresh = await Promise.all([
      createUpload(submissionId, ownerToken, 12),
      createUpload(submissionId, ownerToken, 12),
    ]);
    expect(fresh.map(({status}) => status).sort((a, b) => a - b)).toEqual([201, 409]);
    expect(
      await env.DB.prepare('SELECT status FROM video_uploads WHERE id = ?')
        .bind(staleUploadId)
        .first('status'),
    ).toBe('expired');
  });

  it('fences an expired upload before an old completion can publish', async () => {
    const stale = await createUpload(submissionId, ownerToken, 11);
    const staleUploadId = stale.body.upload.uploadId;
    const part = await putPart(
      submissionId,
      staleUploadId,
      1,
      new TextEncoder().encode('stale video'),
      ownerToken,
    );
    expect(part.status).toBe(200);
    await expireUpload(staleUploadId);

    const fresh = createUpload(submissionId, ownerToken, 12);
    const completion = api(
      `/submissions/${submissionId}/video/upload/${staleUploadId}/complete`,
      ownerToken,
      {
        method: 'POST',
        body: {parts: [{partNumber: 1, etag: part.body.part.etag}]},
      },
    );
    const [freshResult, completionResult] = await Promise.all([fresh, completion]);
    expect(freshResult.status).toBe(201);
    expect(completionResult.status).toBe(409);
    expect(
      await env.DB.prepare('SELECT status FROM video_uploads WHERE id = ?')
        .bind(staleUploadId)
        .first('status'),
    ).toBe('expired');
  });

  it('leases an in-flight completion against a concurrent fresh create', async () => {
    const created = await createUpload(submissionId, ownerToken, 11);
    const uploadId = created.body.upload.uploadId;
    const part = await putPart(
      submissionId,
      uploadId,
      1,
      new TextEncoder().encode('final video'),
      ownerToken,
    );
    expect(part.status).toBe(200);
    const upload = await uploadStorage(uploadId);
    const completionStart = new Date('2030-01-01T00:00:00.000Z');
    await env.DB.prepare('UPDATE video_uploads SET expires_at = ? WHERE id = ?')
      .bind('2030-01-01T00:01:00.000Z', uploadId)
      .run();

    let enteredCompletion!: () => void;
    let releaseCompletion!: () => void;
    const completionEntered = new Promise<void>((resolve) => {
      enteredCompletion = resolve;
    });
    const completionReleased = new Promise<void>((resolve) => {
      releaseCompletion = resolve;
    });
    const multipart = env.VIDEOS.resumeMultipartUpload(
      upload.original_r2_key,
      upload.r2_upload_id,
    );
    const blockingBucket: R2Bucket = Object.assign(Object.create(env.VIDEOS), {
      head: env.VIDEOS.head.bind(env.VIDEOS),
      resumeMultipartUpload() {
        return {
          complete: async (parts: R2UploadedPart[]) => {
            enteredCompletion();
            await completionReleased;
            return multipart.complete(parts);
          },
        };
      },
    });
    const owner = {
      id: ownerId,
      email: `video-owner-${suffix}@sentry.io`,
      displayName: 'Show & Tell member',
      avatarUrl: null,
      role: 'member' as const,
    };

    const completing = completeVideoUpload(
      env.DB,
      blockingBucket,
      null,
      submissionId,
      uploadId,
      [{partNumber: 1, etag: part.body.part.etag}],
      owner,
      completionStart,
    );
    await completionEntered;
    try {
      await expect(
        createMultipartVideoUpload(
          env.DB,
          env.VIDEOS,
          submissionId,
          owner,
          {fileName: 'replacement.mp4', fileSize: 12, contentType: 'video/mp4'},
          new Date('2030-01-01T00:02:00.000Z'),
        ),
      ).rejects.toMatchObject({code: 'CONFLICT', status: 409});
    } finally {
      releaseCompletion();
    }
    await expect(completing).resolves.toMatchObject({status: 'queued'});
  });

  it('retires only with confirmation, retains the original, and requires a fresh replacement', async () => {
    const {video, key} = await completeSmallUpload(
      submissionId,
      ownerToken,
      'first video',
    );
    const unconfirmed = await api(`/submissions/${submissionId}/video`, ownerToken, {
      method: 'DELETE',
      body: {confirmed: false},
    });
    expect(unconfirmed.status).toBe(400);

    const retired = await api(`/submissions/${submissionId}/video`, ownerToken, {
      method: 'DELETE',
      body: {confirmed: true},
    });
    expect(retired.status).toBe(204);
    expect(await env.VIDEOS.head(key)).not.toBeNull();
    const retiredRow = await env.DB.prepare(
      'SELECT status, original_r2_key FROM video_submissions WHERE id = ?',
    )
      .bind(video.id)
      .first<{status: string; original_r2_key: string}>();
    expect(retiredRow).toEqual({status: 'retired', original_r2_key: key});
    const attempt = await env.DB.prepare(
      'SELECT status FROM video_processing_attempts WHERE video_id = ?',
    )
      .bind(video.id)
      .first<{status: string}>();
    expect(attempt?.status).toBe('cancelled');

    const replacement = await createUpload(submissionId, ownerToken, 7);
    expect(replacement.status).toBe(201);
    expect(replacement.body.upload.videoId).not.toBe(video.id);
    expect(replacement.body.upload.uploadId).not.toBe(video.id);
  });

  it('normalizes browser MIME metadata while retaining video filename validation', async () => {
    const opaqueProject = await createSubmission('Opaque browser MIME');
    const opaque = await api(`/submissions/${opaqueProject}/video/upload`, ownerToken, {
      method: 'POST',
      body: {
        fileName: 'camera-export.mp4',
        fileSize: 10,
        contentType: 'application/octet-stream',
      },
    });
    expect(opaque.status).toBe(201);
    expect(opaque.body.upload.contentType).toBeNull();
    await api(
      `/submissions/${opaqueProject}/video/upload/${opaque.body.upload.uploadId}`,
      ownerToken,
      {
        method: 'DELETE',
      },
    );

    const parameterProject = await createSubmission('Parameterized browser MIME');
    const parameterized = await api(
      `/submissions/${parameterProject}/video/upload`,
      ownerToken,
      {
        method: 'POST',
        body: {
          fileName: 'camera.mov',
          fileSize: 10,
          contentType: 'video/quicktime; codecs=hvc1',
        },
      },
    );
    expect(parameterized.status).toBe(201);
    expect(parameterized.body.upload.contentType).toBe('video/quicktime');
    await api(
      `/submissions/${parameterProject}/video/upload/${parameterized.body.upload.uploadId}`,
      ownerToken,
      {method: 'DELETE'},
    );
  });

  it('rejects malformed, oversized, stale, and incomplete requests deterministically', async () => {
    const malformed = await api(`/submissions/${submissionId}/video/upload`, ownerToken, {
      method: 'POST',
      body: {fileName: 'notes.txt', fileSize: 10, contentType: 'text/plain'},
    });
    const oversized = await createUpload(submissionId, ownerToken, MAX_VIDEO_BYTES + 1);
    expect(malformed.status).toBe(400);
    expect(oversized.status).toBe(400);
    const maximumProject = await createSubmission('Maximum declaration');
    const maximum = await createUpload(maximumProject, ownerToken, MAX_VIDEO_BYTES);
    expect(maximum.status).toBe(201);
    await api(
      `/submissions/${maximumProject}/video/upload/${maximum.body.upload.uploadId}`,
      ownerToken,
      {method: 'DELETE'},
    );

    const created = await createUpload(submissionId, ownerToken, 10);
    const uploadId = created.body.upload.uploadId;
    const incomplete = await api(
      `/submissions/${submissionId}/video/upload/${uploadId}/complete`,
      ownerToken,
      {method: 'POST', body: {parts: [{partNumber: 1, etag: 'missing'}]}},
    );
    expect(incomplete.status).toBe(400);

    await env.DB.prepare(
      `UPDATE video_uploads SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
    )
      .bind(uploadId)
      .run();
    const expired = await putPart(
      submissionId,
      uploadId,
      1,
      new Uint8Array(10),
      ownerToken,
    );
    expect(expired.status).toBe(409);
    expect(expired.body.error.message).toBe('Upload session has expired');
  });

  it('allows aborting incomplete uploads idempotently but never completed objects', async () => {
    const created = await createUpload(submissionId, ownerToken, 8);
    const uploadId = created.body.upload.uploadId;
    const first = await api(
      `/submissions/${submissionId}/video/upload/${uploadId}`,
      ownerToken,
      {method: 'DELETE'},
    );
    const duplicate = await api(
      `/submissions/${submissionId}/video/upload/${uploadId}`,
      ownerToken,
      {method: 'DELETE'},
    );
    expect(first.status).toBe(204);
    expect(duplicate.status).toBe(204);
  });

  it('reports progress only for the current running processing attempt', async () => {
    const {video} = await completeSmallUpload(
      submissionId,
      ownerToken,
      'progress source',
    );
    const claim = await claimVideoProcessingAttempt(env.DB, video.id, 1, 1);
    if (claim.status !== 'claimed') throw new Error('attempt was not claimed');

    expect(
      await reportVideoProcessingProgress(env.DB, video.id, 1, 'transcoding', 63),
    ).toBe(true);
    const status = await api(`/submissions/${submissionId}/video`, ownerToken);
    expect(status.headers.get('cache-control')).toBe('private, no-store');
    expect(status.body.video).toMatchObject({
      status: 'processing',
      processingStage: 'transcoding',
      processingProgress: 63,
    });

    expect(
      await publishVideoProcessingAttempt(
        env.DB,
        video.id,
        1,
        claim.outputKey,
        canonicalResult,
      ),
    ).toBe(true);
    expect(
      await reportVideoProcessingProgress(env.DB, video.id, 1, 'uploading', 100),
    ).toBe(false);
  });

  it('conditionally publishes canonical metadata exactly once for the current attempt', async () => {
    const {video, key: originalKey} = await completeSmallUpload(
      submissionId,
      ownerToken,
      'canonical source',
    );
    const claim = await claimVideoProcessingAttempt(env.DB, video.id, 1, 1);
    expect(claim.status).toBe('claimed');
    if (claim.status !== 'claimed') throw new Error('attempt was not claimed');
    expect(claim.outputKey).not.toBe(originalKey);

    expect(
      await publishVideoProcessingAttempt(
        env.DB,
        video.id,
        1,
        claim.outputKey,
        canonicalResult,
      ),
    ).toBe(true);
    expect(
      await publishVideoProcessingAttempt(
        env.DB,
        video.id,
        1,
        claim.outputKey,
        canonicalResult,
      ),
    ).toBe(false);
    const stored = await env.DB.prepare(
      `SELECT status, original_r2_key, processed_r2_key, duration_seconds,
        loudness_lufs, processing_attempt FROM video_submissions WHERE id = ?`,
    )
      .bind(video.id)
      .first();
    expect(stored).toEqual({
      status: 'ready',
      original_r2_key: originalKey,
      processed_r2_key: claim.outputKey,
      duration_seconds: canonicalResult.durationSeconds,
      loudness_lufs: canonicalResult.loudnessLufs,
      processing_attempt: 1,
    });
  });

  it('fences retirement, failure, retry, and late attempt completion while retaining bytes', async () => {
    const {video, key: originalKey} = await completeSmallUpload(
      submissionId,
      ownerToken,
      'retry source',
    );
    const first = await claimVideoProcessingAttempt(env.DB, video.id, 1, 1);
    if (first.status !== 'claimed') throw new Error('attempt was not claimed');
    await env.VIDEOS.put(first.outputKey, 'retained stale derivative');
    expect(await failVideoProcessingAttempt(env.DB, video.id, 1, 'ffmpeg failed')).toBe(
      true,
    );

    const retried = await api(`/submissions/${submissionId}/video/retry`, ownerToken, {
      method: 'POST',
    });
    expect(retried.status).toBe(202);
    expect(retried.body.video).toMatchObject({status: 'queued', processingAttempt: 2});
    const second = await claimVideoProcessingAttempt(env.DB, video.id, 2, 1);
    if (second.status !== 'claimed') throw new Error('retry was not claimed');
    expect(second.outputKey).not.toBe(first.outputKey);
    expect(
      await publishVideoProcessingAttempt(
        env.DB,
        video.id,
        1,
        first.outputKey,
        canonicalResult,
      ),
    ).toBe(false);

    await env.VIDEOS.put(second.outputKey, 'retained current derivative');
    const retired = await api(`/submissions/${submissionId}/video`, ownerToken, {
      method: 'DELETE',
      body: {confirmed: true},
    });
    expect(retired.status).toBe(204);
    expect(
      await publishVideoProcessingAttempt(
        env.DB,
        video.id,
        2,
        second.outputKey,
        canonicalResult,
      ),
    ).toBe(false);
    expect(await env.VIDEOS.head(originalKey)).not.toBeNull();
    expect(await env.VIDEOS.head(first.outputKey)).not.toBeNull();
    expect(await env.VIDEOS.head(second.outputKey)).not.toBeNull();
  });

  it('serves authenticated canonical MP4 bytes with exact single-range semantics', async () => {
    const bytes = '0123456789';
    const ready = await publishReadyVideo(submissionId, ownerToken, bytes);

    const unauthorizedDescriptor = await SELF.fetch(
      `${base}/videos/${ready.video.id}/playback`,
    );
    const unauthorizedContent = await SELF.fetch(
      `${base}/videos/${ready.video.id}/content`,
    );
    expect(unauthorizedDescriptor.status).toBe(401);
    expect(unauthorizedContent.status).toBe(401);

    const descriptor = await api(`/videos/${ready.video.id}/playback`, ownerToken);
    expect(descriptor.status).toBe(200);
    expect(descriptor.body).toEqual({
      source: {kind: 'mp4', url: `/api/videos/${ready.video.id}/content`},
      expiresAt: null,
    });
    expect(descriptor.headers.get('cache-control')).toBe('private, no-store');

    const full = await fetchVideoContent(ready.video.id, ownerToken);
    expect(full.status).toBe(200);
    expect(await responseText(full)).toBe(bytes);
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe('10');
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('content-disposition')).toBe('inline');
    expect(full.headers.get('cache-control')).toBe('private, no-store');
    expect(full.headers.get('etag')).toBeTruthy();

    for (const [range, body, contentRange] of [
      ['bytes=2-5', '2345', 'bytes 2-5/10'],
      ['bytes=7-', '789', 'bytes 7-9/10'],
      ['bytes=-3', '789', 'bytes 7-9/10'],
      ['bytes=0-99', bytes, 'bytes 0-9/10'],
    ]) {
      const partial = await fetchVideoContent(ready.video.id, ownerToken, range);
      expect(partial.status, range).toBe(206);
      expect(await responseText(partial), range).toBe(body);
      expect(partial.headers.get('content-range'), range).toBe(contentRange);
      expect(partial.headers.get('content-length'), range).toBe(String(body.length));
      expect(partial.headers.get('accept-ranges'), range).toBe('bytes');
    }

    for (const range of [
      'bytes=10-',
      'bytes=5-2',
      'bytes=-0',
      'bytes=',
      'items=0-1',
      'bytes=0-1,3-4',
    ]) {
      const rejected = await fetchVideoContent(ready.video.id, ownerToken, range);
      expect(rejected.status, range).toBe(416);
      expect(rejected.headers.get('content-range'), range).toBe('bytes */10');
      expect(rejected.headers.get('accept-ranges'), range).toBe('bytes');
      expect(await responseText(rejected), range).toBe('');
    }
  });

  it('enforces visibility on metadata, playback links, and range content', async () => {
    const {video} = await publishReadyVideo(submissionId, ownerToken, 'private demo');
    const paths = [
      `/submissions/${submissionId}/video`,
      `/videos/${video.id}/playback`,
      `/videos/${video.id}/content`,
    ];
    await env.DB.prepare('UPDATE submissions SET is_hidden = 1 WHERE id = ?')
      .bind(submissionId)
      .run();
    const admin = await userCookie(`admin-${suffix}`);
    await env.DB.prepare('UPDATE users SET is_admin = 1 WHERE id = ?')
      .bind(admin.id)
      .run();
    for (const path of paths) {
      expect((await SELF.fetch(`${base}${path}`)).status).toBe(401);
      expect(
        (
          await SELF.fetch(`${base}${path}`, {
            headers: {Cookie: outsiderToken, Range: 'bytes=0-2'},
          })
        ).status,
      ).toBe(404);
      expect(
        (await SELF.fetch(`${base}${path}`, {headers: {Cookie: ownerToken}})).status,
      ).toBe(200);
      expect(
        (await SELF.fetch(`${base}${path}`, {headers: {Cookie: admin.cookie}})).status,
      ).toBe(200);
    }
    const deleted = await api(
      `/events/${eventId}/submissions/${submissionId}`,
      ownerToken,
      {method: 'DELETE'},
    );
    expect(deleted.status).toBe(204);
    for (const path of paths) {
      expect(
        (await SELF.fetch(`${base}${path}`, {headers: {Cookie: admin.cookie}})).status,
      ).toBe(404);
    }
  });

  it('fences processing and late upload completion when a submission is deleted', async () => {
    const {video, key} = await completeSmallUpload(
      submissionId,
      ownerToken,
      'durable original',
    );
    const claim = await claimVideoProcessingAttempt(env.DB, video.id, 1, 1);
    if (claim.status !== 'claimed') throw new Error('Expected claim');
    expect(await claimVideoProcessingAttempt(env.DB, video.id, 1, 1)).toEqual(claim);
    await api(`/events/${eventId}/submissions/${submissionId}`, ownerToken, {
      method: 'DELETE',
    });
    expect(
      await publishVideoProcessingAttempt(
        env.DB,
        video.id,
        1,
        claim.outputKey,
        canonicalResult,
      ),
    ).toBe(false);
    expect(
      await reportVideoProcessingProgress(env.DB, video.id, 1, 'uploading', 100),
    ).toBe(false);
    expect(
      await env.DB.prepare(
        'SELECT status FROM video_processing_attempts WHERE video_id = ?',
      )
        .bind(video.id)
        .first('status'),
    ).toBe('cancelled');
    expect(await env.VIDEOS.head(key)).not.toBeNull();
    const fresh = await createSubmission('Deleted during upload');
    const created = await createUpload(fresh, ownerToken, 3);
    const uploadId = created.body.upload.uploadId;
    const part = await putPart(
      fresh,
      uploadId,
      1,
      new TextEncoder().encode('abc'),
      ownerToken,
    );
    await api(`/events/${eventId}/submissions/${fresh}`, ownerToken, {method: 'DELETE'});
    expect(
      (
        await api(`/submissions/${fresh}/video/upload/${uploadId}/complete`, ownerToken, {
          method: 'POST',
          body: {parts: [part.body.part]},
        })
      ).status,
    ).toBe(404);
    expect((await createUpload(fresh, ownerToken, 3)).status).toBe(404);
  });

  it('scopes container storage and verifies immutable derivative checksums', async () => {
    const {video} = await completeSmallUpload(submissionId, ownerToken, 'source');
    const claim = await claimVideoProcessingAttempt(env.DB, video.id, 1, 1);
    if (claim.status !== 'claimed') throw new Error('Expected claim');
    const context = {
      containerId: 'test',
      className: 'VideoProcessorContainer',
      params: {videoId: video.id, attempt: 1},
    };
    const headers = {'x-video-id': video.id, 'x-video-attempt': '1'};
    await expect(
      videoR2Handler(new Request('http://video-r2/source'), env, context),
    ).rejects.toThrow('scope');
    const source = await videoR2Handler(
      new Request('http://video-r2/source', {headers}),
      env,
      context,
    );
    expect(await source.text()).toBe('source');
    const bytes = new TextEncoder().encode('canonical');
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    const sha256 = Array.from(new Uint8Array(digest), (byte) =>
      byte.toString(16).padStart(2, '0'),
    ).join('');
    const output = (checksum: string) =>
      new Request('http://video-r2/output', {
        method: 'PUT',
        headers: {...headers, 'x-content-sha256': checksum},
        body: bytes,
      });
    expect((await videoR2Handler(output('b'.repeat(64)), env, context)).status).toBe(500);
    expect(await env.VIDEOS.head(claim.outputKey)).toBeNull();
    expect((await videoR2Handler(output(sha256), env, context)).status).toBe(201);
    expect((await videoR2Handler(output(sha256), env, context)).status).toBe(204);
    expect((await videoR2Handler(output('b'.repeat(64)), env, context)).status).toBe(409);
    await api(`/events/${eventId}/submissions/${submissionId}`, ownerToken, {
      method: 'DELETE',
    });
    expect(
      (
        await videoR2Handler(
          new Request('http://video-r2/source', {headers}),
          env,
          context,
        )
      ).status,
    ).toBe(409);
  });

  it('rejects cross-origin upload mutations before allocating storage', async () => {
    const response = await SELF.fetch(
      `${base}/submissions/${submissionId}/video/upload`,
      {
        method: 'POST',
        headers: {
          Cookie: ownerToken,
          Origin: 'https://evil.example',
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          fileName: 'demo.mp4',
          fileSize: 3,
          contentType: 'video/mp4',
        }),
      },
    );
    expect(response.status).toBe(403);
    expect(
      await env.DB.prepare('SELECT COUNT(*) FROM video_uploads').first('COUNT(*)'),
    ).toBe(0);
  });

  it('limits local processing to one while independent submissions remain queued', async () => {
    const leftProject = await createSubmission('Processor left');
    const rightProject = await createSubmission('Processor right');
    const left = await completeSmallUpload(leftProject, ownerToken, 'left source');
    const right = await completeSmallUpload(rightProject, ownerToken, 'right source');

    const claimed = await claimVideoProcessingAttempt(env.DB, left.video.id, 1, 1);
    expect(claimed.status).toBe('claimed');
    await expect(
      claimVideoProcessingAttempt(env.DB, right.video.id, 1, 1),
    ).resolves.toEqual({status: 'capacity'});
    expect(
      await env.DB.prepare('SELECT status FROM video_submissions WHERE id = ?')
        .bind(right.video.id)
        .first('status'),
    ).toBe('queued');

    await failVideoProcessingAttempt(env.DB, left.video.id, 1, 'fixture release');
    expect(await claimVideoProcessingAttempt(env.DB, right.video.id, 1, 1)).toMatchObject(
      {
        status: 'claimed',
      },
    );
  });
});

const canonicalResult: VideoProcessorResult = {
  durationSeconds: 2,
  width: 1280,
  height: 720,
  videoCodec: 'h264',
  audioCodec: 'aac',
  pixelFormat: 'yuv420p',
  loudnessLufs: -16,
  loudnessTargetLufs: -16,
  loudnessToleranceLu: 0.7,
  audioMode: 'normalized',
  fastStart: true,
  sha256: 'a'.repeat(64),
};

async function publishReadyVideo(project: string, token: string, bytes: string) {
  const completed = await completeSmallUpload(project, token, bytes);
  const claim = await claimVideoProcessingAttempt(env.DB, completed.video.id, 1, 1);
  if (claim.status !== 'claimed') throw new Error('attempt was not claimed');
  await env.VIDEOS.put(claim.outputKey, bytes, {
    httpMetadata: {contentType: 'video/mp4'},
  });
  expect(
    await publishVideoProcessingAttempt(env.DB, completed.video.id, 1, claim.outputKey, {
      ...canonicalResult,
      durationSeconds: bytes.length,
    }),
  ).toBe(true);
  return {...completed, outputKey: claim.outputKey};
}

function fetchVideoContent(videoId: string, token: string, range?: string) {
  const headers = new Headers({Cookie: token});
  if (range) headers.set('Range', range);
  return SELF.fetch(`${base}/videos/${videoId}/content`, {headers});
}

async function responseText(response: Response) {
  return new TextDecoder().decode(await response.arrayBuffer());
}

async function expireUpload(uploadId: string) {
  await env.DB.prepare(
    `UPDATE video_uploads SET expires_at = '2000-01-01T00:00:00.000Z' WHERE id = ?`,
  )
    .bind(uploadId)
    .run();
}

async function uploadStorage(uploadId: string) {
  const upload = await env.DB.prepare(
    `SELECT original_r2_key, r2_upload_id FROM video_uploads WHERE id = ?`,
  )
    .bind(uploadId)
    .first<{original_r2_key: string; r2_upload_id: string}>();
  if (!upload) throw new Error('upload storage fixture is missing');
  return upload;
}

async function completeSmallUpload(project: string, token: string, bytes: string) {
  const created = await createUpload(project, token, bytes.length);
  expect(created.status).toBe(201);
  const uploadId = created.body.upload.uploadId;
  const part = await putPart(
    project,
    uploadId,
    1,
    new TextEncoder().encode(bytes),
    token,
  );
  expect(part.status).toBe(200);
  const completed = await api(
    `/submissions/${project}/video/upload/${uploadId}/complete`,
    token,
    {
      method: 'POST',
      body: {
        parts: [{partNumber: 1, etag: part.body.part.etag}],
      },
    },
  );
  expect(completed.status).toBe(200);
  const stored = await env.DB.prepare(
    'SELECT original_r2_key FROM video_submissions WHERE id = ?',
  )
    .bind(completed.body.video.id)
    .first<{original_r2_key: string}>();
  return {video: completed.body.video, key: stored!.original_r2_key};
}

function createUpload(project: string, token: string, fileSize: number) {
  return api(`/submissions/${project}/video/upload`, token, {
    method: 'POST',
    body: {fileName: 'demo.mp4', fileSize, contentType: 'video/mp4'},
  });
}

async function putPart(
  project: string,
  uploadId: string,
  partNumber: number,
  body: Uint8Array,
  token: string,
) {
  const payload =
    body.buffer instanceof ArrayBuffer
      ? body.buffer.slice(body.byteOffset, body.byteOffset + body.byteLength)
      : Uint8Array.from(body).buffer;
  const response = await SELF.fetch(
    `${base}/submissions/${project}/video/upload/${uploadId}/parts/${partNumber}`,
    {
      method: 'PUT',
      headers: {
        Cookie: token,
        Origin: 'https://showntell.test',
        'Content-Type': 'application/octet-stream',
        'Content-Length': String(body.byteLength),
      },
      body: payload,
    },
  );
  return parseResponse(response);
}

async function createSubmission(title: string) {
  const response = await api(`/events/${eventId}/submissions`, ownerToken, {
    method: 'POST',
    body: {title, description: '', projectUrl: 'https://example.com'},
  });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.submission.id;
}

async function api(
  path: string,
  token: string,
  options: {method?: string; body?: JsonInput} = {},
) {
  const headers = new Headers({Cookie: token});
  if (options.method && options.method !== 'GET') {
    headers.set('Origin', 'https://showntell.test');
  }
  if (options.body !== undefined) headers.set('Content-Type', 'application/json');
  const response = await SELF.fetch(`${base}${path}`, {
    method: options.method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  return parseResponse(response);
}

async function parseResponse(response: Response) {
  const body = response.status === 204 ? null : await response.json<any>();
  return {status: response.status, body, headers: response.headers};
}
