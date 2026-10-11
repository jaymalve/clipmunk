import { z } from "zod";

/** Background music synthesized from code.
 * Every sample is computed here from a style, a seed and a length, so the result belongs
 * to whoever runs it: there is no recording, sample pack or third-party track involved.
 * The function is pure and deterministic, which is why the preview in the browser and the
 * export in Node produce the same sound.
 */
export const MUSIC_STYLES = ["upbeat", "lofi"] as const;
export type MusicStyle = (typeof MUSIC_STYLES)[number];

export const MusicSchema = z.strictObject({
  style: z.enum(MUSIC_STYLES),
  /** A different seed gives a different tune in the same style. */
  seed: z.number().int().min(0).max(999_999).default(1),
  gain: z.number().finite().min(0).max(2).default(0.5),
  /** Lower the music while a voice is speaking. */
  duck: z.boolean().default(true),
});
export type Music = z.output<typeof MusicSchema>;

export type RenderedMusic = { sampleRate: number; left: Float32Array; right: Float32Array; bpm: number };
export type MusicRequest = {
  style: MusicStyle;
  seed: number;
  durationMs: number;
  sampleRate?: number;
  /** Moments (in milliseconds) to mark with a soft swell and hit, such as the cuts of a sequence. */
  accentsMs?: readonly number[];
};

const TAU = Math.PI * 2;
const NOTE = (semitonesFromA4: number) => 440 * 2 ** (semitonesFromA4 / 12);

/** Small, fast, seedable random numbers: the same seed always gives the same tune. */
function random(seed: number) {
  let state = (seed * 2654435761 + 0x9e3779b9) >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Chord = { root: number; tones: number[] }; // semitones from the key's root
type Plan = { bpm: number; swing: number; major: boolean; progressions: number[][]; barsPerChord: number };
const PLANS: Record<MusicStyle, Plan> = {
  upbeat: { bpm: 118, swing: 0, major: true, barsPerChord: 1, progressions: [[0, 4, 5, 3], [5, 3, 0, 4], [0, 3, 5, 4]] },
  lofi: { bpm: 82, swing: 0.16, major: false, barsPerChord: 1, progressions: [[3, 6, 2, 5], [0, 5, 3, 6], [0, 3, 6, 2]] },
};
/** Gain into the soft clipper, set by ear-free measurement so each style sits at a similar loudness. */
const DRIVE: Record<MusicStyle, number> = { upbeat: 1.4, lofi: 1.7 };
/** Keeps each style's tunes independent of the others, and stable if a style is added or removed. */
const STYLE_SEED: Record<MusicStyle, number> = { upbeat: 1000, lofi: 2000 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11], MINOR = [0, 2, 3, 5, 7, 8, 10];

/** A chord built by stacking thirds on a scale degree; `sevenths` adds the fourth note. */
function chordOn(degree: number, scale: number[], sevenths: boolean): Chord {
  const at = (step: number) => scale[(degree + step) % 7]! + 12 * Math.floor((degree + step) / 7);
  return { root: at(0), tones: [at(0), at(2), at(4), ...(sevenths ? [at(6)] : [])] };
}

export function renderMusic(request: MusicRequest): RenderedMusic {
  const sampleRate = request.sampleRate ?? 44100;
  const length = Math.max(1, Math.round((request.durationMs / 1000) * sampleRate));
  const left = new Float32Array(length), right = new Float32Array(length);
  const plan = PLANS[request.style];
  const rng = random(request.seed + STYLE_SEED[request.style]);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;

  const key = pick([-12, -10, -9, -7, -5, -4]); // semitones from A4: roots between A3 and F4
  const scale = plan.major ? MAJOR : MINOR;
  const progression = pick(plan.progressions).map((degree) => chordOn(degree, scale, request.style !== "upbeat"));
  const beat = 60 / plan.bpm, bar = beat * 4;
  const seconds = length / sampleRate;

  /** Add a mono signal to both channels, with `pan` from -1 (left) to 1 (right). */
  const write = (index: number, value: number, pan: number) => {
    if (index < 0 || index >= length) return;
    left[index] = left[index]! + value * Math.min(1, 1 - pan);
    right[index] = right[index]! + value * Math.min(1, 1 + pan);
  };
  /** One note: `wave` gives the raw tone for a phase, `shape` its loudness over the note's life. */
  const note = (start: number, duration: number, frequency: number, level: number, pan: number, wave: (phase: number, age: number) => number, shape: (age: number, duration: number) => number, cutoff = 0) => {
    const from = Math.round(start * sampleRate), count = Math.round(duration * sampleRate);
    const step = (frequency * TAU) / sampleRate;
    // A one-pole low-pass takes the edge off bright waves; 0 leaves the tone as it is.
    const smoothing = cutoff > 0 ? 1 - Math.exp((-TAU * cutoff) / sampleRate) : 1;
    let phase = 0, filtered = 0;
    for (let i = 0; i < count && from + i < length; i++) {
      const age = i / sampleRate;
      filtered += smoothing * (wave(phase, age) - filtered);
      write(from + i, filtered * shape(age, duration) * level, pan);
      phase += step;
    }
  };
  const sine = (phase: number) => Math.sin(phase);
  const saw = (phase: number) => 2 * (phase / TAU - Math.floor(phase / TAU + 0.5));
  const triangle = (phase: number) => 2 * Math.abs(saw(phase)) - 1;
  const swell = (attack: number, release: number) => (age: number, duration: number) => Math.min(1, age / attack) * Math.min(1, Math.max(0, (duration - age) / release));
  const pluck = (decay: number) => (age: number, duration: number) => Math.min(1, age / 0.004) * Math.exp(-age / decay) * Math.min(1, Math.max(0, (duration - age) / 0.02));

  const noise = random(request.seed * 7 + 13);
  const kick = (start: number, level: number) =>
    note(start, 0.32, 1, level, 0, (_phase, age) => Math.sin(TAU * (48 * age + (62 / 28) * (1 - Math.exp(-age * 28)))), (age) => Math.exp(-age / 0.11));
  const snare = (start: number, level: number) => {
    note(start, 0.2, 190, level * 0.5, 0, sine, (age) => Math.exp(-age / 0.05));
    let previous = 0;
    note(start, 0.2, 1, level, 0.05, () => {
      const sample = noise() * 2 - 1, edge = sample - previous * 0.6;
      previous = sample;
      return edge;
    }, (age) => Math.exp(-age / 0.07));
  };
  const hat = (start: number, level: number, pan: number) => {
    let previous = 0;
    note(start, 0.06, 1, level, pan, () => {
      const sample = noise() * 2 - 1, edge = sample - previous;
      previous = sample;
      return edge;
    }, (age) => Math.exp(-age / 0.018));
  };

  const bars = Math.ceil(seconds / bar) + 1;
  for (let index = 0; index < bars; index++) {
    const start = index * bar;
    const chord = progression[Math.floor(index / plan.barsPerChord) % progression.length]!;
    const opensChord = index % plan.barsPerChord === 0;
    const swung = (eighth: number) => start + eighth * (beat / 2) + (eighth % 2 ? plan.swing * beat : 0);
    const tone = (semitone: number) => NOTE(key + semitone);

    // Chords: two slightly detuned voices per tone, held for the whole chord.
    if (opensChord) {
      const held = bar * plan.barsPerChord;
      chord.tones.forEach((semitone, voice) => {
        const level = (request.style === "lofi" ? 0.07 : 0.05) / Math.sqrt(chord.tones.length / 3);
        const cutoff = request.style === "lofi" ? 1100 : 1700;
        for (const [detune, pan] of [[-0.06, -0.55], [0.06, 0.55]] as const)
          note(start, held + 0.4, tone(semitone - 12 + detune), level, pan * (voice % 2 ? 1 : -1), request.style === "lofi" ? triangle : saw, swell(0.25, 0.5), cutoff);
      });
    }

    // Bass.
    const bassNote = tone(chord.root - 24);
    if (request.style === "upbeat") {
      for (let eighth = 0; eighth < 8; eighth++) note(swung(eighth), beat * 0.42, eighth === 6 ? bassNote * 1.5 : bassNote, 0.2, 0, triangle, pluck(0.2), 500);
    } else {
      for (const eighth of [0, 3, 5]) note(swung(eighth), beat * 0.8, bassNote, 0.22, 0, sine, pluck(0.35));
    }

    // Drums.
    if (request.style === "upbeat") {
      for (let quarter = 0; quarter < 4; quarter++) {
        kick(start + quarter * beat, 0.6);
        if (quarter % 2) snare(start + quarter * beat, 0.2);
        hat(start + quarter * beat + beat / 2, 0.1, 0.25);
      }
    } else if (request.style === "lofi") {
      for (const eighth of [0, 5]) kick(swung(eighth), 0.5);
      for (const eighth of [2, 6]) snare(swung(eighth), 0.17);
      for (let eighth = 0; eighth < 8; eighth++) hat(swung(eighth), 0.045 + rng() * 0.045, eighth % 2 ? 0.3 : -0.2);
    }

    // Melody: notes drawn from the chord, with an echo for space.
    const density = request.style === "upbeat" ? 0.72 : 0.36;
    for (let eighth = 0; eighth < 8; eighth++) {
      if (rng() > density) continue;
      const semitone = pick(chord.tones) + (rng() < 0.3 ? 12 : 0);
      const level = request.style === "upbeat" ? 0.075 : 0.085;
      const decay = request.style === "lofi" ? 0.45 : 0.22;
      const voice = (phase: number) => sine(phase) + (request.style === "lofi" ? 0.3 * sine(phase * 2) : 0.2 * triangle(phase * 2));
      for (const [echo, fade, pan] of [[0, 1, -0.2], [beat * 0.75, 0.38, 0.5], [beat * 1.5, 0.16, -0.5]] as const)
        note(swung(eighth) + echo, decay * 3, tone(semitone), level * fade, pan, voice, pluck(decay));
    }
  }

  // Accents: a breath of noise rising into a low thump, to underline a cut.
  for (const accent of request.accentsMs ?? []) {
    const at = accent / 1000;
    if (at < 0.4 || at > seconds - 0.2) continue;
    let previous = 0;
    note(at - 0.35, 0.35, 1, 0.11, 0, () => {
      const sample = noise() * 2 - 1;
      previous += 0.25 * (sample - previous);
      return sample - previous;
    }, (age) => (age / 0.35) ** 2);
    note(at, 0.5, 1, 0.42, 0, (_phase, age) => Math.sin(TAU * (42 * age + (40 / 18) * (1 - Math.exp(-age * 18)))), (age) => Math.exp(-age / 0.16));
  }

  if (request.style === "lofi") {
    // Tape hiss and the odd crackle.
    const dust = random(request.seed * 31 + 5);
    for (let i = 0; i < length; i++) {
      const hiss = (dust() * 2 - 1) * 0.006 + (dust() > 0.9996 ? (dust() * 2 - 1) * 0.12 : 0);
      left[i] = left[i]! + hiss;
      right[i] = right[i]! + hiss;
    }
  }

  // Master: a fixed gain per style (never one measured from the audio, so a longer clip or an
  // added accent cannot change how loud the rest is), peaks rounded off instead of clipped,
  // and the very top softened.
  const drive = DRIVE[request.style];
  const top = 1 - Math.exp((-TAU * (request.style === "upbeat" ? 11000 : 6000)) / sampleRate);
  let smoothLeft = 0, smoothRight = 0;
  for (let i = 0; i < length; i++) {
    smoothLeft += top * (Math.tanh(left[i]! * drive) - smoothLeft);
    smoothRight += top * (Math.tanh(right[i]! * drive) - smoothRight);
    left[i] = smoothLeft;
    right[i] = smoothRight;
  }
  const fadeIn = Math.min(length / 4, 0.5 * sampleRate), fadeOut = Math.min(length / 3, 1.6 * sampleRate);
  const level = 0.8; // tanh keeps every sample within 1, so this is the ceiling
  for (let i = 0; i < length; i++) {
    const fade = Math.max(0, Math.min(1, i / fadeIn, (length - 1 - i) / fadeOut));
    left[i] = left[i]! * level * fade;
    right[i] = right[i]! * level * fade;
  }
  return { sampleRate, left, right, bpm: plan.bpm };
}

/** The rendered music as a 16-bit stereo WAV file. */
export function encodeWav(music: RenderedMusic): Uint8Array {
  const frames = music.left.length;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => [...value].forEach((char, index) => view.setUint8(offset + index, char.charCodeAt(0)));
  text(0, "RIFF");
  view.setUint32(4, 36 + frames * 4, true);
  text(8, "WAVEfmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true); // PCM
  view.setUint16(22, 2, true); // stereo
  view.setUint32(24, music.sampleRate, true);
  view.setUint32(28, music.sampleRate * 4, true);
  view.setUint16(32, 4, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, frames * 4, true);
  for (let i = 0; i < frames; i++) {
    view.setInt16(44 + i * 4, Math.round(Math.max(-1, Math.min(1, music.left[i]!)) * 32767), true);
    view.setInt16(46 + i * 4, Math.round(Math.max(-1, Math.min(1, music.right[i]!)) * 32767), true);
  }
  return bytes;
}
