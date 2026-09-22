import '@testing-library/jest-dom/vitest';
import {act, cleanup, fireEvent, render, screen, waitFor} from '@testing-library/react';
import {afterEach, describe, expect, it, vi} from 'vitest';

import {VideoPanel} from '../../src/app/VideoPanel';
import {rememberFile, uploadParts, validateVideo} from '../../src/app/video-upload';
import type {Submission} from '../../src/shared/events';
import type {SubmissionVideo, VideoUploadSession} from '../../src/shared/videos';

const submission: Submission = {
  id: 'submission-1',
  eventId: 'event-1',
  creatorId: 'owner',
  creatorAvatarUrl: null,
  creatorName: 'Owner',
  title: 'My demo',
  description: null,
  hidden: false,
  createdAt: '2026-09-21',
};
const session: VideoUploadSession = {
  uploadId: 'upload-1',
  videoId: 'video-1',
  submissionId: submission.id,
  fileName: 'demo.mp4',
  contentType: 'video/mp4',
  fileSize: 6,
  partSize: 3,
  expiresAt: '2099-01-01T00:00:00Z',
  status: 'uploading',
  completedParts: [],
};
const queued: SubmissionVideo = {
  id: 'video-1',
  submissionId: submission.id,
  originalName: 'demo.mp4',
  contentType: 'video/mp4',
  sizeBytes: 6,
  status: 'queued',
  durationSeconds: null,
  loudnessLufs: null,
  gainDb: null,
  errorMessage: null,
  failureStage: null,
  processingAttempt: 1,
  processingStage: null,
  processingProgress: null,
  createdAt: '2026-09-21',
};
const base = `/api/submissions/${submission.id}/video`;
const file = () =>
  new File(['abcdef'], 'demo.mp4', {type: 'video/mp4', lastModified: 123});

type TestResponse =
  | {video: SubmissionVideo | null; upload?: VideoUploadSession | null}
  | {upload: VideoUploadSession | null}
  | {part: {partNumber: number; etag: string; sizeBytes: number}}
  | {error: {message: string}}
  | {source: {kind: string; url: string}; expiresAt: null};

function response(body: TestResponse, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {'Content-Type': 'application/json'},
  });
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return {promise, resolve};
}
function setup(
  initialVideo: SubmissionVideo | null = null,
  initialUpload: VideoUploadSession | null = null,
) {
  const state = {video: initialVideo, upload: initialUpload};
  const fetcher = vi.fn(async (url: string, init?: RequestInit): Promise<Response> => {
    if (url === base && !init?.method) return response({video: state.video});
    if (url === `${base}/upload` && !init?.method)
      return response({upload: state.upload});
    if (url === `${base}/upload` && init?.method === 'POST') {
      state.upload = {...session, completedParts: []};
      return response({upload: state.upload, video: null}, 201);
    }
    if (url === `${base}/upload/upload-1` && !init?.method)
      return response({upload: state.upload, video: state.video});
    const part = url.match(/\/parts\/(\d+)$/);
    if (part && state.upload) {
      const stored = {partNumber: Number(part[1]), etag: `etag-${part[1]}`, sizeBytes: 3};
      state.upload = {
        ...state.upload,
        completedParts: [...state.upload.completedParts, stored],
      };
      return response({part: stored});
    }
    if (url.endsWith('/complete')) {
      state.video = queued;
      state.upload = null;
      return response({video: queued});
    }
    if (url === `${base}/retry`) {
      state.video = queued;
      return response({video: queued}, 202);
    }
    if (init?.method === 'DELETE') {
      state.upload = null;
      state.video = null;
      return new Response(null, {status: 204});
    }
    if (url.endsWith('/playback'))
      return response({
        source: {kind: 'mp4', url: '/api/videos/video-1/content'},
        expiresAt: null,
      });
    throw new Error(`Unexpected request: ${url}`);
  });
  vi.stubGlobal('fetch', fetcher);
  return {state, fetcher};
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.useRealTimers();
  localStorage.clear();
});

describe('video uploads', () => {
  it('uploads bounded parts, completes once, and displays the queued state', async () => {
    const {fetcher} = setup();
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.change(await screen.findByLabelText('Choose video'), {
      target: {files: [file()]},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Upload video'}));
    expect(await screen.findByText('Queued for processing')).toBeInTheDocument();
    const puts = fetcher.mock.calls.filter(([, init]) => init?.method === 'PUT');
    expect(puts.map(([url]) => url)).toEqual([
      `${base}/upload/upload-1/parts/1`,
      `${base}/upload/upload-1/parts/2`,
    ]);
    expect(puts.map(([, init]) => init?.body instanceof Blob && init.body.size)).toEqual([
      3, 3,
    ]);
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/complete'))).toHaveLength(
      1,
    );
    expect(
      screen.getByText(/Processing continues even if you leave/),
    ).toBeInTheDocument();
  });

  it('keeps upload controls locked until a failed create has reconciled', async () => {
    const {fetcher} = setup();
    const original = fetcher.getMockImplementation()!;
    const reconciliation = deferred<Response>();
    let pendingLoads = 0;
    fetcher.mockImplementation(async (url, init) => {
      if (url === `${base}/upload` && init?.method === 'POST')
        throw new Error('Disconnected');
      if (url === `${base}/upload` && !init?.method && ++pendingLoads > 1)
        return reconciliation.promise;
      return original(url, init);
    });
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.change(await screen.findByLabelText('Choose video'), {
      target: {files: [file()]},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Upload video'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Disconnected');
    expect(screen.getByRole('button', {name: 'Upload video'})).toBeDisabled();
    await act(async () => reconciliation.resolve(response({upload: session})));
    expect(screen.getByRole('button', {name: 'Resume upload'})).toBeEnabled();
  });

  it('recovers from a failed part without recreating the submission or upload', async () => {
    const {fetcher} = setup();
    const original = fetcher.getMockImplementation()!;
    let fail = true;
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith('/parts/2') && fail) {
        fail = false;
        return response({error: {message: 'Connection interrupted'}}, 503);
      }
      return original(url, init);
    });
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.change(await screen.findByLabelText('Choose video'), {
      target: {files: [file()]},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Upload video'}));
    expect(await screen.findByRole('alert')).toHaveTextContent('Connection interrupted');
    await waitFor(() =>
      expect(screen.getByRole('button', {name: 'Resume upload'})).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', {name: 'Resume upload'}));
    expect(await screen.findByText('Queued for processing')).toBeInTheDocument();
    expect(fetcher.mock.calls.filter(([url]) => url.endsWith('/parts/1'))).toHaveLength(
      1,
    );
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) => url === `${base}/upload` && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('discovers an upload after a lost create response', async () => {
    const {fetcher} = setup();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url === `${base}/upload` && init?.method === 'POST')
        throw new TypeError('Network interrupted');
      return result;
    });
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.change(await screen.findByLabelText('Choose video'), {
      target: {files: [file()]},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Upload video'}));
    await waitFor(() =>
      expect(screen.getByRole('button', {name: 'Resume upload'})).toBeEnabled(),
    );
    fireEvent.click(screen.getByRole('button', {name: 'Resume upload'}));
    expect(await screen.findByText('Queued for processing')).toBeInTheDocument();
    expect(
      fetcher.mock.calls.filter(
        ([url, init]) => url === `${base}/upload` && init?.method === 'POST',
      ),
    ).toHaveLength(1);
  });

  it('finishes a fully uploaded session after reload without selecting a file', async () => {
    const complete = {
      ...session,
      status: 'completing' as const,
      completedParts: [
        {partNumber: 1, etag: 'a', sizeBytes: 3},
        {partNumber: 2, etag: 'b', sizeBytes: 3},
      ],
    };
    const {fetcher} = setup(null, complete);
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.click(await screen.findByRole('button', {name: 'Finish upload'}));
    expect(await screen.findByText('Queued for processing')).toBeInTheDocument();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
  });

  it('reconciles a lost completion response and offers queued handoff recovery', async () => {
    const {fetcher} = setup();
    const original = fetcher.getMockImplementation()!;
    fetcher.mockImplementation(async (url, init) => {
      const result = await original(url, init);
      if (url.endsWith('/complete'))
        return response({error: {message: 'Workflow unavailable'}}, 503);
      return result;
    });
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.change(await screen.findByLabelText('Choose video'), {
      target: {files: [file()]},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Upload video'}));
    fireEvent.click(
      await screen.findByRole('button', {name: 'Restart queued processing'}),
    );
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => url === `${base}/retry`)).toBe(true),
    );
  });

  it('pauses and resumes without allowing duplicate transfers', async () => {
    const {fetcher} = setup();
    const original = fetcher.getMockImplementation()!;
    let pauseFirst = true;
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith('/parts/1') && pauseFirst) {
        pauseFirst = false;
        return new Promise((_resolve, reject) =>
          init?.signal?.addEventListener('abort', () =>
            reject(new DOMException('Aborted', 'AbortError')),
          ),
        );
      }
      return original(url, init);
    });
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.change(await screen.findByLabelText('Choose video'), {
      target: {files: [file()]},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Upload video'}));
    await waitFor(() =>
      expect(fetcher.mock.calls.some(([url]) => url.endsWith('/parts/1'))).toBe(true),
    );
    expect(screen.getByRole('button', {name: 'Resume upload'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name: 'Pause upload'}));
    await waitFor(() =>
      expect(screen.getByRole('button', {name: 'Resume upload'})).toBeEnabled(),
    );
    expect(screen.getByText(/Upload paused/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Resume upload'}));
    expect(await screen.findByText('Queued for processing')).toBeInTheDocument();
  });

  it('aborts the active request when switching away', async () => {
    const {fetcher} = setup();
    const original = fetcher.getMockImplementation()!;
    const part = deferred<Response>();
    let signal: AbortSignal | null | undefined;
    fetcher.mockImplementation(async (url, init) => {
      if (url.endsWith('/parts/1')) {
        signal = init?.signal;
        return part.promise;
      }
      return original(url, init);
    });
    const {unmount} = render(<VideoPanel submission={submission} canManage />);
    fireEvent.change(await screen.findByLabelText('Choose video'), {
      target: {files: [file()]},
    });
    fireEvent.click(screen.getByRole('button', {name: 'Upload video'}));
    await waitFor(() => expect(signal).toBeDefined());
    unmount();
    expect(signal?.aborted).toBe(true);
    await act(async () =>
      part.resolve(response({part: {partNumber: 1, etag: 'a', sizeBytes: 3}})),
    );
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/complete'))).toBe(false);
  });

  it('rejects invalid and mismatched files before sending bytes', async () => {
    const {fetcher} = setup(null, session);
    rememberFile(session.uploadId, file());
    render(<VideoPanel submission={submission} canManage />);
    const input = await screen.findByLabelText('Select original video');
    fireEvent.change(input, {
      target: {
        files: [new File(['abcdef'], 'demo.mp4', {type: 'video/mp4', lastModified: 456})],
      },
    });
    expect(screen.getByRole('alert')).toHaveTextContent('Select the original file');
    expect(screen.getByRole('button', {name: 'Resume upload'})).toBeDisabled();
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'PUT')).toBe(false);
    expect(() => validateVideo(new File([], 'empty.mp4'))).toThrow('1 byte');
    expect(() => validateVideo(new File(['x'], 'notes.txt'))).toThrow('video file');
  });

  it('lets expired uploads be discarded without deleting the submission', async () => {
    const {fetcher} = setup(null, {...session, expiresAt: '2000-01-01T00:00:00Z'});
    render(<VideoPanel submission={submission} canManage />);
    expect(await screen.findByRole('button', {name: 'Resume upload'})).toBeDisabled();
    fireEvent.click(screen.getByRole('button', {name: 'Discard upload'}));
    expect(await screen.findByLabelText('Choose video')).toBeInTheDocument();
    expect(
      fetcher.mock.calls
        .filter(([, init]) => init?.method === 'DELETE')
        .map(([url]) => url),
    ).toEqual([`${base}/upload/upload-1`]);
  });

  it('keeps polling when no video exists, then progresses through processing to ready', async () => {
    vi.useFakeTimers();
    const {state, fetcher} = setup();
    await act(async () => {
      render(<VideoPanel submission={submission} canManage />);
    });
    expect(screen.getByLabelText('Choose video')).toBeInTheDocument();
    // Null results must not stop the polling timer.
    await act(() => vi.advanceTimersByTimeAsync(10000));
    expect(
      fetcher.mock.calls.filter(([url]) => url === base).length,
    ).toBeGreaterThanOrEqual(3);
    state.video = {
      ...queued,
      status: 'processing',
      processingStage: 'transcoding',
      processingProgress: 45,
    };
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText('Encoding video · 45%')).toBeInTheDocument();
    state.video = {...queued, status: 'ready', durationSeconds: 125};
    await act(() => vi.advanceTimersByTimeAsync(5000));
    expect(screen.getByText('Ready to watch')).toBeInTheDocument();
    expect(screen.getByText('2:05')).toBeInTheDocument();
  });

  it('offers explicit recovery after status loading fails', async () => {
    const {fetcher} = setup();
    fetcher.mockRejectedValueOnce(new Error('Offline'));
    render(<VideoPanel submission={submission} canManage />);
    expect(await screen.findByRole('alert')).toHaveTextContent('Offline');
    expect(screen.queryByText('Loading video…')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Refresh video status'}));
    expect(await screen.findByLabelText('Choose video')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('retries failed processing and confirms removal separately', async () => {
    const {fetcher} = setup({
      ...queued,
      status: 'failed',
      errorMessage: 'Unreadable file',
    });
    render(<VideoPanel submission={submission} canManage />);
    fireEvent.click(await screen.findByRole('button', {name: 'Retry processing'}));
    expect(await screen.findByText('Queued for processing')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', {name: 'Remove video'}));
    expect(fetcher.mock.calls.some(([, init]) => init?.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', {name: 'Confirm remove video'}));
    expect(await screen.findByLabelText('Choose video')).toBeInTheDocument();
  });

  it('shows authenticated playback without upload controls for other members', async () => {
    const {fetcher} = setup({...queued, status: 'ready', durationSeconds: 90});
    render(<VideoPanel submission={submission} canManage={false} />);
    fireEvent.click(await screen.findByRole('button', {name: 'Watch video'}));
    await waitFor(() =>
      expect(screen.getByLabelText('My demo')).toHaveAttribute(
        'src',
        '/api/videos/video-1/content',
      ),
    );
    expect(screen.queryByRole('button', {name: 'Remove video'})).not.toBeInTheDocument();
    expect(fetcher.mock.calls.some(([url]) => url.endsWith('/upload'))).toBe(false);
  });

  it('does not complete an upload after its transfer is aborted', async () => {
    const {fetcher} = setup();
    const controller = new AbortController();
    controller.abort();
    await expect(
      uploadParts(
        session,
        file(),
        controller.signal,
        () => {},
        () => {},
      ),
    ).rejects.toThrow();
    expect(fetcher).not.toHaveBeenCalled();
  });
});
