import {
  MAX_VIDEO_BYTES,
  type SubmissionVideoResponse,
  type VideoUploadPart,
  type VideoUploadSession,
} from '../shared/videos';
import {api, json} from './api';

export const VIDEO_ACCEPT =
  'video/*,.3g2,.3gp,.avi,.m2ts,.m4v,.mkv,.mov,.mp4,.mpeg,.mpg,.mts,.ogv,.webm';

export function validateVideo(file: File) {
  if (!file.size || file.size > MAX_VIDEO_BYTES)
    throw new Error('Choose a video between 1 byte and 5 GiB.');
  if (
    !file.type.startsWith('video/') &&
    !/\.(3g2|3gp|avi|m2ts|m4v|mkv|mov|mp4|mpeg|mpg|mts|ogv|webm)$/i.test(file.name)
  ) {
    throw new Error('Choose a video file, such as MP4, MOV, or WebM.');
  }
}

export function uploadPath(submissionId: string, uploadId?: string) {
  return `/submissions/${encodeURIComponent(submissionId)}/video/upload${uploadId ? `/${encodeURIComponent(uploadId)}` : ''}`;
}

/** Adapted from Hack Week: stream one bounded Blob at a time, never the entire file. */
export async function uploadParts(
  session: VideoUploadSession,
  file: File | null,
  signal: AbortSignal,
  onProgress: (bytes: number) => void,
  onCompleting: () => void,
) {
  const parts = [...session.completedParts];
  const count = Math.ceil(session.fileSize / session.partSize);
  if (
    !Number.isSafeInteger(count) ||
    session.partSize <= 0 ||
    count < 1 ||
    count > 10000
  ) {
    throw new Error('Invalid upload session. Refresh and try again.');
  }
  const hasAllParts = parts.length === count;
  if (
    !hasAllParts &&
    (!file || file.name.trim() !== session.fileName || file.size !== session.fileSize)
  ) {
    throw new Error(
      `Select the original file (${session.fileName}) to resume, or discard this upload to choose another.`,
    );
  }
  onProgress(parts.reduce((sum, part) => sum + part.sizeBytes, 0));
  for (let partNumber = 1; partNumber <= count; partNumber++) {
    signal.throwIfAborted();
    if (parts.some((part) => part.partNumber === partNumber)) continue;
    if (!file) throw new Error('Select the original video file to continue.');
    const start = (partNumber - 1) * session.partSize;
    const {part} = await api<{part: VideoUploadPart}>(
      `${uploadPath(session.submissionId, session.uploadId)}/parts/${partNumber}`,
      {
        method: 'PUT',
        headers: {'Content-Type': 'application/octet-stream'},
        // The browser sets Content-Length from the Blob; do not set forbidden headers.
        body: file.slice(start, Math.min(file.size, start + session.partSize)),
        signal,
      },
    );
    parts.push(part);
    onProgress(parts.reduce((sum, stored) => sum + stored.sizeBytes, 0));
  }
  signal.throwIfAborted();
  onCompleting();
  return api<SubmissionVideoResponse>(
    `${uploadPath(session.submissionId, session.uploadId)}/complete`,
    {
      ...json('POST', {parts: parts.map(({partNumber, etag}) => ({partNumber, etag}))}),
      signal,
    },
  );
}

// A local lastModified check catches accidentally selecting a different revision with
// the same name/size. Server metadata remains authoritative for parts and permissions.
export function rememberFile(uploadId: string, file: File) {
  try {
    localStorage.setItem(`show-and-tell:upload:${uploadId}`, String(file.lastModified));
  } catch {
    /* Storage may be disabled. */
  }
}
export function checkRememberedFile(uploadId: string, file: File) {
  try {
    const modified = localStorage.getItem(`show-and-tell:upload:${uploadId}`);
    if (modified !== null && modified !== String(file.lastModified)) return false;
  } catch {
    /* Cross-device recovery relies on the selected original file. */
  }
  return true;
}
export function forgetFile(uploadId: string) {
  try {
    localStorage.removeItem(`show-and-tell:upload:${uploadId}`);
  } catch {
    /* Best effort. */
  }
}

export function formatDuration(seconds: number) {
  const rounded = Math.round(seconds);
  return `${Math.floor(rounded / 60)}:${String(rounded % 60).padStart(2, '0')}`;
}
