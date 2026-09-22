import {useEffect, useRef, useState} from 'react';

import type {PlaylistResponse} from '../shared/playlist';
import {playlistPath} from '../shared/playlist';
import type {PlaybackResponse} from '../shared/videos';
import {api, errorMessage} from './api';
import {createPlaylistController, type PlayerState} from './player/controller';

export function PlaylistPage({eventId}: {eventId: string}) {
  const [data, setData] = useState<PlaylistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void api<PlaylistResponse>(`/events/${encodeURIComponent(eventId)}/playlist`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) setData(result);
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [eventId, revision]);

  return (
    <main className="playlistPage">
      <header className="topbar">
        <a className="brand" href="/">
          Show &amp; Tell
        </a>
        <a href={`/?event=${encodeURIComponent(eventId)}`}>Back to submissions</a>
        <button onClick={() => setRevision((value) => value + 1)}>
          Refresh playlist
        </button>
      </header>
      {error ? (
        <div className="authError" role="alert">
          {error}{' '}
          <button onClick={() => setRevision((value) => value + 1)}>Retry loading</button>
        </div>
      ) : data ? (
        <>
          <header className="playlistHeader">
            <p className="eyebrow">Company screening</p>
            <h1>{data.event.title}</h1>
            {data.event.description ? <p>{data.event.description}</p> : null}
            <SharePlaylist eventId={eventId} />
          </header>
          {data.items.length ? (
            <PlaylistPlayer key={`${eventId}-${revision}`} data={data} />
          ) : (
            <p className="emptyState">
              No videos are ready. Hidden, deleted and unfinished videos stay out of the
              playlist.
            </p>
          )}
        </>
      ) : (
        <p className="emptyState">Loading screening…</p>
      )}
    </main>
  );
}

export function PlaylistPlayer({data}: {data: PlaylistResponse}) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const controller = useRef<ReturnType<typeof createPlaylistController> | null>(null);
  const [state, setState] = useState<PlayerState>({index: 0, phase: 'idle', error: null});
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  useEffect(() => {
    if (!first.current || !second.current) return;
    const player = createPlaylistController(
      data.items,
      [first.current, second.current],
      (id) =>
        api<PlaybackResponse>(
          `/events/${encodeURIComponent(data.event.id)}/playlist/${encodeURIComponent(id)}/playback`,
        ),
      setState,
    );
    controller.current = player;
    return () => {
      player.destroy();
      controller.current = null;
    };
  }, [data.items, data.event.id]);

  const clip = data.items[state.index];
  const showingVideo = ['playing', 'paused'].includes(state.phase);
  const total = data.items.reduce((sum, item) => sum + item.durationSeconds, 0);
  async function fullscreen() {
    setFullscreenError(null);
    try {
      if (!shell.current?.requestFullscreen)
        throw new Error('Fullscreen is unavailable in this browser.');
      await shell.current.requestFullscreen();
    } catch (cause) {
      setFullscreenError(errorMessage(cause));
    }
  }

  return (
    <div className="playlistScreening">
      <div className="screeningShell" ref={shell}>
        <div className="screeningStage">
          {[first, second].map((ref, slot) => (
            <video
              key={slot}
              ref={ref}
              playsInline
              preload="auto"
              controls={showingVideo && state.index % 2 === slot}
              className={
                showingVideo && state.index % 2 === slot
                  ? 'screeningClip active'
                  : 'screeningClip'
              }
              aria-hidden={!showingVideo || state.index % 2 !== slot}
              tabIndex={showingVideo && state.index % 2 === slot ? 0 : -1}
              aria-label={`Playlist video ${slot + 1}`}
            />
          ))}
          {!showingVideo ? (
            <div className="screeningOverlay" aria-live="polite">
              <p className="eyebrow">
                {state.phase === 'complete'
                  ? 'That’s a wrap'
                  : `Video ${state.index + 1} of ${data.items.length}`}
              </p>
              <h2>{state.phase === 'complete' ? 'Playlist complete' : clip.title}</h2>
              <p>{state.phase === 'loading' ? 'Loading video…' : clip.creatorName}</p>
              {state.error ? <p role="alert">{state.error}</p> : null}
              {state.phase !== 'loading' ? (
                <button
                  className="primaryAction"
                  onClick={() => void controller.current?.toggle()}
                >
                  {state.phase === 'complete'
                    ? 'Play again'
                    : state.phase === 'error'
                      ? 'Retry video'
                      : 'Play playlist'}
                </button>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="screeningControls">
          <button
            disabled={state.index === 0}
            onClick={() => void controller.current?.jump(state.index - 1)}
          >
            Previous
          </button>
          <button
            disabled={!showingVideo}
            onClick={() => void controller.current?.toggle()}
          >
            {state.phase === 'playing' ? 'Pause' : 'Resume'}
          </button>
          <button
            disabled={state.phase === 'complete'}
            onClick={() => void controller.current?.next()}
          >
            {state.index === data.items.length - 1 ? 'Finish' : 'Next'}
          </button>
          <button onClick={() => void fullscreen()}>Fullscreen</button>
        </div>
        {fullscreenError ? <p role="alert">{fullscreenError}</p> : null}
        <div className="nowPlaying" aria-live="polite">
          <span className="eyebrow">
            {state.index + 1} / {data.items.length} · {formatDuration(total)} total
          </span>
          <h2>{clip.title}</h2>
          <p>{clip.creatorName}</p>
          {clip.description ? <p>{clip.description}</p> : null}
        </div>
      </div>
      <ol className="screeningQueue" aria-label="Playback queue">
        {data.items.map((item, index) => (
          <li key={item.videoId}>
            <button
              aria-current={index === state.index ? 'true' : undefined}
              onClick={() => void controller.current?.jump(index)}
            >
              <span>{String(index + 1).padStart(2, '0')}</span>
              <span>
                <strong>{item.title}</strong>
                <small>{item.creatorName}</small>
              </span>
              <span>{formatDuration(item.durationSeconds)}</span>
            </button>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function SharePlaylist({eventId}: {eventId: string}) {
  const [message, setMessage] = useState('');
  const link = new URL(playlistPath(eventId), window.location.origin).href;
  async function copy() {
    try {
      await navigator.clipboard.writeText(link);
      setMessage('Link copied. Sentry login required.');
    } catch {
      setMessage(`Copy this link: ${link}`);
    }
  }
  return (
    <div className="sharePlaylist">
      <button onClick={() => void copy()}>Copy playlist link</button>
      <span role="status">{message}</span>
    </div>
  );
}

export function formatDuration(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  return `${Math.floor(value / 60)}:${String(value % 60).padStart(2, '0')}`;
}
