import type {PlaylistItem} from '../../shared/playlist';
import type {PlaybackResponse} from '../../shared/videos';

export type PlayerPhase =
  | 'idle'
  | 'loading'
  | 'title'
  | 'playing'
  | 'paused'
  | 'complete'
  | 'error';

export interface PlayerState {
  index: number;
  phase: PlayerPhase;
  error: string | null;
  /** Seconds left on the title card; null outside the interlude. */
  countdownSeconds: number | null;
  currentTime: number;
  durationSeconds: number;
  muted: boolean;
  playbackRate: number;
}

export interface PlayerOptions {
  /** Title-card interlude before each clip. Zero starts the clip immediately. */
  titleDurationMs?: number;
}

/** Title-card interlude shown before every clip, as in Hack Week's reel. */
export const TITLE_CARD_DURATION_MS = 5_000;
export const PLAYBACK_RATES = [1, 1.25, 1.5, 2] as const;

/** Two alternating video elements, adapted from Hack Week's screening controller.
 * Every clip is announced on a title card while the next clip preloads.
 * Generation guards fence late fetch/play results.
 * MP4 audio is already loudness-normalized by our processor.
 */
export function createPlaylistController(
  items: PlaylistItem[],
  elements: [HTMLVideoElement, HTMLVideoElement],
  getPlayback: (id: string) => Promise<PlaybackResponse>,
  onState: (state: PlayerState) => void,
  options: PlayerOptions = {},
) {
  const titleDurationMs = options.titleDurationMs ?? TITLE_CARD_DURATION_MS;
  let state: PlayerState = {
    index: 0,
    phase: 'idle',
    error: null,
    countdownSeconds: null,
    currentTime: 0,
    durationSeconds: items[0]?.durationSeconds ?? 0,
    muted: false,
    playbackRate: 1,
  };
  let generation = 0;
  let destroyed = false;
  let titleTimer: ReturnType<typeof setTimeout> | null = null;
  let countdownTimer: ReturnType<typeof setInterval> | null = null;
  const slots: Array<{id: string | null; generation: number}> = [
    {id: null, generation: 0},
    {id: null, generation: 0},
  ];
  const active = () => state.index % 2;
  const publish = (patch: Partial<PlayerState>) => {
    if (destroyed) return;
    state = {...state, ...patch};
    onState(state);
  };
  const current = (operation: number) => !destroyed && operation === generation;

  function clearTitleTimers() {
    if (titleTimer) clearTimeout(titleTimer);
    if (countdownTimer) clearInterval(countdownTimer);
    titleTimer = null;
    countdownTimer = null;
  }

  function clear(slot: number) {
    slots[slot].generation++;
    slots[slot].id = null;
    elements[slot].pause();
    elements[slot].removeAttribute('src');
    elements[slot].load();
  }

  async function prepare(index: number, operation: number) {
    const clip = items[index];
    if (!clip) return;
    const slot = index % 2;
    const token = ++slots[slot].generation;
    // Revalidate even a preloaded clip when it becomes active: hidden/deleted
    // submissions must not be played from a previously authorized buffer.
    const playback = await getPlayback(clip.videoId);
    if (!current(operation) || token !== slots[slot].generation) return;
    if (slots[slot].id === clip.videoId) return;
    clear(slot);
    slots[slot].id = clip.videoId;
    elements[slot].preload = 'auto';
    elements[slot].src = playback.source.url;
    elements[slot].load();
  }

  function preloadNext(index: number, operation: number) {
    if (index + 1 < items.length) {
      void prepare(index + 1, operation).catch(() => {
        // Preload failure is retried on transition, not surfaced over this clip.
      });
    } else clear(1 - active());
  }

  function fail(cause: unknown, operation: number) {
    if (!current(operation)) return;
    generation++;
    clearTitleTimers();
    elements[active()].pause();
    const blocked =
      (cause instanceof Error || cause instanceof DOMException) &&
      cause.name === 'NotAllowedError';
    publish({
      phase: 'error',
      countdownSeconds: null,
      error: blocked
        ? 'Your browser paused playback. Press Retry video to continue.'
        : cause instanceof Error
          ? cause.message
          : 'Video could not play. Retry or skip it.',
    });
  }

  /** Plays the prepared active clip. The next clip is already preloading when
   * the title card ran; otherwise start preloading it now. */
  async function startPlayback(operation: number) {
    const preloading = state.phase === 'title';
    clearTitleTimers();
    const element = elements[active()];
    element.muted = state.muted;
    element.playbackRate = state.playbackRate;
    element.currentTime = 0;
    await element.play();
    if (!current(operation)) {
      // A newer operation may be playing this very element; don't pause it.
      if (destroyed || element !== elements[active()]) element.pause();
      return;
    }
    publish({phase: 'playing', countdownSeconds: null});
    if (!preloading) preloadNext(state.index, operation);
  }

  function beginTitleCard(operation: number) {
    const endsAt = Date.now() + titleDurationMs;
    publish({phase: 'title', countdownSeconds: Math.ceil(titleDurationMs / 1_000)});
    preloadNext(state.index, operation);
    countdownTimer = setInterval(() => {
      if (!current(operation) || state.phase !== 'title') return;
      const next = Math.max(1, Math.ceil((endsAt - Date.now()) / 1_000));
      if (next !== state.countdownSeconds) publish({countdownSeconds: next});
    }, 100);
    titleTimer = setTimeout(() => {
      if (!current(operation) || state.phase !== 'title') return;
      startPlayback(operation).catch((cause: unknown) => fail(cause, operation));
    }, titleDurationMs);
  }

  async function jump(index: number) {
    if (destroyed || index < 0 || index >= items.length) return;
    const previous = elements[active()];
    const volume = previous.volume;
    const operation = ++generation;
    clearTitleTimers();
    elements.forEach((element) => element.pause());
    publish({
      index,
      phase: 'loading',
      error: null,
      countdownSeconds: null,
      currentTime: 0,
      durationSeconds: items[index].durationSeconds,
      muted: previous.muted,
      playbackRate: previous.playbackRate,
    });
    try {
      await prepare(index, operation);
      if (!current(operation)) return;
      elements[active()].volume = volume;
      if (titleDurationMs > 0) beginTitleCard(operation);
      else await startPlayback(operation);
    } catch (cause) {
      fail(cause, operation);
    }
  }

  function next() {
    // Nothing to advance before the first play or after the wrap card.
    if (destroyed || state.phase === 'idle' || state.phase === 'complete') return;
    if (state.index + 1 < items.length) return jump(state.index + 1);
    generation++;
    clearTitleTimers();
    elements.forEach((element) => element.pause());
    publish({phase: 'complete', error: null, countdownSeconds: null});
  }

  const handlers = elements.map((element, slot) => {
    const ended = () => {
      if (!destroyed && slot === active() && ['playing', 'paused'].includes(state.phase))
        void next();
    };
    const error = () => {
      const failedVideoId = slots[slot].id;
      slots[slot].id = null;
      // The selected index changes before revalidation replaces the source. A
      // same-slot jump can still receive an error from the outgoing clip; only
      // fail playback if the attached source belongs to the selected video.
      if (
        failedVideoId !== null &&
        failedVideoId === items[state.index]?.videoId &&
        slot === active() &&
        ['loading', 'title', 'playing', 'paused'].includes(state.phase)
      )
        fail(
          new Error('Private video could not be loaded. Retry or skip it.'),
          generation,
        );
    };
    const pause = () => {
      if (
        slot === active() &&
        state.phase === 'playing' &&
        element.paused &&
        !element.ended
      )
        publish({phase: 'paused'});
    };
    const play = () => {
      if (slot === active() && state.phase === 'paused') publish({phase: 'playing'});
    };
    const progress = () => {
      if (slot !== active() || !['title', 'playing', 'paused'].includes(state.phase))
        return;
      publish({
        currentTime: finiteTime(element.currentTime, state.currentTime),
        durationSeconds: finiteTime(
          element.duration,
          items[state.index]?.durationSeconds ?? state.durationSeconds,
        ),
      });
    };
    element.addEventListener('ended', ended);
    element.addEventListener('error', error);
    element.addEventListener('pause', pause);
    element.addEventListener('play', play);
    element.addEventListener('timeupdate', progress);
    element.addEventListener('durationchange', progress);
    return {ended, error, pause, play, progress};
  });

  return {
    jump,
    next,
    async toggle() {
      if (state.phase === 'playing') {
        elements[active()].pause();
        publish({phase: 'paused'});
      } else if (state.phase === 'paused') {
        const operation = ++generation;
        try {
          await prepare(state.index, operation);
          if (!current(operation)) return;
          await elements[active()].play();
          if (current(operation)) {
            publish({phase: 'playing'});
            // Resuming advances the generation, fencing any pending preload.
            // Restart it under this operation just as a fresh jump would.
            preloadNext(state.index, operation);
          }
        } catch (cause) {
          fail(cause, operation);
        }
      } else if (state.phase === 'title') {
        // Skip the countdown: the clip is prepared and the next one is preloading.
        const operation = generation;
        try {
          await startPlayback(operation);
        } catch (cause) {
          fail(cause, operation);
        }
      } else if (state.phase !== 'loading') {
        await jump(state.phase === 'complete' ? 0 : state.index);
      }
    },
    seek(time: number) {
      if (!['playing', 'paused'].includes(state.phase) || !Number.isFinite(time)) return;
      const target = Math.max(0, Math.min(time, state.durationSeconds));
      elements[active()].currentTime = target;
      publish({currentTime: target});
    },
    setPlaybackRate(rate: number) {
      if (!Number.isFinite(rate) || rate <= 0) return;
      elements.forEach((element) => {
        element.playbackRate = rate;
      });
      publish({playbackRate: rate});
    },
    setMuted(muted: boolean) {
      elements.forEach((element) => {
        element.muted = muted;
      });
      publish({muted});
    },
    destroy() {
      destroyed = true;
      generation++;
      clearTitleTimers();
      elements.forEach((element, slot) => {
        const h = handlers[slot];
        element.removeEventListener('ended', h.ended);
        element.removeEventListener('error', h.error);
        element.removeEventListener('pause', h.pause);
        element.removeEventListener('play', h.play);
        element.removeEventListener('timeupdate', h.progress);
        element.removeEventListener('durationchange', h.progress);
        clear(slot);
      });
    },
  };
}

export type PlaylistController = ReturnType<typeof createPlaylistController>;

function finiteTime(value: number, fallback: number) {
  return Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** Runtime of a screening including the title card before every clip. */
export function screeningSeconds(items: Array<{durationSeconds: number}>) {
  return items.reduce(
    (sum, item) => sum + item.durationSeconds + TITLE_CARD_DURATION_MS / 1_000,
    0,
  );
}

export function formatDuration(seconds: number) {
  const value = Math.max(0, Math.round(seconds));
  const hours = Math.floor(value / 3600);
  const minutes = Math.floor((value % 3600) / 60);
  const remainder = String(value % 60).padStart(2, '0');
  return hours > 0
    ? `${hours}:${String(minutes).padStart(2, '0')}:${remainder}`
    : `${minutes}:${remainder}`;
}
