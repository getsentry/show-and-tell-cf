import type {PlaylistItem} from '../../shared/playlist';
import type {PlaybackResponse} from '../../shared/videos';

export interface PlayerState {
  index: number;
  phase: 'idle' | 'loading' | 'playing' | 'paused' | 'complete' | 'error';
  error: string | null;
}

/** Two alternating video elements, adapted from Hack Week's screening controller.
 * Only the next clip preloads. Generation guards fence late fetch/play results.
 * MP4 audio is already loudness-normalized by our processor.
 */
export function createPlaylistController(
  items: PlaylistItem[],
  elements: [HTMLVideoElement, HTMLVideoElement],
  getPlayback: (id: string) => Promise<PlaybackResponse>,
  onState: (state: PlayerState) => void,
) {
  let state: PlayerState = {index: 0, phase: 'idle', error: null};
  let generation = 0;
  let destroyed = false;
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

  function fail(cause: unknown, operation: number) {
    if (!current(operation)) return;
    generation++;
    elements[active()].pause();
    const blocked =
      (cause instanceof Error || cause instanceof DOMException) &&
      cause.name === 'NotAllowedError';
    publish({
      phase: 'error',
      error: blocked
        ? 'Your browser paused playback. Press Retry video to continue.'
        : cause instanceof Error
          ? cause.message
          : 'Video could not play. Retry or skip it.',
    });
  }

  async function jump(index: number) {
    if (destroyed || index < 0 || index >= items.length) return;
    const previous = elements[active()];
    const volume = previous.volume;
    const muted = previous.muted;
    const rate = previous.playbackRate;
    const operation = ++generation;
    elements.forEach((element) => element.pause());
    publish({index, phase: 'loading', error: null});
    try {
      await prepare(index, operation);
      if (!current(operation)) return;
      const element = elements[active()];
      element.volume = volume;
      element.muted = muted;
      element.playbackRate = rate;
      element.currentTime = 0;
      await element.play();
      if (!current(operation)) {
        // A newer operation may be playing this very element; don't pause it.
        if (destroyed || element !== elements[active()]) element.pause();
        return;
      }
      publish({phase: 'playing'});
      if (index + 1 < items.length) {
        void prepare(index + 1, operation).catch(() => {
          // Preload failure is retried on transition, not surfaced over this clip.
        });
      } else clear(1 - active());
    } catch (cause) {
      fail(cause, operation);
    }
  }

  function next() {
    if (destroyed) return;
    if (state.index + 1 < items.length) return jump(state.index + 1);
    generation++;
    elements.forEach((element) => element.pause());
    publish({phase: 'complete', error: null});
  }

  const handlers = elements.map((element, slot) => {
    const ended = () => {
      if (!destroyed && slot === active() && ['playing', 'paused'].includes(state.phase))
        void next();
    };
    const error = () => {
      slots[slot].id = null;
      if (slot === active() && ['loading', 'playing', 'paused'].includes(state.phase))
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
    element.addEventListener('ended', ended);
    element.addEventListener('error', error);
    element.addEventListener('pause', pause);
    element.addEventListener('play', play);
    return {ended, error, pause, play};
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
          if (current(operation)) publish({phase: 'playing'});
        } catch (cause) {
          fail(cause, operation);
        }
      } else if (state.phase !== 'loading') {
        await jump(state.phase === 'complete' ? 0 : state.index);
      }
    },
    destroy() {
      destroyed = true;
      generation++;
      elements.forEach((element, slot) => {
        const h = handlers[slot];
        element.removeEventListener('ended', h.ended);
        element.removeEventListener('error', h.error);
        element.removeEventListener('pause', h.pause);
        element.removeEventListener('play', h.play);
        clear(slot);
      });
    },
  };
}
