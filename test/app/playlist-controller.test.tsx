import {afterEach, beforeEach, describe, expect, it, vi} from 'vitest';
import {
  createPlaylistController,
  type PlayerState,
} from '../../src/app/player/controller';
import type {PlaylistItem} from '../../src/shared/playlist';
import type {PlaybackResponse} from '../../src/shared/videos';

const items: PlaylistItem[] = ['a', 'b', 'c'].map((id) => ({
  submissionId: id,
  videoId: id,
  title: id,
  description: null,
  creatorName: 'Demo team',
  durationSeconds: 30,
}));
const playback = (id: string): PlaybackResponse => ({
  source: {kind: 'mp4', url: `/api/videos/${id}/content`},
  expiresAt: null,
});
const players: Array<ReturnType<typeof createPlaylistController>> = [];
const play = vi.fn<() => Promise<void>>();
beforeEach(() => {
  vi.spyOn(HTMLMediaElement.prototype, 'load').mockImplementation(() => {});
  play.mockReset().mockResolvedValue();
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockImplementation(play);
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {});
});
afterEach(() => {
  players.splice(0).forEach((p) => p.destroy());
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function setup(
  getPlayback = vi.fn(async (id: string) => playback(id)),
  titleDurationMs = 0,
) {
  const elements: [HTMLVideoElement, HTMLVideoElement] = [
    document.createElement('video'),
    document.createElement('video'),
  ];
  const states: PlayerState[] = [];
  const player = createPlaylistController(
    items,
    elements,
    getPlayback,
    (state) => states.push(state),
    {titleDurationMs},
  );
  players.push(player);
  return {player, elements, getPlayback, states, state: () => states.at(-1)!};
}
async function flush() {
  for (let i = 0; i < 10; i++) await Promise.resolve();
}
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return {promise, resolve, reject};
}

describe('two-buffer playlist controller', () => {
  it('preloads the next video, advances through alternating slots, and completes exactly once', async () => {
    const {player, elements, getPlayback, state} = setup();
    await player.jump(0);
    await flush();
    expect(state()).toMatchObject({phase: 'playing', index: 0});
    expect(elements[0].src).toContain('/a/content');
    expect(elements[1].src).toContain('/b/content');
    expect(getPlayback.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    elements[1].dispatchEvent(new Event('ended'));
    expect(state().index).toBe(0);
    // Browsers may emit pause immediately before ended at natural completion.
    elements[0].dispatchEvent(new Event('pause'));
    elements[0].dispatchEvent(new Event('ended'));
    await flush();
    expect(state()).toMatchObject({phase: 'playing', index: 1});
    expect(getPlayback.mock.calls.map(([id]) => id)).toEqual(['a', 'b', 'b', 'c']);
    elements[1].dispatchEvent(new Event('ended'));
    await flush();
    expect(state()).toMatchObject({phase: 'playing', index: 2});
    elements[0].dispatchEvent(new Event('ended'));
    await flush();
    expect(state().phase).toBe('complete');
    elements[0].dispatchEvent(new Event('ended'));
    expect(state().phase).toBe('complete');
    await player.toggle();
    expect(state()).toMatchObject({phase: 'playing', index: 0});
  });
  it('carries volume/mute/speed forward, supports pause/resume and previous', async () => {
    const {player, elements, state} = setup();
    await player.jump(0);
    elements[0].volume = 0.3;
    elements[0].muted = true;
    elements[0].playbackRate = 1.5;
    await player.next();
    expect(elements[1].volume).toBe(0.3);
    expect(elements[1].muted).toBe(true);
    expect(elements[1].playbackRate).toBe(1.5);
    await player.toggle();
    expect(state().phase).toBe('paused');
    await player.toggle();
    expect(state().phase).toBe('playing');
    await player.jump(0);
    expect(state().index).toBe(0);
  });
  it('restarts a pending next-clip preload after pause and resume', async () => {
    const original = deferred<PlaybackResponse>();
    const restarted = deferred<PlaybackResponse>();
    let preloadCalls = 0;
    const fetch = vi.fn((id: string) => {
      if (id === 'b') return ++preloadCalls === 1 ? original.promise : restarted.promise;
      return Promise.resolve(playback(id));
    });
    const {player, elements, state} = setup(fetch);
    await player.jump(0);
    expect(preloadCalls).toBe(1);
    await player.toggle();
    expect(state().phase).toBe('paused');
    await player.toggle();
    expect(state().phase).toBe('playing');
    expect(preloadCalls).toBe(2);
    original.resolve(playback('b'));
    await flush();
    expect(elements[1].hasAttribute('src')).toBe(false);
    restarted.resolve(playback('b'));
    await flush();
    expect(elements[1].src).toContain('/b/content');
    expect(state()).toMatchObject({phase: 'playing', index: 0});
  });
  it('keeps resumed playback usable when the restarted preload fails', async () => {
    const fetch = vi.fn(async (id: string) => {
      if (id === 'b') throw new Error('preload unavailable');
      return playback(id);
    });
    const {player, state} = setup(fetch);
    await player.jump(0);
    await player.toggle();
    await player.toggle();
    await flush();
    expect(fetch.mock.calls.filter(([id]) => id === 'b')).toHaveLength(2);
    expect(state()).toMatchObject({phase: 'playing', index: 0, error: null});
  });
  it('does not request a next clip when resuming the final video', async () => {
    const {player, getPlayback, state} = setup();
    await player.jump(2);
    await player.toggle();
    await player.toggle();
    expect(getPlayback.mock.calls.map(([id]) => id)).toEqual(['c', 'c']);
    expect(state()).toMatchObject({phase: 'playing', index: 2});
  });
  it('ignores stale same-slot fetches and never attaches after destruction', async () => {
    const old = deferred<PlaybackResponse>();
    const fetch = vi.fn((id: string) =>
      id === 'a' ? old.promise : Promise.resolve(playback(id)),
    );
    const {player, elements, state} = setup(fetch);
    const pending = player.jump(0);
    await player.jump(2);
    old.resolve(playback('a'));
    await pending;
    expect(elements[0].src).toContain('/c/content');
    expect(state()).toMatchObject({phase: 'playing', index: 2});
    const delayed = deferred<PlaybackResponse>();
    const second = setup(vi.fn(() => delayed.promise));
    const waiting = second.player.jump(0);
    second.player.destroy();
    delayed.resolve(playback('a'));
    await waiting;
    expect(second.elements[0].hasAttribute('src')).toBe(false);
  });
  it('ignores an outgoing clip error during a same-slot jump revalidation', async () => {
    const delayed = deferred<PlaybackResponse>();
    const fetch = vi.fn((id: string) =>
      id === 'c' ? delayed.promise : Promise.resolve(playback(id)),
    );
    const {player, elements, state} = setup(fetch);
    await player.jump(0);
    const pending = player.jump(2);
    expect(elements[0].src).toContain('/a/content');
    elements[0].dispatchEvent(new Event('error'));
    expect(state()).toMatchObject({phase: 'loading', index: 2, error: null});
    delayed.resolve(playback('c'));
    await pending;
    expect(elements[0].src).toContain('/c/content');
    expect(state()).toMatchObject({phase: 'playing', index: 2, error: null});
  });
  it('still reports an error from the selected preloaded clip during revalidation', async () => {
    const delayed = deferred<PlaybackResponse>();
    const fetch = vi.fn(async (id: string) => playback(id));
    const {player, elements, state} = setup(fetch);
    await player.jump(0);
    await flush();
    expect(elements[1].src).toContain('/b/content');
    fetch.mockImplementationOnce(() => delayed.promise);
    const pending = player.jump(1);
    elements[1].dispatchEvent(new Event('error'));
    expect(state()).toMatchObject({phase: 'error', index: 1});
    delayed.resolve(playback('b'));
    await pending;
    expect(state().phase).toBe('error');
    await player.toggle();
    expect(state()).toMatchObject({phase: 'playing', index: 1, error: null});
  });
  it('reports selected-source loading errors and ignores errors after source removal', async () => {
    const playing = deferred<void>();
    const {player, elements, state} = setup();
    vi.spyOn(elements[0], 'play').mockReturnValueOnce(playing.promise);
    const pending = player.jump(0);
    await flush();
    expect(state().phase).toBe('loading');
    elements[0].dispatchEvent(new Event('error'));
    expect(state().phase).toBe('error');
    playing.resolve();
    await pending;
    expect(state().phase).toBe('error');
    await player.jump(2);
    // Jumping to the last item removes the other slot's preload.
    expect(elements[1].hasAttribute('src')).toBe(false);
    elements[1].dispatchEvent(new Event('error'));
    expect(state()).toMatchObject({phase: 'playing', index: 2, error: null});
  });
  it('ignores stale play rejections after navigating to another clip', async () => {
    const old = deferred<void>();
    const {player, elements, state} = setup();
    vi.spyOn(elements[0], 'play').mockReturnValueOnce(old.promise);
    const pending = player.jump(0);
    await flush();
    await player.jump(1);
    old.reject(new Error('old abort'));
    await pending;
    expect(state()).toMatchObject({phase: 'playing', index: 1, error: null});
  });
  it('does not let a late preload replace a manually selected video', async () => {
    const delayed = deferred<PlaybackResponse>();
    const fetch = vi.fn((id: string) =>
      id === 'b' ? delayed.promise : Promise.resolve(playback(id)),
    );
    const {player, elements, state} = setup(fetch);
    await player.jump(0);
    await player.jump(2);
    delayed.resolve(playback('b'));
    await flush();
    expect(state()).toMatchObject({phase: 'playing', index: 2});
    expect(elements[1].hasAttribute('src')).toBe(false);
  });
  it('shows autoplay blocking with retry rather than silently skipping', async () => {
    const {player, elements, state} = setup();
    vi.spyOn(elements[0], 'play').mockRejectedValueOnce(
      new DOMException('blocked', 'NotAllowedError'),
    );
    await player.jump(0);
    expect(state().phase).toBe('error');
    expect(state().error).toContain('Retry video');
    await player.toggle();
    expect(state().phase).toBe('playing');
  });
  it('handles media errors and failed preloads without breaking the current clip', async () => {
    let denied = true;
    const fetch = vi.fn(async (id: string) => {
      if (id === 'b' && denied) throw new Error('no longer visible');
      return playback(id);
    });
    const {player, elements, state} = setup(fetch);
    await player.jump(0);
    await flush();
    expect(state().phase).toBe('playing');
    await player.next();
    expect(state().error).toBe('no longer visible');
    denied = false;
    await player.toggle();
    expect(state().phase).toBe('playing');
    elements[1].dispatchEvent(new Event('error'));
    expect(state().phase).toBe('error');
    await player.next();
    expect(state()).toMatchObject({phase: 'playing', index: 2});
  });
  it('rechecks access instead of trusting the next preloaded video', async () => {
    let hidden = false;
    const fetch = vi.fn(async (id: string) => {
      if (id === 'b' && hidden) throw new Error('Hidden');
      return playback(id);
    });
    const {player, state} = setup(fetch);
    await player.jump(0);
    await flush();
    hidden = true;
    await player.next();
    expect(state()).toMatchObject({phase: 'error', index: 1, error: 'Hidden'});
  });
});

describe('title cards and playback controls', () => {
  it('announces each clip on a countdown title card while preloading the next one', async () => {
    vi.useFakeTimers();
    const {player, elements, getPlayback, state} = setup(undefined, 5_000);
    await player.jump(0);
    await flush();
    expect(state()).toMatchObject({phase: 'title', index: 0, countdownSeconds: 5});
    expect(elements[0].src).toContain('/a/content');
    expect(elements[1].src).toContain('/b/content');
    expect(getPlayback.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    expect(play).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_100);
    expect(state().countdownSeconds).toBe(4);
    await vi.advanceTimersByTimeAsync(3_800);
    expect(state().phase).toBe('title');
    await vi.advanceTimersByTimeAsync(200);
    expect(state()).toMatchObject({phase: 'playing', index: 0, countdownSeconds: null});
    expect(play).toHaveBeenCalledOnce();
    // The next clip was preloaded during the title card; no duplicate request.
    expect(getPlayback.mock.calls.map(([id]) => id)).toEqual(['a', 'b']);
    elements[0].dispatchEvent(new Event('ended'));
    await flush();
    expect(state()).toMatchObject({phase: 'title', index: 1, countdownSeconds: 5});
  });
  it('skips the countdown on toggle and cancels it on navigation', async () => {
    vi.useFakeTimers();
    const {player, state} = setup(undefined, 5_000);
    await player.jump(0);
    await player.toggle();
    expect(state()).toMatchObject({phase: 'playing', index: 0, countdownSeconds: null});
    await vi.advanceTimersByTimeAsync(6_000);
    expect(play).toHaveBeenCalledOnce();
    await player.next();
    expect(state()).toMatchObject({phase: 'title', index: 1});
    await player.jump(2);
    await vi.advanceTimersByTimeAsync(6_000);
    expect(state()).toMatchObject({phase: 'playing', index: 2});
    // One play for the skipped card, one for clip c.
    expect(play).toHaveBeenCalledTimes(2);
  });
  it('fails from the title card when the announced source cannot load', async () => {
    vi.useFakeTimers();
    const {player, elements, state} = setup(undefined, 5_000);
    await player.jump(0);
    elements[0].dispatchEvent(new Event('error'));
    expect(state()).toMatchObject({phase: 'error', countdownSeconds: null});
    await vi.advanceTimersByTimeAsync(6_000);
    expect(state().phase).toBe('error');
    expect(play).not.toHaveBeenCalled();
  });
  it('reports progress, seeks, and applies speed and mute to both slots', async () => {
    const {player, elements, state} = setup();
    await player.jump(0);
    Object.defineProperty(elements[0], 'duration', {value: 42, configurable: true});
    elements[0].dispatchEvent(new Event('durationchange'));
    expect(state().durationSeconds).toBe(42);
    elements[0].currentTime = 10;
    elements[0].dispatchEvent(new Event('timeupdate'));
    expect(state().currentTime).toBe(10);
    elements[1].currentTime = 3;
    elements[1].dispatchEvent(new Event('timeupdate'));
    expect(state().currentTime).toBe(10);
    player.seek(99);
    expect(elements[0].currentTime).toBe(42);
    expect(state().currentTime).toBe(42);
    player.setPlaybackRate(1.5);
    player.setMuted(true);
    expect([elements[0].playbackRate, elements[1].playbackRate]).toEqual([1.5, 1.5]);
    expect([elements[0].muted, elements[1].muted]).toEqual([true, true]);
    expect(state()).toMatchObject({playbackRate: 1.5, muted: true});
    await player.next();
    expect(state()).toMatchObject({
      index: 1,
      playbackRate: 1.5,
      muted: true,
      currentTime: 0,
    });
  });
});
