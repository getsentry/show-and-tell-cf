/** Lobby music for the screening page while people trickle into the call.
 *
 * A gentle bossa-lounge loop synthesised live with Web Audio, so there is no
 * audio asset to license, host, or download. The context is created lazily on
 * the first play, which always comes from a user gesture.
 */

const BPM = 84;
const BEAT_S = 60 / BPM;
const BAR_S = BEAT_S * 4;
/** Schedule notes this far ahead so timer jitter never causes gaps. */
const LOOKAHEAD_S = 1;
const SCHEDULE_INTERVAL_MS = 200;
const FADE_S = 0.4;
const MASTER_VOLUME = 0.5;

interface Bar {
  /** Bass root, as a MIDI note number. */
  bass: number;
  /** Electric-piano voicing, as MIDI note numbers. */
  chord: number[];
  /** Vibraphone melody as [beat, MIDI note, length in beats]. */
  melody: Array<[number, number, number]>;
}

/** Sixteen bars in F major: I–vi–ii–V, a iii–VI turnaround, and a IV–iv lift. */
const SONG: Bar[] = [
  // Fmaj7
  {
    bass: 41,
    chord: [53, 57, 60, 64],
    melody: [
      [0, 76, 1.5],
      [1.5, 72, 0.5],
      [2, 69, 1],
      [3, 72, 1],
    ],
  },
  // Dm7
  {
    bass: 38,
    chord: [53, 57, 60, 62],
    melody: [
      [0, 74, 1.5],
      [1.5, 69, 0.5],
      [2, 65, 2],
    ],
  },
  // Gm7
  {
    bass: 43,
    chord: [53, 58, 62, 67],
    melody: [
      [0, 70, 1],
      [1, 74, 1],
      [2, 77, 1.5],
      [3.5, 76, 0.5],
    ],
  },
  // C9
  {
    bass: 36,
    chord: [52, 58, 62, 67],
    melody: [
      [0, 74, 1],
      [1, 72, 1],
      [2, 70, 2],
    ],
  },
  // Am7
  {
    bass: 45,
    chord: [55, 60, 64, 69],
    melody: [
      [0, 72, 1.5],
      [1.5, 76, 0.5],
      [2, 79, 1],
      [3, 76, 1],
    ],
  },
  // D9
  {
    bass: 38,
    chord: [54, 60, 64, 69],
    melody: [
      [0, 78, 2],
      [2, 74, 1],
      [3, 72, 1],
    ],
  },
  // Gm7
  {
    bass: 43,
    chord: [53, 58, 62, 67],
    melody: [
      [0, 70, 1.5],
      [1.5, 69, 0.5],
      [2, 67, 1],
      [3, 70, 1],
    ],
  },
  // C9
  {bass: 36, chord: [52, 58, 62, 67], melody: [[0, 67, 3]]},
  // Bbmaj7
  {
    bass: 46,
    chord: [53, 57, 62, 65],
    melody: [
      [0, 69, 1.5],
      [1.5, 74, 0.5],
      [2, 77, 2],
    ],
  },
  // Bbm6
  {
    bass: 46,
    chord: [53, 55, 61, 65],
    melody: [
      [0, 77, 1],
      [1, 73, 1],
      [2, 70, 2],
    ],
  },
  // Am7
  {
    bass: 45,
    chord: [55, 60, 64, 69],
    melody: [
      [0, 72, 1.5],
      [1.5, 76, 0.5],
      [2, 79, 1],
      [3, 76, 1],
    ],
  },
  // D9
  {
    bass: 38,
    chord: [54, 60, 64, 69],
    melody: [
      [0, 78, 1],
      [1, 76, 1],
      [2, 74, 1],
      [3, 72, 1],
    ],
  },
  // Gm7
  {
    bass: 43,
    chord: [53, 58, 62, 67],
    melody: [
      [0, 70, 1],
      [1, 74, 1],
      [2, 77, 1],
      [3, 81, 1],
    ],
  },
  // C9
  {
    bass: 36,
    chord: [52, 58, 62, 67],
    melody: [
      [0, 79, 1.5],
      [1.5, 76, 0.5],
      [2, 72, 1],
      [3, 70, 1],
    ],
  },
  // Fmaj7
  {bass: 41, chord: [53, 57, 60, 64], melody: [[0, 69, 3]]},
  // C9, leading back to the top
  {
    bass: 36,
    chord: [52, 58, 62, 67],
    melody: [
      [2, 67, 0.5],
      [2.5, 69, 0.5],
      [3, 72, 1],
    ],
  },
];

/** Bossa comping: [beat, length in beats, relative velocity]. */
const COMP: Array<[number, number, number]> = [
  [0, 1.2, 1],
  [1.5, 0.8, 0.7],
  [3, 0.8, 0.8],
];
/** Shaker accents on each eighth note. */
const SHAKER = [0.35, 1, 0.55, 1, 0.35, 1, 0.55, 1];

export interface LobbyMusic {
  play(): Promise<void>;
  pause(): void;
  destroy(): void;
}

export function createLobbyMusic(): LobbyMusic {
  let graph: Graph | null = null;
  let wanted = false;
  let destroyed = false;
  let scheduler: ReturnType<typeof setInterval> | null = null;
  let suspendTimer: ReturnType<typeof setTimeout> | null = null;
  let nextBarTime = 0;
  let barIndex = 0;

  function stopTimers() {
    if (scheduler) clearInterval(scheduler);
    if (suspendTimer) clearTimeout(suspendTimer);
    scheduler = null;
    suspendTimer = null;
  }

  function schedule() {
    if (!graph) return;
    const horizon = graph.context.currentTime + LOOKAHEAD_S;
    while (nextBarTime < horizon) {
      scheduleBar(graph, SONG[barIndex], nextBarTime);
      nextBarTime += BAR_S;
      barIndex = (barIndex + 1) % SONG.length;
    }
  }

  return {
    async play() {
      if (destroyed) return;
      wanted = true;
      graph ??= buildGraph(new AudioContext());
      const {context, master} = graph;
      if (suspendTimer) clearTimeout(suspendTimer);
      suspendTimer = null;
      await context.resume();
      // A pause or teardown while the context was resuming wins.
      if (!wanted || destroyed) return;
      const now = context.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(MASTER_VOLUME, now + FADE_S);
      if (nextBarTime < now) nextBarTime = now + 0.05;
      schedule();
      scheduler ??= setInterval(schedule, SCHEDULE_INTERVAL_MS);
    },
    pause() {
      wanted = false;
      if (!graph) return;
      const {context, master} = graph;
      stopTimers();
      const now = context.currentTime;
      master.gain.cancelScheduledValues(now);
      master.gain.setValueAtTime(master.gain.value, now);
      master.gain.linearRampToValueAtTime(0, now + FADE_S);
      // Suspend after the fade so a paused lobby costs no audio processing.
      suspendTimer = setTimeout(
        () => {
          suspendTimer = null;
          if (!wanted && !destroyed) void context.suspend();
        },
        FADE_S * 1_000 + 50,
      );
    },
    destroy() {
      destroyed = true;
      wanted = false;
      stopTimers();
      if (graph) void graph.context.close();
      graph = null;
    },
  };
}

function buildGraph(context: AudioContext) {
  const master = context.createGain();
  master.gain.value = 0;
  const compressor = context.createDynamicsCompressor();
  master.connect(compressor).connect(context.destination);

  const reverb = context.createConvolver();
  reverb.buffer = impulse(context, 2.4);
  const reverbReturn = context.createGain();
  reverbReturn.gain.value = 0.35;
  reverb.connect(reverbReturn).connect(master);

  const bus = (filter: BiquadFilterType, frequency: number, send: number) => {
    const input = context.createBiquadFilter();
    input.type = filter;
    input.frequency.value = frequency;
    input.connect(master);
    const sendGain = context.createGain();
    sendGain.gain.value = send;
    input.connect(sendGain).connect(reverb);
    return input;
  };

  // Vibraphone tremolo: a slow LFO wobbling the melody bus gain.
  const vibes = context.createGain();
  vibes.gain.value = 0.85;
  const tremolo = context.createOscillator();
  tremolo.frequency.value = 5;
  const tremoloDepth = context.createGain();
  tremoloDepth.gain.value = 0.15;
  tremolo.connect(tremoloDepth).connect(vibes.gain);
  tremolo.start();
  vibes.connect(bus('lowpass', 5_000, 0.5));

  return {
    context,
    master,
    bass: bus('lowpass', 420, 0.1),
    keys: bus('lowpass', 1_800, 0.35),
    vibes,
    shaker: bus('highpass', 6_500, 0.2),
    noise: noiseBuffer(context),
  };
}

type Graph = ReturnType<typeof buildGraph>;

function scheduleBar(graph: Graph, bar: Bar, start: number) {
  const at = (beat: number) => start + beat * BEAT_S;
  for (const [beat, root, length] of [
    [0, bar.bass, 1.4],
    [2, bar.bass + 7, 1.4],
  ]) {
    tone(graph, graph.bass, 'triangle', root, at(beat), length * BEAT_S, 0.32);
  }
  for (const [beat, length, velocity] of COMP) {
    for (const note of bar.chord) {
      const duration = length * BEAT_S;
      tone(graph, graph.keys, 'sine', note, at(beat), duration, 0.05 * velocity);
      // A quiet octave partial gives the sine a Rhodes-like tine.
      tone(graph, graph.keys, 'triangle', note + 12, at(beat), duration * 0.5, 0.008);
    }
  }
  for (const [beat, note, length] of bar.melody) {
    const duration = length * BEAT_S;
    tone(graph, graph.vibes, 'sine', note, at(beat), duration + 0.6, 0.09);
    // Vibraphone bars ring with a strong, short-lived fourth partial.
    tone(graph, graph.vibes, 'sine', note + 24, at(beat), 0.25, 0.012);
  }
  SHAKER.forEach((accent, eighth) => shake(graph, at(eighth / 2), 0.02 * accent));
}

function tone(
  graph: Graph,
  destination: AudioNode,
  type: OscillatorType,
  midi: number,
  start: number,
  duration: number,
  peak: number,
) {
  const {context} = graph;
  const oscillator = context.createOscillator();
  oscillator.type = type;
  oscillator.frequency.value = 440 * 2 ** ((midi - 69) / 12);
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(peak, start + 0.012);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + duration + 0.5);
  oscillator.connect(envelope).connect(destination);
  oscillator.start(start);
  oscillator.stop(start + duration + 0.6);
  oscillator.onended = () => envelope.disconnect();
}

function shake(graph: Graph, start: number, peak: number) {
  const {context, noise} = graph;
  const source = context.createBufferSource();
  source.buffer = noise;
  const envelope = context.createGain();
  envelope.gain.setValueAtTime(0.0001, start);
  envelope.gain.exponentialRampToValueAtTime(peak, start + 0.005);
  envelope.gain.exponentialRampToValueAtTime(0.0001, start + 0.07);
  source.connect(envelope).connect(graph.shaker);
  source.start(start, Math.random() * 0.5, 0.08);
  source.onended = () => envelope.disconnect();
}

function noiseBuffer(context: AudioContext) {
  const buffer = context.createBuffer(1, context.sampleRate, context.sampleRate);
  const data = buffer.getChannelData(0);
  for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
  return buffer;
}

/** A decaying noise tail standing in for a small, warm room. */
function impulse(context: AudioContext, seconds: number) {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < length; i++)
      data[i] = (Math.random() * 2 - 1) * (1 - i / length) ** 3;
  }
  return buffer;
}
