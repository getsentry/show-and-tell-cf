import {vi} from 'vitest';

/** Just enough of the Web Audio graph for the lobby synth; jsdom has none. */
class FakeParam {
  value = 0;
  setValueAtTime() {}
  linearRampToValueAtTime() {}
  exponentialRampToValueAtTime() {}
  cancelScheduledValues() {}
}

class FakeNode {
  gain = new FakeParam();
  frequency = new FakeParam();
  type = '';
  buffer: FakeBuffer | null = null;
  onended: (() => void) | null = null;
  connect<T>(destination: T) {
    return destination;
  }
  disconnect() {}
  start() {}
  stop() {}
}

class FakeBuffer {
  constructor(readonly length: number) {}
  getChannelData() {
    return new Float32Array(this.length);
  }
}

export class FakeAudioContext {
  currentTime = 0;
  sampleRate = 1_000;
  destination = new FakeNode();
  /** Buffer sources are only created for scheduled shaker hits. */
  scheduledHits = 0;
  resume = vi.fn(async () => {});
  suspend = vi.fn(async () => {});
  close = vi.fn(async () => {});
  createGain() {
    return new FakeNode();
  }
  createBiquadFilter() {
    return new FakeNode();
  }
  createConvolver() {
    return new FakeNode();
  }
  createDynamicsCompressor() {
    return new FakeNode();
  }
  createBufferSource() {
    this.scheduledHits++;
    return new FakeNode();
  }
  createOscillator() {
    return new FakeNode();
  }
  createBuffer(_channels: number, length: number) {
    return new FakeBuffer(length);
  }
}

/** Installs `context` as the global AudioContext constructor. */
export function stubAudioContext(context: FakeAudioContext) {
  vi.stubGlobal(
    'AudioContext',
    vi.fn(function () {
      return context;
    }),
  );
}
