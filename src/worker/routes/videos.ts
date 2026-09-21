import {Hono, type Context} from 'hono';

import {
  isJsonNumber,
  isJsonObject,
  isJsonString,
  type JsonInput,
} from '../../shared/json';
import type {
  CompleteVideoUploadRequest,
  DirectUploadRequest,
  DirectUploadResponse,
  PlaybackResponse,
  SubmissionVideoResponse,
} from '../../shared/videos';
import type {WorkerEnv} from '../index';
import {errorResponse, ServiceError} from '../services/errors';
import {
  abortVideoUpload,
  completeVideoUpload,
  createMultipartVideoUpload,
  getSubmissionVideo,
  getVideoContent,
  getVideoUpload,
  issuePlayback,
  authorizeVideoRead,
  authorizeVideoPlayback,
  MAX_VIDEO_BYTES,
  retireSubmissionVideo,
  retrySubmissionVideo,
  uploadVideoPart,
  VideoRangeError,
} from '../services/videos';

export const videosRoutes = new Hono<WorkerEnv>();
export const submissionVideoRoutes = new Hono<WorkerEnv>();

videosRoutes.get('/:videoId/playback', async (c) => {
  try {
    await authorizeVideoPlayback(c.env.DB, c.req.param('videoId'), c.get('user'));
    const response: PlaybackResponse = await issuePlayback(
      c.env.DB,
      c.req.param('videoId'),
    );
    return c.json(response, 200, {'Cache-Control': 'private, no-store'});
  } catch (error) {
    return respondError(c, error);
  }
});

videosRoutes.get('/:videoId/content', async (c) => {
  try {
    await authorizeVideoPlayback(c.env.DB, c.req.param('videoId'), c.get('user'));
    const content = await getVideoContent(
      c.env.DB,
      c.env.VIDEOS,
      c.req.param('videoId'),
      c.req.header('Range'),
    );
    const headers = videoContentHeaders(content);
    return new Response(content.object.body, {
      status: content.range ? 206 : 200,
      headers,
    });
  } catch (error) {
    if (error instanceof VideoRangeError) {
      return new Response(null, {
        status: 416,
        headers: {
          'Accept-Ranges': 'bytes',
          'Content-Range': `bytes */${error.size}`,
          'Cache-Control': 'private, no-store',
        },
      });
    }
    return respondError(c, error);
  }
});

submissionVideoRoutes.get('/:submissionId/video', async (c) => {
  try {
    await authorizeVideoRead(c.env.DB, c.req.param('submissionId'), c.get('user'));
    const response: SubmissionVideoResponse = {
      video: await getSubmissionVideo(c.env.DB, c.req.param('submissionId')),
    };
    return c.json(response, 200, {'Cache-Control': 'private, no-store'});
  } catch (error) {
    return respondError(c, error);
  }
});

submissionVideoRoutes.post('/:submissionId/video/upload', async (c) => {
  try {
    const input = parseUpload(await c.req.json());
    const response: DirectUploadResponse = await createMultipartVideoUpload(
      c.env.DB,
      c.env.VIDEOS,
      c.req.param('submissionId'),
      c.get('user'),
      input,
    );
    return c.json(response, 201, {'Cache-Control': 'private, no-store'});
  } catch (error) {
    return respondError(c, error);
  }
});

submissionVideoRoutes.get('/:submissionId/video/upload/:uploadId', async (c) => {
  try {
    const response: DirectUploadResponse = await getVideoUpload(
      c.env.DB,
      c.env.VIDEOS,
      c.req.param('submissionId'),
      c.req.param('uploadId'),
      c.get('user'),
    );
    return c.json(response, 200, {'Cache-Control': 'private, no-store'});
  } catch (error) {
    return respondError(c, error);
  }
});

submissionVideoRoutes.put(
  '/:submissionId/video/upload/:uploadId/parts/:partNumber',
  async (c) => {
    try {
      const partNumber = parsePartNumber(c.req.param('partNumber'));
      const contentLength = parseContentLength(c.req.header('Content-Length'));
      const body = c.req.raw.body;
      if (!body) invalid('Video part body is required');
      const part = await uploadVideoPart(
        c.env.DB,
        c.env.VIDEOS,
        c.req.param('submissionId'),
        c.req.param('uploadId'),
        partNumber,
        contentLength,
        body,
        c.get('user'),
      );
      return c.json({part}, 200, {'Cache-Control': 'private, no-store'});
    } catch (error) {
      return respondError(c, error);
    }
  },
);

submissionVideoRoutes.post(
  '/:submissionId/video/upload/:uploadId/complete',
  async (c) => {
    try {
      const input = parseCompletion(await c.req.json());
      const video = await completeVideoUpload(
        c.env.DB,
        c.env.VIDEOS,
        String(c.env.VIDEO_PROCESSING_AUTOSTART) === 'false'
          ? null
          : c.env.VIDEO_PROCESSING_WORKFLOW,
        c.req.param('submissionId'),
        c.req.param('uploadId'),
        input.parts,
        c.get('user'),
      );
      return c.json({video}, 200, {'Cache-Control': 'private, no-store'});
    } catch (error) {
      return respondError(c, error);
    }
  },
);

submissionVideoRoutes.post('/:submissionId/video/retry', async (c) => {
  try {
    const video = await retrySubmissionVideo(
      c.env.DB,
      String(c.env.VIDEO_PROCESSING_AUTOSTART) === 'false'
        ? null
        : c.env.VIDEO_PROCESSING_WORKFLOW,
      c.req.param('submissionId'),
      c.get('user'),
    );
    return c.json({video}, 202, {'Cache-Control': 'private, no-store'});
  } catch (error) {
    return respondError(c, error);
  }
});

submissionVideoRoutes.delete('/:submissionId/video/upload/:uploadId', async (c) => {
  try {
    await abortVideoUpload(
      c.env.DB,
      c.env.VIDEOS,
      c.req.param('submissionId'),
      c.req.param('uploadId'),
      c.get('user'),
    );
    return c.body(null, 204);
  } catch (error) {
    return respondError(c, error);
  }
});

submissionVideoRoutes.delete('/:submissionId/video', async (c) => {
  try {
    const confirmed = parseRetirement(await c.req.json());
    await retireSubmissionVideo(
      c.env.DB,
      c.req.param('submissionId'),
      c.get('user'),
      confirmed,
    );
    return c.body(null, 204);
  } catch (error) {
    return respondError(c, error);
  }
});

function parseUpload(value: JsonInput): DirectUploadRequest {
  if (!isJsonObject(value)) invalid('Request body must be an object');
  if (
    !isJsonString(value.fileName) ||
    value.fileName.trim().length === 0 ||
    value.fileName.trim().length > 255 ||
    Array.from(value.fileName).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    invalid('File name is invalid');
  }
  if (
    !isJsonNumber(value.fileSize) ||
    !Number.isSafeInteger(value.fileSize) ||
    value.fileSize <= 0 ||
    value.fileSize > MAX_VIDEO_BYTES
  ) {
    invalid(`File size must be between 1 byte and ${`${MAX_VIDEO_BYTES} bytes`}`);
  }
  const fileName = value.fileName.trim();
  return {
    fileName,
    fileSize: value.fileSize,
    contentType: normalizeVideoContentType(value.contentType, fileName),
  };
}

function normalizeVideoContentType(value: JsonInput, fileName: string) {
  if (value === null) return null;
  if (
    !isJsonString(value) ||
    value.length > 255 ||
    Array.from(value).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  ) {
    invalid('Content type is invalid');
  }
  const mediaType = value.split(';', 1)[0].trim().toLowerCase();
  if (/^video\/[a-zA-Z0-9!#$&^_.+-]{1,100}$/.test(mediaType)) return mediaType;
  if (/\.(?:3g2|3gp|avi|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|webm)$/i.test(fileName)) {
    return null;
  }
  invalid('File must be a recognized video');
}

function parseCompletion(value: JsonInput): CompleteVideoUploadRequest {
  if (!isJsonObject(value)) invalid('Request body must be an object');
  const {parts} = value;
  if (!Array.isArray(parts) || parts.length === 0 || parts.length > 10_000) {
    invalid('Completed parts are required');
  }
  const parsed = parts.map((part) => {
    if (!isJsonObject(part)) invalid('Completed part is invalid');
    if (
      !isJsonNumber(part.partNumber) ||
      !Number.isInteger(part.partNumber) ||
      part.partNumber < 1 ||
      part.partNumber > 10_000 ||
      !isJsonString(part.etag) ||
      !part.etag ||
      part.etag.length > 256
    ) {
      invalid('Completed part is invalid');
    }
    return {partNumber: part.partNumber, etag: part.etag};
  });
  parsed.sort((left, right) => left.partNumber - right.partNumber);
  if (new Set(parsed.map((part) => part.partNumber)).size !== parsed.length) {
    invalid('Completed part numbers must be unique');
  }
  return {parts: parsed};
}

function parseRetirement(value: JsonInput) {
  if (!isJsonObject(value)) invalid('Request body must be an object');
  return value.confirmed === true;
}

function videoContentHeaders(content: {
  object: R2ObjectBody;
  range: {start: number; end: number; length: number} | null;
  size: number;
  etag: string;
}) {
  const headers = new Headers();
  headers.set('Accept-Ranges', 'bytes');
  headers.set('Cache-Control', 'private, no-store');
  headers.set('Content-Disposition', 'inline');
  headers.set('Content-Type', 'video/mp4');
  headers.set('ETag', content.etag);
  headers.set('X-Content-Type-Options', 'nosniff');
  if (content.range) {
    headers.set(
      'Content-Range',
      `bytes ${content.range.start}-${content.range.end}/${content.size}`,
    );
    headers.set('Content-Length', String(content.range.length));
  } else {
    headers.set('Content-Length', String(content.size));
  }
  return headers;
}

function parsePartNumber(value: string) {
  if (!/^\d+$/.test(value)) invalid('Part number is invalid');
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1 || number > 10_000) {
    invalid('Part number is invalid');
  }
  return number;
}

function parseContentLength(value: string | undefined) {
  if (!value || !/^\d+$/.test(value)) invalid('Content-Length is required');
  const length = Number(value);
  if (!Number.isSafeInteger(length) || length <= 0) invalid('Content-Length is invalid');
  return length;
}

function invalid(message: string): never {
  throw new ServiceError('VALIDATION_FAILED', message, 400);
}

function respondError(c: Context<WorkerEnv>, cause: unknown) {
  const result = errorResponse(cause);
  return c.json(result.response, result.status);
}
