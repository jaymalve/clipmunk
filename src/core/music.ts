import { z } from "zod";
import { LAUNCH_BPM, renderLaunch } from "./launch-music";
import {
  createTape,
  hiss as noiseHiss,
  pluck,
  random,
  saw,
  sine,
  swell,
  TAU,
  type Tape,
  triangle,
  type Wave,
} from "./synth";

/** Background music synthesized from code.
 * Every sample is computed here from a style, a seed and a length, so the result belongs
 * to whoever runs it: there is no recording, sample pack or third-party track involved.
 * The function is pure and deterministic, which is why the preview in the browser and the
 * export in Node produce the same sound.
 */
export const MUSIC_STYLES = ["upbeat", "lofi", "launch"] as const;
export type MusicStyle = (typeof MUSIC_STYLES)[number];

export const MusicSchema = z.strictObject({
  style: z.enum(MUSIC_STYLES),
  /** A different seed gives a different tune in the same style. Left out, each clip gets its own tune from its name. */
  seed: z.number().int().min(0).max(999_999).optional(),
  gain: z.number().finite().min(0).max(2).default(0.5),
  /** Lower the music while a voice is speaking. */
  duck: z.boolean().default(true),
  /** Fit the tempo to the clip's key moments and mark them with accents. */
  sync: z.boolean().default(true),
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
  /** How strong those accents are, from 0 to 1. */
  accentLevel?: number;
  /** Tempo in beats per minute; the style's own tempo when left out. */
  bpm?: number;
  /** How far into its first beat the music starts, so the beat can be lined up with the picture. */
  phaseMs?: number;
};

const NOTE = (semitonesFromA4: number) => 440 * 2 ** (semitonesFromA4 / 12);

type Chord = { root: number; tones: number[] }; // semitones from the key's root
type Plan = { bpm: number; swing: number; major: boolean; progressions: number[][]; barsPerChord: number };
/** The styles built bar after bar from a plan; "launch" is arranged around its moments instead. */
type BarStyle = Exclude<MusicStyle, "launch">;
const PLANS: Record<BarStyle, Plan> = {
  upbeat: {
    bpm: 118,
    swing: 0,
    major: true,
    barsPerChord: 1,
    progressions: [
      [0, 4, 5, 3],
      [5, 3, 0, 4],
      [0, 3, 5, 4],
    ],
  },
  lofi: {
    bpm: 82,
    swing: 0.16,
    major: false,
    barsPerChord: 1,
    progressions: [
      [3, 6, 2, 5],
      [0, 5, 3, 6],
      [0, 3, 6, 2],
    ],
  },
};
/** Gain into the soft clipper, set by ear-free measurement so each style sits at a similar loudness. */
const DRIVE: Record<BarStyle, number> = { upbeat: 1.4, lofi: 1.7 };
/** Keeps each style's tunes independent of the others, and stable if a style is added or removed. */
const STYLE_SEED: Record<BarStyle, number> = { upbeat: 1000, lofi: 2000 };
const MAJOR = [0, 2, 4, 5, 7, 9, 11],
  MINOR = [0, 2, 3, 5, 7, 8, 10];

/** A chord built by stacking thirds on a scale degree; `sevenths` adds the fourth note. */
function chordOn(degree: number, scale: number[], sevenths: boolean): Chord {
  const at = (step: number) => scale[(degree + step) % 7]! + 12 * Math.floor((degree + step) / 7);
  return { root: at(0), tones: [at(0), at(2), at(4), ...(sevenths ? [at(6)] : [])] };
}

/** Drums made from a pitch-swept sine (kick) and shaped noise (snare, hi-hat). */
function drumKit(tape: Tape, noise: () => number) {
  const kickTone: Wave = (_phase, age) => Math.sin(TAU * (48 * age + (62 / 28) * (1 - Math.exp(-age * 28))));
  const hiss = (keep: number) => noiseHiss(noise, keep);
  return {
    kick: (start: number, level: number) =>
      tape.note(start, 0.32, 1, level, 0, kickTone, (age) => Math.exp(-age / 0.11)),
    snare(start: number, level: number) {
      tape.note(start, 0.2, 190, level * 0.5, 0, sine, (age) => Math.exp(-age / 0.05));
      tape.note(start, 0.2, 1, level, 0.05, hiss(0.6), (age) => Math.exp(-age / 0.07));
    },
    hat: (start: number, level: number, pan: number) =>
      tape.note(start, 0.06, 1, level, pan, hiss(1), (age) => Math.exp(-age / 0.018)),
  };
}

/** What one bar needs to know: where it starts, its chord, and the piece's shared settings. */
type Bar = {
  tape: Tape;
  style: BarStyle;
  plan: Plan;
  drums: ReturnType<typeof drumKit>;
  rng: () => number;
  start: number;
  beat: number;
  chord: Chord;
  opensChord: boolean;
  /** Pitch of a scale step in this piece's key. */
  tone: (semitone: number) => number;
  /** Time of an eighth note in this bar, with the style's swing. */
  swung: (eighth: number) => number;
};

/** Chords: two slightly detuned voices per tone, held for the whole chord. */
function playChords({ tape, style, plan, start, beat, chord, tone }: Bar) {
  const held = beat * 4 * plan.barsPerChord;
  chord.tones.forEach((semitone, voice) => {
    const level = (style === "lofi" ? 0.07 : 0.05) / Math.sqrt(chord.tones.length / 3);
    const cutoff = style === "lofi" ? 1100 : 1700;
    for (const [detune, pan] of [
      [-0.06, -0.55],
      [0.06, 0.55],
    ] as const)
      tape.note(
        start,
        held + 0.4,
        tone(semitone - 12 + detune),
        level,
        pan * (voice % 2 ? 1 : -1),
        style === "lofi" ? triangle : saw,
        swell(0.25, 0.5),
        cutoff,
      );
  });
}

function playBass({ tape, style, beat, chord, tone, swung }: Bar) {
  const root = tone(chord.root - 24);
  if (style === "upbeat") {
    // Driving eighth notes, lifting a fifth near the end of the bar.
    for (let eighth = 0; eighth < 8; eighth++)
      tape.note(swung(eighth), beat * 0.42, eighth === 6 ? root * 1.5 : root, 0.2, 0, triangle, pluck(0.2), 500);
  } else {
    for (const eighth of [0, 3, 5]) tape.note(swung(eighth), beat * 0.8, root, 0.22, 0, sine, pluck(0.35));
  }
}

function playDrums({ style, drums, rng, start, beat, swung }: Bar) {
  if (style === "upbeat") {
    for (let quarter = 0; quarter < 4; quarter++) {
      drums.kick(start + quarter * beat, 0.6);
      if (quarter % 2) drums.snare(start + quarter * beat, 0.2);
      drums.hat(start + quarter * beat + beat / 2, 0.1, 0.25);
    }
  } else {
    for (const eighth of [0, 5]) drums.kick(swung(eighth), 0.5);
    for (const eighth of [2, 6]) drums.snare(swung(eighth), 0.17);
    for (let eighth = 0; eighth < 8; eighth++) drums.hat(swung(eighth), 0.045 + rng() * 0.045, eighth % 2 ? 0.3 : -0.2);
  }
}

/** Melody: notes drawn from the chord, each with two quieter echoes for space. */
function playMelody({ tape, style, rng, beat, chord, tone, swung }: Bar) {
  const density = style === "upbeat" ? 0.72 : 0.36;
  const level = style === "upbeat" ? 0.075 : 0.085;
  const decay = style === "lofi" ? 0.45 : 0.22;
  const voice: Wave = (phase) =>
    sine(phase, 0) + (style === "lofi" ? 0.3 * sine(phase * 2, 0) : 0.2 * triangle(phase * 2, 0));
  for (let eighth = 0; eighth < 8; eighth++) {
    if (rng() > density) continue;
    const semitone = chord.tones[Math.floor(rng() * chord.tones.length)]! + (rng() < 0.3 ? 12 : 0);
    for (const [echo, fade, pan] of [
      [0, 1, -0.2],
      [beat * 0.75, 0.38, 0.5],
      [beat * 1.5, 0.16, -0.5],
    ] as const)
      tape.note(swung(eighth) + echo, decay * 3, tone(semitone), level * fade, pan, voice, pluck(decay));
  }
}

/** Accents: a breath of noise rising into a low thump, to underline a moment. */
function playAccents(tape: Tape, noise: () => number, accentsMs: readonly number[], accentLevel: number) {
  const seconds = tape.length / tape.sampleRate;
  const level = Math.max(0, Math.min(1, accentLevel));
  const thump: Wave = (_phase, age) => Math.sin(TAU * (42 * age + (40 / 18) * (1 - Math.exp(-age * 18))));
  for (const accent of accentsMs) {
    const at = accent / 1000;
    if (at < 0.4 || at > seconds - 0.2) continue;
    let previous = 0;
    const breath: Wave = () => {
      const sample = noise() * 2 - 1;
      previous += 0.25 * (sample - previous);
      return sample - previous;
    };
    tape.note(at - 0.35, 0.35, 1, 0.11 * level, 0, breath, (age) => (age / 0.35) ** 2);
    tape.note(at, 0.5, 1, 0.42 * level, 0, thump, (age) => Math.exp(-age / 0.16));
  }
}

/** Lo-fi's tape hiss and the odd crackle. */
function addTapeNoise(tape: Tape, seed: number) {
  const dust = random(seed * 31 + 5);
  for (let i = 0; i < tape.length; i++) {
    const hiss = (dust() * 2 - 1) * 0.006 + (dust() > 0.9996 ? (dust() * 2 - 1) * 0.12 : 0);
    tape.left[i] = tape.left[i]! + hiss;
    tape.right[i] = tape.right[i]! + hiss;
  }
}

/** Master: a fixed gain per style (never one measured from the audio, so a longer clip or an
 * added accent cannot change how loud the rest is), peaks rounded off instead of clipped, the
 * very top softened, and a fade at each end.
 */
function master({ left, right, length, sampleRate }: Tape, style: BarStyle) {
  const drive = DRIVE[style];
  const top = 1 - Math.exp((-TAU * (style === "upbeat" ? 11000 : 6000)) / sampleRate);
  let smoothLeft = 0,
    smoothRight = 0;
  for (let i = 0; i < length; i++) {
    smoothLeft += top * (Math.tanh(left[i]! * drive) - smoothLeft);
    smoothRight += top * (Math.tanh(right[i]! * drive) - smoothRight);
    left[i] = smoothLeft;
    right[i] = smoothRight;
  }
  const fadeIn = Math.min(length / 4, 0.5 * sampleRate),
    fadeOut = Math.min(length / 3, 1.6 * sampleRate);
  const level = 0.8; // tanh keeps every sample within 1, so this is the ceiling
  for (let i = 0; i < length; i++) {
    const fade = Math.max(0, Math.min(1, i / fadeIn, (length - 1 - i) / fadeOut));
    left[i] = left[i]! * level * fade;
    right[i] = right[i]! * level * fade;
  }
}

export function renderMusic(request: MusicRequest): RenderedMusic {
  if (request.style === "launch") return renderLaunch(request);
  const style = request.style;
  const sampleRate = request.sampleRate ?? 44100;
  const tape = createTape(Math.max(1, Math.round((request.durationMs / 1000) * sampleRate)), sampleRate);
  const plan = PLANS[style];
  // Two independent streams: one chooses the notes, the other is the sound of the drums and accents.
  const rng = random(request.seed + STYLE_SEED[style]);
  const noise = random(request.seed * 7 + 13);
  const pick = <T>(items: readonly T[]) => items[Math.floor(rng() * items.length)]!;

  const key = pick([-12, -10, -9, -7, -5, -4]); // semitones from A4: roots between A3 and F4
  const scale = plan.major ? MAJOR : MINOR;
  const progression = pick(plan.progressions).map((degree) => chordOn(degree, scale, style !== "upbeat"));
  const bpm = request.bpm ?? plan.bpm;
  const beat = 60 / bpm,
    bar = beat * 4;
  const phase = Math.max(0, request.phaseMs ?? 0) / 1000;
  const drums = drumKit(tape, noise);

  const bars = Math.ceil((tape.length / sampleRate + phase) / bar) + 1;
  for (let index = 0; index < bars; index++) {
    const start = index * bar - phase;
    const current: Bar = {
      tape,
      style,
      plan,
      drums,
      rng,
      start,
      beat,
      chord: progression[Math.floor(index / plan.barsPerChord) % progression.length]!,
      opensChord: index % plan.barsPerChord === 0,
      tone: (semitone) => NOTE(key + semitone),
      swung: (eighth) => start + eighth * (beat / 2) + (eighth % 2 ? plan.swing * beat : 0),
    };
    // The order matters: each part draws from the same random stream.
    if (current.opensChord) playChords(current);
    playBass(current);
    playDrums(current);
    playMelody(current);
  }
  playAccents(tape, noise, request.accentsMs ?? [], request.accentLevel ?? 1);
  if (style === "lofi") addTapeNoise(tape, request.seed);
  master(tape, style);
  return { sampleRate, left: tape.left, right: tape.right, bpm };
}

/** The style's own tempo, before any fitting. */
export const styleTempo = (style: MusicStyle): number => (style === "launch" ? LAUNCH_BPM : PLANS[style].bpm);

/** A tune number from a clip's name, so every clip gets its own music and keeps it across exports. */
export function seedFor(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return (hash >>> 0) % 1_000_000;
}

const OFFBEAT_COST_MS = 12;

/** Choose a tempo near the style's own, and a starting point within the first beat, so that
 * beats, or the points halfway between them, fall on the given moments. Tempo moves by at
 * most `tolerance` (8% by default), which keeps the style's feel, so several unrelated moments
 * cannot always be matched exactly: `errorMs` reports how far, on average, a moment is from
 * the rhythm. Accents are placed on the moments themselves and do not depend on this fit.
 */
export function fitTempo(
  baseBpm: number,
  momentsMs: readonly number[],
  tolerance = 0.08,
): { bpm: number; phaseMs: number; errorMs: number } {
  if (!momentsMs.length) return { bpm: baseBpm, phaseMs: 0, errorMs: 0 };
  let best = { bpm: baseBpm, phaseMs: 0, errorMs: Number.POSITIVE_INFINITY };
  // Step outward from the style's own tempo, so that exact tempo is always one of the candidates.
  const steps = Math.floor((baseBpm * tolerance) / 0.25);
  for (let step = -steps; step <= steps; step++) {
    const bpm = baseBpm + step * 0.25;
    const beat = 60_000 / bpm;
    // The best starting point always puts one of the moments exactly on a beat, so try each.
    for (const anchor of momentsMs) {
      const phaseMs = (beat - (anchor % beat)) % beat;
      let total = 0;
      for (const moment of momentsMs) {
        const position = (moment + phaseMs) / beat;
        const toBeat = Math.abs(position - Math.round(position)) * beat;
        // Halfway between beats is still on the rhythm (the hi-hat plays there), so it counts,
        // at a small cost that makes a full beat win when both are possible.
        const toHalf = Math.abs(position * 2 - Math.round(position * 2)) * (beat / 2) + OFFBEAT_COST_MS;
        total += Math.min(toBeat, toHalf);
      }
      const errorMs = total / momentsMs.length;
      // Prefer the style's own tempo when two candidates fit equally well.
      if (
        errorMs < best.errorMs - 0.5 ||
        (Math.abs(errorMs - best.errorMs) <= 0.5 && Math.abs(bpm - baseBpm) < Math.abs(best.bpm - baseBpm))
      )
        best = { bpm: Math.round(bpm * 100) / 100, phaseMs, errorMs };
    }
  }
  return best;
}

/** Everything needed to render a clip's music: its own tune unless one was chosen, and, with
 * `sync` on, a tempo fitted to the clip's key moments with an accent on each. The studio and
 * the exporter both call this, so they render the same thing.
 */
export function planMusic(
  music: Music,
  clip: { key: string; durationMs: number; momentsMs?: readonly number[]; accentLevel?: number },
): MusicRequest {
  const base: MusicRequest = { style: music.style, seed: music.seed ?? seedFor(clip.key), durationMs: clip.durationMs };
  const moments = (clip.momentsMs ?? []).filter((moment) => moment > 300 && moment < clip.durationMs - 200);
  if (!music.sync || !moments.length) return base;
  const fit = fitTempo(styleTempo(music.style), moments);
  return { ...base, bpm: fit.bpm, phaseMs: fit.phaseMs, accentsMs: moments, accentLevel: clip.accentLevel ?? 0.6 };
}

/** The rendered music as a 16-bit stereo WAV file. */
export function encodeWav(music: RenderedMusic): Uint8Array {
  const frames = music.left.length;
  const bytes = new Uint8Array(44 + frames * 4);
  const view = new DataView(bytes.buffer);
  const text = (offset: number, value: string) => {
    for (let index = 0; index < value.length; index++) view.setUint8(offset + index, value.charCodeAt(index));
  };
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
