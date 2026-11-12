import {useCallback, useEffect, useRef, useState} from 'react';

import type {SessionUser} from '../shared/api';
import type {PlaylistResponse} from '../shared/playlist';
import {linkedVideoId, playlistPath, submissionPath} from '../shared/playlist';
import type {PlaybackResponse} from '../shared/videos';
import {api, errorMessage} from './api';
import {AppFrame} from './components/AppFrame';
import {ArrowIcon} from './components/ArrowIcon';
import {Avatar} from './components/Avatar';
import {PageState} from './components/Loader';
import {SentrySymbol} from './components/SentrySymbol';
import {
  createPlaylistController,
  formatDuration,
  initialPlayerState,
  PLAYBACK_RATES,
  presenterCardVisible,
  screeningSeconds,
  type PlayerState,
  type PlaylistController,
} from './player/controller';
import {createLobbyMusic, type LobbyMusic} from './player/lobby-music';

/** Controls fade out this long after the pointer rests, in fullscreen only. */
const IDLE_CONTROLS_MS = 2_500;

export function PlaylistPage({
  eventId,
  user,
  onViewModeChange,
}: {
  eventId: string;
  user: SessionUser;
  onViewModeChange?: (user: SessionUser) => void;
}) {
  const [data, setData] = useState<PlaylistResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const reload = () => setRevision((value) => value + 1);
  useEffect(() => {
    const controller = new AbortController();
    setData(null);
    setError(null);
    void api<PlaylistResponse>(`/events/${encodeURIComponent(eventId)}/playlist`, {
      signal: controller.signal,
    })
      .then((result) => {
        if (!controller.signal.aborted) {
          setData(result);
          window.history.replaceState(
            null,
            '',
            playlistPath(
              eventId,
              result.event.slug,
              linkedVideoId(window.location.search),
            ),
          );
        }
      })
      .catch((cause: unknown) => {
        if (!controller.signal.aborted) setError(errorMessage(cause));
      });
    return () => controller.abort();
  }, [eventId, revision]);

  const backHref = submissionPath(eventId, data?.event.slug);
  return (
    <AppFrame user={user} section="screening" onViewModeChange={onViewModeChange}>
      <main className="watchPage">
        {error ? (
          <PageState tone="error" title="Could not load the screening" detail={error}>
            <button className="primaryAction" onClick={reload}>
              Retry loading
            </button>
          </PageState>
        ) : data ? (
          <>
            <header className="watchHeader pageHeader">
              <div>
                <a className="backLink" href={backHref}>
                  <ArrowIcon direction="left" /> Back to submissions
                </a>
                <p className="kicker">Sentry Show &amp; Tell · screening</p>
                <h1>{data.event.title}</h1>
                {data.event.description ? <p>{data.event.description}</p> : null}
              </div>
              <div className="watchActions">
                <p className="watchMeta">
                  {countLabel(data.items.length)}
                  {data.items.length
                    ? ` · ${formatDuration(screeningSeconds(data.items))} with intros`
                    : ''}
                </p>
                <div className="watchButtons">
                  <SharePlaylist eventId={eventId} slug={data.event.slug} />
                </div>
              </div>
            </header>
            {data.items.length ? (
              <PlaylistPlayer
                key={`${eventId}-${revision}`}
                data={data}
                initialVideoId={linkedVideoId(window.location.search)}
              />
            ) : (
              <section className="emptyState">
                <span aria-hidden="true">0</span>
                <h2>No videos are ready</h2>
                <p>
                  Hidden, deleted and unfinished videos stay out of the screening. Refresh
                  your browser once uploads finish processing.
                </p>
              </section>
            )}
          </>
        ) : (
          <PageState
            loading
            title="Loading the screening"
            detail="Fetching the lineup…"
          />
        )}
      </main>
    </AppFrame>
  );
}

export function PlaylistPlayer({
  data,
  initialVideoId = null,
}: {
  data: PlaylistResponse;
  /** Video a shared link points at; the first play starts there. */
  initialVideoId?: string | null;
}) {
  const first = useRef<HTMLVideoElement>(null);
  const second = useRef<HTMLVideoElement>(null);
  const shell = useRef<HTMLDivElement>(null);
  const controls = useRef<HTMLDivElement>(null);
  const controller = useRef<PlaylistController | null>(null);
  const idleTimer = useRef<number | null>(null);
  const [startIndex] = useState(() =>
    Math.max(
      0,
      data.items.findIndex((item) => item.videoId === initialVideoId),
    ),
  );
  const [state, setState] = useState<PlayerState>(() =>
    initialPlayerState(data.items, startIndex),
  );
  const [nativeFullscreen, setNativeFullscreen] = useState(false);
  // iPhone Safari can only fullscreen a <video>, which would drop the overlays and
  // break on the slot swap between clips, so the shell fills the viewport instead.
  const [pageFullscreen, setPageFullscreen] = useState(false);
  const fullscreen = nativeFullscreen || pageFullscreen;
  const [fullscreenError, setFullscreenError] = useState<string | null>(null);
  const [idle, setIdle] = useState(false);
  const music = useRef<LobbyMusic | null>(null);
  const [musicPlaying, setMusicPlaying] = useState(false);

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
      {startIndex},
    );
    controller.current = player;
    return () => {
      player.destroy();
      controller.current = null;
    };
  }, [data.items, data.event.id, startIndex]);

  useEffect(() => {
    const sync = () => setNativeFullscreen(document.fullscreenElement === shell.current);
    document.addEventListener('fullscreenchange', sync);
    return () => document.removeEventListener('fullscreenchange', sync);
  }, []);

  // Fullscreen controls float over the video; the presenter card sits just above them.
  useEffect(() => {
    const host = shell.current;
    const bar = controls.current;
    if (!host || !bar || !('ResizeObserver' in window)) return;
    const observer = new ResizeObserver(() =>
      host.style.setProperty('--controls-height', `${bar.offsetHeight}px`),
    );
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);

  const wake = useCallback(() => {
    setIdle(false);
    if (idleTimer.current) window.clearTimeout(idleTimer.current);
    idleTimer.current = window.setTimeout(() => setIdle(true), IDLE_CONTROLS_MS);
  }, []);
  useEffect(
    () => () => {
      if (idleTimer.current) window.clearTimeout(idleTimer.current);
    },
    [],
  );

  const toggleFullscreen = useCallback(async () => {
    setFullscreenError(null);
    try {
      if (document.fullscreenElement) {
        await document.exitFullscreen();
        return;
      }
      if (!shell.current?.requestFullscreen) {
        setPageFullscreen((value) => !value);
        return;
      }
      await shell.current.requestFullscreen();
    } catch (cause) {
      setFullscreenError(errorMessage(cause));
    }
  }, []);

  const stateRef = useRef(state);
  stateRef.current = state;
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) =>
      handleScreeningShortcut(event, {
        toggle: () => void controller.current?.toggle(),
        next: () => void controller.current?.next(),
        previous: () => {
          const player = controller.current;
          if (player && stateRef.current.phase !== 'idle')
            void player.jump(stateRef.current.index - 1);
        },
        fullscreen: () => void toggleFullscreen(),
        mute: () => controller.current?.setMuted(!stateRef.current.muted),
      });
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [toggleFullscreen]);

  // Lobby music fills the silence before the reel and stops once it starts. A
  // paused clip still counts: resuming jumps straight to playing after the
  // video is audible, so music left on while paused would overlap the demo.
  const reelRunning =
    state.phase === 'loading' ||
    state.phase === 'title' ||
    state.phase === 'playing' ||
    state.phase === 'paused';
  useEffect(() => {
    if (!reelRunning) return;
    music.current?.pause();
    setMusicPlaying(false);
  }, [reelRunning]);
  useEffect(
    () => () => {
      music.current?.destroy();
      music.current = null;
    },
    [],
  );
  const toggleMusic = () => {
    if (musicPlaying) {
      music.current?.pause();
      setMusicPlaying(false);
      return;
    }
    music.current ??= createLobbyMusic();
    setMusicPlaying(true);
    music.current.play().catch(() => setMusicPlaying(false));
  };

  const clip = data.items[state.index];
  const count = data.items.length;
  const showingVideo = state.phase === 'playing' || state.phase === 'paused';
  const announcing = state.phase === 'loading' || state.phase === 'title';
  const activeSlot = state.index % 2;
  const last = state.index === count - 1;
  const duration = state.durationSeconds || clip.durationSeconds;
  const presenterVisible = presenterCardVisible(state.currentTime, duration);
  const toggle = () => void controller.current?.toggle();
  const next = () => void controller.current?.next();

  // The address bar follows the selected clip so any video can be shared. Before
  // the first clip and after the wrap it points at the whole screening.
  const linkedId =
    state.phase === 'complete' || (state.phase === 'idle' && state.index === 0)
      ? null
      : clip.videoId;
  useEffect(() => {
    window.history.replaceState(
      window.history.state,
      '',
      playlistPath(data.event.id, data.event.slug, linkedId),
    );
  }, [data.event.id, data.event.slug, linkedId]);

  return (
    <section className="screening" aria-label="Screening player">
      <div
        ref={shell}
        className={`screeningShell${fullscreen ? ' fullscreen' : ''}${pageFullscreen ? ' pageFullscreen' : ''}${idle && state.phase === 'playing' ? ' idle' : ''}`}
        onPointerMove={wake}
        onPointerDown={wake}
        tabIndex={-1}
      >
        <div className="screeningStage">
          {[first, second].map((ref, slot) => (
            <video
              key={slot}
              ref={ref}
              playsInline
              preload="auto"
              className={
                showingVideo && activeSlot === slot
                  ? 'screeningClip active'
                  : 'screeningClip'
              }
              aria-hidden={!showingVideo || activeSlot !== slot}
              aria-label={`Screening video ${slot + 1}`}
            />
          ))}
          {showingVideo ? (
            <div
              className={`clipOverlay${presenterVisible ? '' : ' clipOverlayHidden'}`}
              aria-live="polite"
              aria-hidden={!presenterVisible}
              key={clip.videoId}
            >
              <Avatar
                name={clip.creatorName}
                avatarUrl={clip.creatorAvatarUrl}
                className="clipOverlayAvatar"
              />
              <div className="clipOverlayCopy">
                <small>Presenting</small>
                <strong>{clip.creatorName}</strong>
                <span>{clip.title}</span>
              </div>
            </div>
          ) : null}
          {state.phase === 'idle' ? (
            <div className="startCard">
              <Backdrop />
              <div className="startCardContent">
                <span className="screeningMark">
                  <SentrySymbol />
                </span>
                <p className="startCardKicker">Sentry Show &amp; Tell</p>
                <h2>{data.event.title}</h2>
                <p>
                  {countLabel(count)} · {formatDuration(screeningSeconds(data.items))}{' '}
                  with intros
                </p>
                {state.index > 0 ? (
                  <p>
                    Starting with video {pad(state.index + 1)}: {clip.title}
                  </p>
                ) : null}
                <button className="screeningStart" onClick={toggle}>
                  {state.index > 0
                    ? `Play from video ${pad(state.index + 1)}`
                    : 'Play all'}
                </button>
                <small>Sound starts after you press play</small>
              </div>
            </div>
          ) : null}
          {announcing ? (
            <div className="titleCard visible" aria-live="polite">
              <Backdrop />
              <div className="titleCardFrame">
                <div className="titleCardTopline">
                  <span>
                    Video {pad(state.index + 1)} / {pad(count)}
                  </span>
                  <span>{data.event.title}</span>
                </div>
                <div className="titleCardCopy" key={clip.videoId}>
                  <p>
                    <strong>{state.phase === 'loading' ? 'Loading' : 'Up next'}</strong>
                  </p>
                  <h2>{clip.title}</h2>
                  <div className="titleCardTeam">
                    <small>Presented by</small>
                    <span>{clip.creatorName}</span>
                  </div>
                </div>
                {state.countdownSeconds ? (
                  <button
                    className="titleCountdown"
                    onClick={toggle}
                    aria-label={`Starting in ${state.countdownSeconds} seconds. Start now`}
                  >
                    <small>Playing in</small>
                    <b>{state.countdownSeconds}</b>
                  </button>
                ) : null}
              </div>
            </div>
          ) : null}
          {state.phase === 'complete' ? (
            <div className="startCard" aria-live="polite">
              <Backdrop />
              <div className="startCardContent">
                <span className="screeningMark" aria-hidden="true">
                  <svg
                    viewBox="0 0 24 24"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="2"
                  >
                    <path d="m5 12 4 4L19 6" />
                  </svg>
                </span>
                <p className="startCardKicker">Sentry Show &amp; Tell</p>
                <h2>That’s a wrap</h2>
                <p>All {countLabel(count)} played. Thanks for showing and telling.</p>
                <button className="screeningStart" onClick={toggle}>
                  Play again
                </button>
              </div>
            </div>
          ) : null}
          {state.phase === 'error' ? (
            <div className="playerError" role="alert">
              <p className="startCardKicker">Video {pad(state.index + 1)}</p>
              <h2>{clip.title} could not be played</h2>
              <p>{state.error}</p>
              <div className="playerErrorActions">
                <button className="screeningStart" onClick={toggle}>
                  Retry video
                </button>
                <button className="screeningSkip" onClick={next}>
                  {last ? 'Finish' : 'Skip video'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
        <div ref={controls} className="screeningControls" aria-label="Playback controls">
          <div className="screeningTimeline">
            <span>{formatDuration(state.currentTime)}</span>
            <input
              type="range"
              aria-label="Video position"
              min={0}
              max={Math.max(duration, 0.1)}
              step={0.1}
              value={Math.min(state.currentTime, duration)}
              disabled={!showingVideo}
              onChange={(event) =>
                controller.current?.seek(event.currentTarget.valueAsNumber)
              }
            />
            <span>{formatDuration(duration)}</span>
          </div>
          <div className="screeningButtons">
            <button
              disabled={state.index === 0 || state.phase === 'idle'}
              onClick={() => void controller.current?.jump(state.index - 1)}
            >
              Previous{' '}
              <kbd aria-hidden="true">
                <ArrowIcon direction="left" />
              </kbd>
            </button>
            <button disabled={state.phase === 'loading'} onClick={toggle}>
              {toggleLabel(state.phase)} <kbd aria-hidden="true">space</kbd>
            </button>
            <button
              disabled={state.phase === 'complete' || state.phase === 'idle'}
              onClick={next}
            >
              {last ? 'Finish' : 'Next'}{' '}
              <kbd aria-hidden="true">
                <ArrowIcon direction="right" />
              </kbd>
            </button>
          </div>
          <div className="screeningNowPlaying" aria-live="polite">
            <strong>{clip.title}</strong>
            <span>
              {state.index + 1} of {count} · {clip.creatorName}
            </span>
          </div>
          <div className="screeningSettings">
            <button
              aria-pressed={musicPlaying}
              disabled={reelRunning}
              title="Background music while people join"
              onClick={toggleMusic}
            >
              {musicPlaying ? 'Pause music' : 'Lobby music'}
            </button>
            <button
              aria-pressed={state.muted}
              onClick={() => controller.current?.setMuted(!state.muted)}
            >
              {state.muted ? 'Unmute' : 'Mute'} <kbd aria-hidden="true">m</kbd>
            </button>
            <label className="playbackSpeed">
              <span className="sr-only">Playback speed</span>
              <select
                value={String(state.playbackRate)}
                onChange={(event) =>
                  controller.current?.setPlaybackRate(Number(event.currentTarget.value))
                }
              >
                {PLAYBACK_RATES.map((rate) => (
                  <option key={rate} value={rate}>
                    {rate}×
                  </option>
                ))}
              </select>
            </label>
            <button onClick={() => void toggleFullscreen()}>
              {fullscreen ? 'Exit fullscreen' : 'Fullscreen'}{' '}
              <kbd aria-hidden="true">f</kbd>
            </button>
          </div>
        </div>
      </div>
      {fullscreenError ? (
        <p className="inlineError" role="alert">
          {fullscreenError}
        </p>
      ) : null}
      <section className="reelIndex" aria-labelledby="reel-index-heading">
        <p className="kicker">Screening order</p>
        <h2 id="reel-index-heading">Lineup</h2>
        <ol className="reelPlaylist" aria-label="Playback queue">
          {data.items.map((item, index) => (
            <li key={item.videoId} className="reelItem">
              <button
                className="reelRow"
                aria-current={index === state.index ? 'true' : undefined}
                onClick={() => void controller.current?.jump(index)}
              >
                <span className="reelRowIndex">{pad(index + 1)}</span>
                <span className="reelRowCopy">
                  <strong>{item.title}</strong>
                  <small>{item.creatorName}</small>
                </span>
                <span className="reelRowDuration">
                  {formatDuration(item.durationSeconds)}
                </span>
              </button>
              <a
                className="reelDownload"
                href={`/api/videos/${encodeURIComponent(item.videoId)}/download`}
                download
                aria-label={`Download ${item.title}`}
                title="Download video"
              >
                <ArrowIcon direction="down" />
              </a>
            </li>
          ))}
        </ol>
      </section>
    </section>
  );
}

/** Drifting Sentry-coloured blobs behind the start and title cards. */
function Backdrop() {
  return (
    <div className="stageBackdrop" aria-hidden="true">
      <span />
      <span />
      <span />
      <SentrySymbol className="stageBackdropMark" />
    </div>
  );
}

export function SharePlaylist({
  eventId,
  kind = 'playlist',
  slug,
  videoId,
}: {
  eventId: string;
  slug?: string;
  kind?: 'playlist' | 'submission';
  /** Links the screening straight to this video. */
  videoId?: string;
}) {
  const [message, setMessage] = useState('');
  const link = new URL(
    kind === 'playlist'
      ? playlistPath(eventId, slug, videoId)
      : submissionPath(eventId, slug),
    window.location.origin,
  ).href;
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
      <button className="secondaryAction" onClick={() => void copy()}>
        {kind === 'submission'
          ? 'Copy submission link'
          : videoId
            ? 'Copy video link'
            : 'Copy screening link'}
      </button>
      <span role="status">{message}</span>
    </div>
  );
}

export function handleScreeningShortcut(
  event: Pick<
    KeyboardEvent,
    | 'code'
    | 'key'
    | 'target'
    | 'preventDefault'
    | 'repeat'
    | 'metaKey'
    | 'ctrlKey'
    | 'altKey'
  >,
  actions: {
    toggle(): void;
    next(): void;
    previous(): void;
    fullscreen(): void;
    mute(): void;
  },
) {
  if (event.repeat || event.metaKey || event.ctrlKey || event.altKey) return;
  if (
    event.target instanceof HTMLInputElement ||
    event.target instanceof HTMLTextAreaElement ||
    event.target instanceof HTMLSelectElement
  )
    return;
  // A focused button already activates on Space; leave it to the button.
  if (event.code === 'Space' && !(event.target instanceof HTMLButtonElement))
    actions.toggle();
  else if (event.code === 'ArrowRight') actions.next();
  else if (event.code === 'ArrowLeft') actions.previous();
  else if (event.key.toLowerCase() === 'f') actions.fullscreen();
  else if (event.key.toLowerCase() === 'm') actions.mute();
  else return;
  event.preventDefault();
}

function toggleLabel(phase: PlayerState['phase']) {
  switch (phase) {
    case 'title':
      return 'Start now';
    case 'playing':
      return 'Pause';
    case 'paused':
      return 'Resume';
    case 'error':
      return 'Retry video';
    case 'complete':
      return 'Play again';
    default:
      return 'Play';
  }
}

function countLabel(count: number) {
  return `${count} ${count === 1 ? 'video' : 'videos'}`;
}

function pad(value: number) {
  return String(value).padStart(2, '0');
}
