import {afterEach, describe, expect, it, vi} from 'vitest';
import {createLobbyMusic} from '../../src/app/player/lobby-music';
import {FakeAudioContext, stubAudioContext} from './fake-audio';

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe('lobby music', () => {
  it('schedules the loop on play and suspends after fading out on pause', async () => {
    vi.useFakeTimers();
    const context = new FakeAudioContext();
    stubAudioContext(context);
    const music = createLobbyMusic();
    await music.play();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.scheduledHits).toBeGreaterThan(0);
    music.pause();
    expect(context.suspend).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1_000);
    expect(context.suspend).toHaveBeenCalledOnce();
    music.destroy();
    expect(context.close).toHaveBeenCalledOnce();
  });
  it('stays silent when paused while the context is still resuming', async () => {
    const context = new FakeAudioContext();
    let resumed!: () => void;
    context.resume.mockImplementation(
      () =>
        new Promise<void>((done) => {
          resumed = done;
        }),
    );
    stubAudioContext(context);
    const music = createLobbyMusic();
    const playing = music.play();
    music.pause();
    resumed();
    await playing;
    expect(context.scheduledHits).toBe(0);
    music.destroy();
  });
});
