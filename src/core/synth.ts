/** The building blocks Clipmunk's generated sound is made from: seedable random numbers,
 * a few raw waves and envelopes, and a stereo tape to write notes onto. Music and sound
 * effects share them, so both stay pure, deterministic and free of any recording.
 */
export const TAU = Math.PI * 2;

/** Small, fast, seedable random numbers: the same seed always gives the same tune. */
export function random(seed: number) {
  let state = (seed * 2654435761 + 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type Wave = (phase: number, age: number) => number;
export type Envelope = (age: number, duration: number) => number;
export const sine: Wave = (phase) => Math.sin(phase);
export const saw: Wave = (phase) => 2 * (phase / TAU - Math.floor(phase / TAU + 0.5));
export const triangle: Wave = (phase) => 2 * Math.abs(saw(phase, 0)) - 1;
/** Fades in over `attack` seconds and out over the last `release` seconds. */
export const swell =
  (attack: number, release: number): Envelope =>
  (age, duration) =>
    Math.min(1, age / attack) * Math.min(1, Math.max(0, (duration - age) / release));
/** Starts at once and dies away, like a plucked string. */
export const pluck =
  (decay: number): Envelope =>
  (age, duration) =>
    Math.min(1, age / 0.004) * Math.exp(-age / decay) * Math.min(1, Math.max(0, (duration - age) / 0.02));

/** The stereo buffer being filled, and the one way sound gets onto it. */
export type Tape = {
  sampleRate: number;
  length: number;
  left: Float32Array;
  right: Float32Array;
  /** One note: `wave` gives the raw tone for a phase, `shape` its loudness over the note's life.
   * `pan` runs from -1 (left) to 1 (right). A `cutoff` above 0 low-passes the tone.
   */
  note(
    start: number,
    duration: number,
    frequency: number,
    level: number,
    pan: number,
    wave: Wave,
    shape: Envelope,
    cutoff?: number,
  ): void;
};

export function createTape(length: number, sampleRate: number): Tape {
  const left = new Float32Array(length),
    right = new Float32Array(length);
  const write = (index: number, value: number, pan: number) => {
    if (index < 0 || index >= length) return;
    left[index] = left[index]! + value * Math.min(1, 1 - pan);
    right[index] = right[index]! + value * Math.min(1, 1 + pan);
  };
  const note: Tape["note"] = (start, duration, frequency, level, pan, wave, shape, cutoff = 0) => {
    const from = Math.round(start * sampleRate),
      count = Math.round(duration * sampleRate);
    const step = (frequency * TAU) / sampleRate;
    // A one-pole low-pass takes the edge off bright waves; 0 leaves the tone as it is.
    const smoothing = cutoff > 0 ? 1 - Math.exp((-TAU * cutoff) / sampleRate) : 1;
    let phase = 0,
      filtered = 0;
    for (let i = 0; i < count && from + i < length; i++) {
      const age = i / sampleRate;
      filtered += smoothing * (wave(phase, age) - filtered);
      write(from + i, filtered * shape(age, duration) * level, pan);
      phase += step;
    }
  };
  return { sampleRate, length, left, right, note };
}

/** White noise with its low end removed; `keep` is how much of the previous sample is subtracted. */
export function hiss(noise: () => number, keep: number): Wave {
  let previous = 0;
  return () => {
    const sample = noise() * 2 - 1,
      edge = sample - previous * keep;
    previous = sample;
    return edge;
  };
}
