import type { MusicRequest, RenderedMusic } from "./music";
import { createTape, hiss, pluck, random, saw, sine, swell, TAU, type Tape, triangle, type Wave } from "./synth";

/** The "launch" style: the sound of a short product launch video. Half-time drums over a fast
 * pulse (75 beats a minute, felt as 150), rolling
 * hi-hats, a quiet intro that drops on a key moment, a beat of silence before the biggest
 * moments, and a last hit that rings out over the end card.
 *
 * Unlike the other styles it is arranged around the clip's moments rather than repeated bar
 * after bar, so it is built separately from them.
 */
export const LAUNCH_BPM = 75;

const hz = (midi: number) => 440 * 2 ** ((midi - 69) / 12);

/** Chords per half bar, as MIDI notes around middle C in G minor: A is Ebmaj7 to F, B is
 * Gm to A7 over C#, and B2 answers with Gm to F. A piece moves them all to its own key.
 */
const CHORDS = {
  A: [
    [63, 67, 70, 74],
    [65, 69, 72, 77],
  ],
  B: [
    [67, 70, 74, 79],
    [64, 67, 69, 73],
  ],
  B2: [
    [67, 70, 74, 79],
    [65, 69, 72, 77],
  ],
};
const KICKS: Record<keyof typeof CHORDS, number[]> = { A: [0, 5, 7, 10], B: [0, 2, 7, 9, 12], B2: [0, 2, 7, 9, 12] };
const ORDER: (keyof typeof CHORDS)[] = ["A", "B", "A", "B2"];
/** The top note of the short pluck that answers each bar, per pattern. */
const PLUCKS: Record<keyof typeof CHORDS, number[]> = { A: [79, 74, 82], B: [82, 79, 77], B2: [82, 81, 79] };

/** A held note on its own layer, kept as data until the gaps have been cut out of it. */
type Held = { at: number; seconds: number; midi: number; level: number; cutoff?: number };

export function renderLaunch(request: MusicRequest): RenderedMusic {
  const sampleRate = request.sampleRate ?? 44100;
  const total = request.durationMs / 1000;
  const length = Math.max(1, Math.round(total * sampleRate));
  const kit = createTape(length, sampleRate); // drums: never ducked
  const keys = createTape(length, sampleRate); // chords and plucks: ducked under the kick
  const rng = random(request.seed + 3000);
  const noise = random(request.seed * 7 + 13);
  const bpm = request.bpm ?? LAUNCH_BPM;
  const BAR = (60 / bpm) * 4,
    S16 = BAR / 16;
  const level = Math.max(0, Math.min(1, request.accentLevel ?? 1));
  // Each piece sits a few semitones either side of G minor.
  const shift = [-2, -1, 0, 1, 2, 3][Math.floor(rng() * 6)]!;

  // ── Where things happen. The drop lands on the first moment a bar or more in, so the
  // music opens up when the picture does; without one, after up to two bars of intro.
  const moments = [...(request.accentsMs ?? [])].map((ms) => ms / 1000).filter((at) => at > 0.4 && at < total - 0.2);
  const introBars = total >= 16 ? 2 : total >= 8 ? 1 : 0;
  const drop = moments.find((at) => at >= BAR * 0.9 && at <= BAR * 3) ?? introBars * BAR;
  // The ending lands on a late moment if there is one, or on the last bar line that leaves
  // time to ring out; a short clip just fades.
  const late = moments.filter((at) => at >= drop + BAR && at >= total - 6).at(-1);
  let end = Number.POSITIVE_INFINITY;
  if (late !== undefined) end = late;
  else if (total >= 10) for (let at = drop + BAR; at <= total - 2.4; at += BAR) end = at;
  // The biggest moments, no closer than two bars apart, and the ending are landings: the
  // music stops on its own beat, is silent for a moment, and lands on the moment itself.
  // From each landing the beat is counted afresh, so a moment that falls between the
  // music's beats still sounds on time. The silence takes up the difference.
  const gaps: number[] = [];
  for (const at of moments)
    if (at > drop + BAR / 2 && at < end - 0.01 && at - (gaps.at(-1) ?? Number.NEGATIVE_INFINITY) >= BAR * 2)
      gaps.push(at);
  const anchors = [drop, ...gaps];
  const sectionOf = (at: number) => anchors.filter((anchor) => anchor <= at + 0.001).at(-1) ?? drop;
  /** The nearest sixteenth to `at` on the beat counted from the last landing. */
  const onBeat = (at: number) => {
    const anchor = sectionOf(at);
    return anchor + Math.round((at - anchor) / S16) * S16;
  };
  // Each silence starts on the last sixteenth at least two before its landing.
  const silences: [from: number, to: number][] = [];
  for (const landing of Number.isFinite(end) && end < total ? [...gaps, end] : gaps) {
    const anchor = anchors.filter((at) => at < landing - 0.001).at(-1) ?? drop;
    const from = anchor + Math.floor((landing - 2 * S16 - anchor) / S16 + 0.001) * S16;
    if (from > anchor + S16) silences.push([from, landing]);
  }
  const inGap = (at: number) => silences.some(([from, to]) => at >= from - 0.001 && at < to - 0.001);

  // ── Instruments
  const kicks: number[] = [];
  const kick = (at: number, gain: number) => {
    if (inGap(at) || at >= end + 0.01) return;
    kicks.push(at);
    kit.note(
      at,
      0.28,
      1,
      gain,
      0,
      (_p, age) => Math.sin(TAU * (52 * age + (95 / 30) * (1 - Math.exp(-age * 30)))),
      (age) => Math.exp(-age / 0.09),
    );
  };
  const clap = (at: number, gain: number) => {
    if (inGap(at) || at >= end + 0.01) return;
    for (const [delay, part] of [
      [0, 1],
      [0.011, 0.75],
      [0.023, 0.6],
    ] as const)
      kit.note(at + delay, 0.24, 1, gain * part, 0, hiss(noise, 0.55), (age) => Math.exp(-age / 0.06));
    kit.note(at, 0.12, 210, gain * 0.35, 0, sine, (age) => Math.exp(-age / 0.03));
  };
  const hat = (at: number, gain: number, pan: number) => {
    if (inGap(at) || at >= end - 0.001) return;
    kit.note(at, 0.045, 1, gain, pan, hiss(noise, 1), (age) => Math.exp(-age / 0.012));
  };
  const openHat = (at: number, gain: number) => {
    if (inGap(at) || at >= end - 0.001) return;
    kit.note(at, 0.25, 1, gain, 0.2, hiss(noise, 1), (age) => Math.exp(-age / 0.08));
  };
  const crash = (at: number, gain: number) =>
    kit.note(at, 1.4, 1, gain, -0.15, hiss(noise, 0.97), (age) => Math.min(1, age / 0.002) * Math.exp(-age / 0.45));

  const chords: Held[] = [];
  const plucked = (at: number, midi: number, gain: number) => {
    if (inGap(at) || at >= end) return;
    keys.note(at, 0.4, hz(midi + shift), gain, 0.2, triangle, pluck(0.16));
    keys.note(at + S16 * 3, 0.4, hz(midi + shift), gain * 0.4, -0.3, triangle, pluck(0.16));
  };

  // ── Intro: chords, sparse hats, a build and a riser into the drop.
  const introStart = drop - Math.ceil(drop / BAR - 0.001) * BAR;
  for (let bar = 0, start = introStart; start < drop - 0.001; bar++, start += BAR) {
    const pattern = bar % 2 ? "B" : "A";
    CHORDS[pattern].forEach((notes, half) => {
      for (const midi of notes)
        chords.push({ at: start + (half * BAR) / 2, seconds: BAR / 2, midi, level: 0.034, cutoff: 2000 });
    });
    for (let s = 2; s < 16; s += 4) hat(start + s * S16, 0.3, s % 8 ? 0.3 : -0.3);
  }
  if (drop > BAR / 2) {
    for (let s = 8; s < 16; s++) hat(drop - BAR + s * S16, 0.2 + s * 0.03, s % 2 ? 0.3 : -0.3);
    let lowpassed = 0;
    const riser: Wave = (_p, age) => {
      lowpassed += (0.02 + 0.5 * (age / (BAR / 2 - 0.25)) ** 2) * (noise() * 2 - 1 - lowpassed);
      return lowpassed;
    };
    keys.note(drop - BAR / 2, BAR / 2 - 0.25, 1, 0.22, 0, riser, (age, seconds) => (age / seconds) ** 2);
  }

  // ── The drop, bar after bar, starting again from "A" at each landing, until the ending.
  anchors.forEach((anchor, section) => {
    const until = Math.min(anchors[section + 1] ?? end, end, total);
    const within = (at: number) => at < until - 0.001;
    for (let bar = 0, start = anchor; start < until - 0.001; bar++, start += BAR) {
      const pattern = ORDER[bar % 4]!;
      CHORDS[pattern].forEach((notes, half) => {
        const at = start + (half * BAR) / 2;
        if (within(at)) for (const midi of notes) chords.push({ at, seconds: BAR / 2, midi, level: 0.024 });
      });
      for (const s of KICKS[pattern]) if (within(start + s * S16)) kick(start + s * S16, 0.75);
      if (within(start + 8 * S16)) clap(start + 8 * S16, 0.42);
      for (let s = 0; s < 16; s++)
        if (within(start + s * S16))
          hat(start + s * S16, s % 4 === 0 ? 0.75 : s % 2 ? 0.42 : 0.58, s % 2 ? 0.25 : -0.25);
      // A trap roll at the end of every other bar: the hats double, and climb.
      if (bar % 2 === 1 && rng() < 0.85)
        for (let k = 0; k < 6; k++) {
          const at = start + 13 * S16 + k * (S16 / 2);
          if (within(at)) hat(at, 0.4 + k * 0.06, 0);
        }
      if (bar % 2 === 0 && within(start + 6 * S16)) openHat(start + 6 * S16, 0.35);
      const note = PLUCKS[pattern][Math.floor(rng() * 3)]!;
      if (within(start + 2 * S16)) plucked(start + 2 * S16, note, 0.06);
    }
  });

  // ── Moments: on a landing the whole band comes back in; the others get a crash on the
  // nearest sixteenth, so it stays in time with the beat.
  for (const at of moments) {
    if (at < drop - 0.01) {
      // In the intro, a soft low thump that breathes in.
      const thump = drop + Math.round((at - drop) / S16) * S16;
      kit.note(thump - 0.3, 0.3, 1, 0.08 * level, 0, hiss(noise, 0.8), (age) => (age / 0.3) ** 2);
      kit.note(
        thump,
        0.5,
        1,
        0.35 * level,
        0,
        (_p, age) => Math.sin(TAU * (42 * age + (40 / 18) * (1 - Math.exp(-age * 18)))),
        (age) => Math.exp(-age / 0.16),
      );
      continue;
    }
    if (at >= end - 0.01) continue;
    if (anchors.includes(at)) {
      // The section's own pattern already has a kick on its first beat.
      crash(at, 0.16 * level);
      if (at !== drop) clap(at, 0.3);
    } else crash(onBeat(at), 0.09 * level);
  }

  // ── The ending: one last hit and a chord that rings out.
  if (Number.isFinite(end) && end < total) {
    kick(end, 0.85);
    clap(end, 0.3);
    crash(end, 0.14 * level);
    for (const midi of [55, 62, 67, 70, 74])
      keys.note(end, 3.4, hz(midi + shift), 0.03, 0, saw, (age) => Math.exp(-age / 0.9), 1800);
    kit.note(end, 2.0, 1, 0.1, 0, hiss(noise, 0.9), (age) => Math.exp(-age / 0.45));
  }

  // ── Held notes stop where a silence starts; after it, the new section brings its own.
  const cut = (notes: Held[]) =>
    notes.flatMap((note) => {
      if (inGap(note.at)) return [];
      let until = Math.min(note.at + note.seconds, end);
      for (const [from] of silences) if (from > note.at) until = Math.min(until, from);
      return until > note.at + 0.01 ? [{ ...note, seconds: until - note.at }] : [];
    });
  for (const note of cut(chords))
    for (const [detune, pan] of [
      [0.996, -0.5],
      [1.004, 0.5],
    ] as const)
      keys.note(
        note.at,
        note.seconds,
        hz(note.midi + shift) * detune,
        note.level,
        pan,
        saw,
        swell(0.03, 0.12),
        note.cutoff ?? 2300,
      );

  duck(
    keys,
    kicks.sort((a, b) => a - b),
  );
  return { sampleRate, ...master(kit, keys, total), bpm };
}

/** Lower the chords for a moment under each kick, so the kick punches through. */
function duck(tape: Tape, kicks: number[]) {
  let next = 0;
  for (let i = 0; i < tape.length; i++) {
    const now = i / tape.sampleRate;
    while (next + 1 < kicks.length && kicks[next + 1]! <= now) next++;
    const since = now - (kicks[next] ?? Number.NEGATIVE_INFINITY);
    const gain = since >= 0 && since < 0.25 ? 0.45 + 0.55 * (since / 0.25) : 1;
    tape.left[i] = tape.left[i]! * gain;
    tape.right[i] = tape.right[i]! * gain;
  }
}

/** Mix and master: gentle drive, the very top softened, the same ceiling as the other styles, and fades at each end. */
function master(kit: Tape, keys: Tape, total: number) {
  const { length, sampleRate } = kit;
  const left = new Float32Array(length),
    right = new Float32Array(length);
  const top = 1 - Math.exp((-TAU * 14000) / sampleRate);
  let smoothLeft = 0,
    smoothRight = 0;
  for (let i = 0; i < length; i++) {
    const now = i / sampleRate;
    const fade = Math.max(0, Math.min(1, now / 0.05, (total - now) / Math.min(1.2, total / 3)));
    smoothLeft += top * (Math.tanh((kit.left[i]! + keys.left[i]!) * 1.7) - smoothLeft);
    smoothRight += top * (Math.tanh((kit.right[i]! + keys.right[i]!) * 1.7) - smoothRight);
    left[i] = smoothLeft * 0.8 * fade;
    right[i] = smoothRight * 0.8 * fade;
  }
  return { left, right };
}
