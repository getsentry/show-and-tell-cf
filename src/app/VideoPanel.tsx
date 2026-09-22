import {useCallback, useEffect, useRef, useState} from 'react';

import type {Submission} from '../shared/events';
import type {
  DirectUploadResponse,
  PlaybackResponse,
  SubmissionVideo,
  SubmissionVideoResponse,
  VideoProcessingStage,
  VideoUploadSession,
} from '../shared/videos';
import {api, errorMessage, json} from './api';
import {
  checkRememberedFile,
  forgetFile,
  formatDuration,
  rememberFile,
  uploadParts,
  uploadPath,
  validateVideo,
  VIDEO_ACCEPT,
} from './video-upload';

type Operation = 'uploading' | 'completing' | 'updating' | null;
const stages = {
  waiting_for_processor: 'Waiting for a processor',
  downloading: 'Reading your video',
  inspecting: 'Checking the video',
  analyzing_audio: 'Analyzing audio',
  transcoding: 'Encoding video',
  checking_output: 'Checking the result',
  correcting_loudness: 'Balancing audio',
  finalizing: 'Finalizing video',
  uploading: 'Saving the processed video',
} satisfies Record<VideoProcessingStage, string>;

/** Mounted with the submission ID as its key: no state leaks across playlist changes. */
export function VideoPanel({
  submission,
  canManage,
}: {
  submission: Submission;
  canManage: boolean;
}) {
  const [video, setVideo] = useState<SubmissionVideo | null>(null);
  const [upload, setUpload] = useState<VideoUploadSession | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [operation, setOperation] = useState<Operation>(null);
  const [bytes, setBytes] = useState(0);
  const [notice, setNotice] = useState<string | null>(null);
  const [source, setSource] = useState<string | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [inputKey, setInputKey] = useState(0);
  const active = useRef<AbortController | null>(null);
  const reading = useRef<AbortController | null>(null);
  const mounted = useRef(false);
  const base = `/submissions/${encodeURIComponent(submission.id)}/video`;

  const refresh = useCallback(async () => {
    reading.current?.abort();
    const controller = new AbortController();
    reading.current = controller;
    try {
      const [result, pending] = await Promise.all([
        api<SubmissionVideoResponse>(base, {signal: controller.signal}),
        canManage
          ? api<{upload: VideoUploadSession | null}>(uploadPath(submission.id), {
              signal: controller.signal,
            })
          : Promise.resolve({upload: null}),
      ]);
      if (controller.signal.aborted || !mounted.current) return;
      setVideo(result.video);
      setUpload(pending.upload);
      setLoaded(true);
      setLoadError(null);
    } catch (cause) {
      if (!controller.signal.aborted && mounted.current)
        setLoadError(errorMessage(cause));
    } finally {
      if (reading.current === controller) reading.current = null;
    }
  }, [base, canManage, submission.id]);

  useEffect(() => {
    mounted.current = true;
    void refresh();
    return () => {
      mounted.current = false;
      reading.current?.abort();
      active.current?.abort();
    };
  }, [refresh]);

  useEffect(() => {
    if (
      operation ||
      !loaded ||
      loadError ||
      video?.status === 'ready' ||
      video?.status === 'failed'
    )
      return;
    const timer = window.setInterval(() => {
      if (!reading.current && !active.current) void refresh();
    }, 5000);
    return () => window.clearInterval(timer);
  }, [operation, loaded, loadError, video, upload, refresh]);

  useEffect(() => {
    if (!operation) return;
    const warn = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = '';
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [operation]);

  async function perform(
    kind: Exclude<Operation, null>,
    work: (signal: AbortSignal) => Promise<void>,
  ) {
    if (active.current) return;
    const controller = new AbortController();
    active.current = controller;
    reading.current?.abort();
    setOperation(kind);
    setActionError(null);
    setNotice(null);
    try {
      await work(controller.signal);
    } catch (cause) {
      if (mounted.current) {
        if (controller.signal.aborted)
          setNotice(
            'Upload paused. Completed parts are saved; resume with the original file.',
          );
        else setActionError(errorMessage(cause));
      }
    } finally {
      // Keep controls locked until reconciliation finishes; a lost POST response must
      // not allow another create against stale "no upload" state.
      if (mounted.current) await refresh();
      active.current = null;
      if (mounted.current) setOperation(null);
    }
  }

  function chooseFile(next: File | undefined) {
    setActionError(null);
    setNotice(null);
    setFile(null);
    if (!next) return;
    try {
      validateVideo(next);
      if (
        upload &&
        (next.name.trim() !== upload.fileName ||
          next.size !== upload.fileSize ||
          !checkRememberedFile(upload.uploadId, next))
      ) {
        throw new Error(
          `Select the original file (${upload.fileName}) to resume, or discard this upload to choose another.`,
        );
      }
      setFile(next);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  function startUpload() {
    void perform('uploading', async (signal) => {
      let session = upload;
      if (session) {
        const current = await api<DirectUploadResponse>(
          uploadPath(submission.id, session.uploadId),
          {signal},
        );
        session = current.upload;
        if (session.status === 'completed') {
          // Repeat completion to recover an interrupted Workflow handoff.
          await api(`${uploadPath(submission.id, session.uploadId)}/complete`, {
            ...json('POST', {parts: session.completedParts}),
            signal,
          });
          forgetFile(session.uploadId);
          return;
        }
        if (
          session.status === 'expired' ||
          session.status === 'aborted' ||
          session.status === 'expiring'
        ) {
          forgetFile(session.uploadId);
          throw new Error(
            'This upload expired or was discarded. Choose your video and start a new upload.',
          );
        }
        if (session.status === 'creating')
          throw new Error(
            'The upload is still being prepared. Wait a moment and refresh its status.',
          );
      } else {
        if (!file) throw new Error('Choose a video first.');
        validateVideo(file);
        const result = await api<DirectUploadResponse>(uploadPath(submission.id), {
          ...json('POST', {
            fileName: file.name,
            fileSize: file.size,
            contentType: file.type || null,
          }),
          signal,
        });
        session = result.upload;
        rememberFile(session.uploadId, file);
      }
      if (!mounted.current || signal.aborted) return;
      setUpload(session);
      await uploadParts(
        session,
        file,
        signal,
        (sent) => {
          if (mounted.current) setBytes(sent);
        },
        () => {
          if (mounted.current) setOperation('completing');
        },
      );
      forgetFile(session.uploadId);
      if (mounted.current) {
        setFile(null);
        setInputKey((key) => key + 1);
        setNotice('Upload saved. Processing continues even if you leave this page.');
      }
    });
  }

  function discardUpload() {
    if (!upload) return;
    void perform('updating', async (signal) => {
      const current = await api<DirectUploadResponse>(
        uploadPath(submission.id, upload.uploadId),
        {signal},
      );
      if (!['expired', 'aborted'].includes(current.upload.status)) {
        await api(uploadPath(submission.id, upload.uploadId), {method: 'DELETE', signal});
      }
      forgetFile(upload.uploadId);
      if (mounted.current) {
        setFile(null);
        setInputKey((key) => key + 1);
        setNotice('Upload discarded. Your submission is still saved.');
      }
    });
  }

  const allPartsUploaded =
    !!upload &&
    upload.completedParts.length === Math.ceil(upload.fileSize / upload.partSize);
  const busy = operation !== null;
  const expired = !!upload && Date.parse(upload.expiresAt) <= Date.now();
  const totalBytes = upload?.fileSize ?? file?.size ?? 0;
  const progress = totalBytes ? Math.min(100, Math.floor((100 * bytes) / totalBytes)) : 0;
  const id = `video-${submission.id}`;

  return (
    <section className="videoPanel" aria-label={`Video for ${submission.title}`}>
      {loadError ? (
        <div className="inlineError" role="alert">
          {loadError}{' '}
          <button disabled={busy} onClick={() => void refresh()}>
            Refresh video status
          </button>
        </div>
      ) : null}
      {actionError ? (
        <div className="inlineError" role="alert">
          {actionError}
        </div>
      ) : null}
      {notice ? (
        <p className="formHint" role="status">
          {notice}
        </p>
      ) : null}
      {!loaded ? (
        loadError ? null : (
          <p className="formHint">Loading video…</p>
        )
      ) : video ? (
        <>
          <div className="videoStatusRow">
            <span className={`tag tag--${video.status}`}>
              {video.status === 'ready'
                ? 'Ready to watch'
                : video.status === 'failed'
                  ? 'Processing failed'
                  : video.status === 'queued'
                    ? 'Queued for processing'
                    : 'Processing'}
            </span>
            {video.durationSeconds !== null ? (
              <span>{formatDuration(video.durationSeconds)}</span>
            ) : null}
          </div>
          <p className="fileName">{video.originalName}</p>
          {video.status === 'processing' ? (
            <div className="uploadProgress" role="status">
              <p className="formHint">
                {video.processingStage
                  ? stages[video.processingStage]
                  : 'Preparing your video'}
                {video.processingProgress !== null
                  ? ` · ${Math.round(video.processingProgress)}%`
                  : ''}
              </p>
              <progress
                aria-label="Processing progress"
                max={100}
                value={video.processingProgress ?? undefined}
              />
            </div>
          ) : null}
          {video.status === 'queued' ? (
            <p className="formHint">
              Your upload is saved. Processing will continue in the background.
            </p>
          ) : null}
          {video.status === 'failed' ? (
            <p className="inlineError">
              {video.errorMessage || 'We could not process this video.'} Your submission
              is safe. Retry processing or remove the video to upload another file.
            </p>
          ) : null}
          {video.status === 'ready' ? (
            source ? (
              <video
                className="videoPreview"
                src={source}
                controls
                playsInline
                preload="metadata"
                aria-label={submission.title}
                onError={() => {
                  setSource(null);
                  setActionError(
                    'Playback failed. Try Watch video again, or sign in if your session expired.',
                  );
                }}
              />
            ) : (
              <button
                className="textAction"
                disabled={busy}
                onClick={() =>
                  void perform('updating', async (signal) => {
                    const result = await api<PlaybackResponse>(
                      `/videos/${encodeURIComponent(video.id)}/playback`,
                      {signal},
                    );
                    if (mounted.current && !signal.aborted) setSource(result.source.url);
                  })
                }
              >
                Watch video
              </button>
            )
          ) : null}
          {canManage ? (
            <div className="videoActions">
              {video.status === 'failed' || video.status === 'queued' ? (
                <button
                  disabled={busy}
                  onClick={() =>
                    void perform('updating', async (signal) => {
                      await api(`${base}/retry`, {...json('POST', {}), signal});
                    })
                  }
                >
                  {video.status === 'failed'
                    ? 'Retry processing'
                    : 'Restart queued processing'}
                </button>
              ) : null}
              {confirmRemove ? (
                <div className="confirmAction">
                  <p>
                    Remove this video? Processing will stop and playback will be
                    unavailable. The submission stays saved.
                  </p>
                  <button
                    disabled={busy}
                    onClick={() =>
                      void perform('updating', async (signal) => {
                        await api(base, {...json('DELETE', {confirmed: true}), signal});
                        if (mounted.current) {
                          setSource(null);
                          setConfirmRemove(false);
                          setFile(null);
                        }
                      })
                    }
                  >
                    Confirm remove video
                  </button>
                  <button disabled={busy} onClick={() => setConfirmRemove(false)}>
                    Keep video
                  </button>
                </div>
              ) : (
                <button disabled={busy} onClick={() => setConfirmRemove(true)}>
                  Remove video
                </button>
              )}
            </div>
          ) : null}
        </>
      ) : canManage ? (
        <>
          <p className="formHint">
            {upload
              ? `Unfinished upload: ${upload.fileName}`
              : 'Submission saved. Add your video when you’re ready.'}
          </p>
          {upload ? (
            <p className="formHint">
              {expired
                ? 'Upload expired. Discard it to start again.'
                : 'Select the original file to resume. Completed parts are kept for up to 24 hours.'}
            </p>
          ) : null}
          {!allPartsUploaded && !expired ? (
            <label className="filePicker" htmlFor={id}>
              {upload ? 'Select original video' : 'Choose video'}
              <input
                key={inputKey}
                id={id}
                type="file"
                accept={VIDEO_ACCEPT}
                disabled={busy || !!loadError}
                onChange={(event) => chooseFile(event.currentTarget.files?.[0])}
                aria-describedby={`${id}-hint`}
              />
            </label>
          ) : null}
          <p id={`${id}-hint`} className="formHint">
            Up to 5 GiB · 10 minutes maximum · MP4, MOV, WebM and other video formats.
          </p>
          {operation === 'uploading' || operation === 'completing' ? (
            <div className="uploadProgress" role="status">
              <p>
                {operation === 'completing'
                  ? 'Saving upload…'
                  : `Uploading · ${progress}% saved`}
              </p>
              <progress
                aria-label="Upload progress"
                value={bytes}
                max={totalBytes || 1}
              />
              <p className="formHint">Progress updates after each completed part.</p>
            </div>
          ) : null}
          <div className="videoActions">
            <button
              className="primaryAction"
              disabled={busy || !!loadError || expired || (!file && !allPartsUploaded)}
              onClick={startUpload}
            >
              {allPartsUploaded
                ? 'Finish upload'
                : upload
                  ? 'Resume upload'
                  : 'Upload video'}
            </button>
            {operation === 'uploading' ? (
              <button onClick={() => active.current?.abort()}>Pause upload</button>
            ) : null}
            {upload ? (
              <button disabled={busy || !!loadError} onClick={discardUpload}>
                Discard upload
              </button>
            ) : null}
          </div>
        </>
      ) : (
        <p className="formHint">Video not uploaded yet.</p>
      )}
    </section>
  );
}
