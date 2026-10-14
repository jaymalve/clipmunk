import type { MusicRequest, RenderedMusic } from "./music";
import { createTape, hiss, pluck, random, saw, sine, swell, TAU, type Tape, triangle, type Wave } from "./synth";

/** The "launch" style: the sound of a short product launch video. Half-time drums over a fast
 * pulse (75 beats a minute, felt as 150), rolling hi-hats and short chords. A quiet intro
 * drops on a key moment, one steady beat carries every cut after it with a whoosh and a
 * crash, and a short break leads into a last hit that rings out over the end card.
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

/** A held note on its own layer, kept as data until the break before the ending is cut out of it. */
type Held = { at: number; seconds: number; midi: number; level: number; cutoff?: number };

export function renderLaunch(request: MusicRequest): RenderedMusic {
  const sampleRate = request.sampleRate ?? 44100;
  const total = request.durationMs / 1000;
  const length = Math.max(1, Math.round(total * sampleRate));
  const kit = createTape(length, sampleRate); // drums: never ducked
  const keys = createTape(length, sampleRate); // chords and plucks: ducked under the kick
  const rng = random(request.seed + 3000);
  const noise = random(request.seed * 7 + 13);
  let BAR = (60 / (request.bpm ?? LAUNCH_BPM)) * 4;
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
  // The music keeps one steady beat from the drop to the end, so it flows across every cut.
  // The tempo is nudged, by at most 4%, so that the ending lands exactly on the beat: on a
  // bar line if one is close enough, or else on a beat or a sixteenth.
  if (Number.isFinite(end))
    for (const parts of [1, 4, 16]) {
      const count = Math.max(1, Math.round(((end - drop) / BAR) * parts));
      const scale = (end - drop) / ((count / parts) * BAR);
      if (Math.abs(scale - 1) <= 0.04) {
        BAR *= scale;
        break;
      }
    }
  const S16 = BAR / 16;
  const bpm = Math.round((240 / BAR) * 100) / 100;
  /** The nearest sixteenth to `at` on the music's beat. */
  const onBeat = (at: number) => drop + Math.round((at - drop) / S16) * S16;
  // The one break: silent for two sixteenths before the ending, which then lands on its moment.
  const silence = Number.isFinite(end) && end < total ? end - 2 * S16 : Number.POSITIVE_INFINITY;
  const inGap = (at: number) => at >= silence - 0.001 && at < end - 0.001;

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

  // ── The drop, bar after bar on one steady beat, until the ending.
  const until = Math.min(end, total);
  const within = (at: number) => at < until - 0.001;
  for (let bar = 0, start = drop; within(start); bar++, start += BAR) {
    const pattern = ORDER[bar % 4]!;
    CHORDS[pattern].forEach((notes, half) => {
      const at = start + (half * BAR) / 2;
      if (within(at)) for (const midi of notes) chords.push({ at, seconds: BAR / 2, midi, level: 0.024 });
    });
    for (const s of KICKS[pattern]) if (within(start + s * S16)) kick(start + s * S16, 0.75);
    if (within(start + 8 * S16)) clap(start + 8 * S16, 0.42);
    for (let s = 0; s < 16; s++)
      if (within(start + s * S16)) hat(start + s * S16, s % 4 === 0 ? 0.75 : s % 2 ? 0.42 : 0.58, s % 2 ? 0.25 : -0.25);
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

  // ── Moments. The drop opens with a crash; every other cut is carried by a soft whoosh
  // into a crash close to it on the beat, so the music marks it without breaking stride.
  for (const at of moments) {
    if (at < drop - 0.01) {
      // In the intro, a soft low thump that breathes in.
      const thump = onBeat(at);
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
    if (Math.abs(at - drop) < 0.01) {
      crash(drop, 0.16 * level);
      continue;
    }
    // A crash is a wash, not part of the groove, so the nearest half sixteenth is close enough to the beat.
    const hit = drop + Math.round((at - drop) / (S16 / 2)) * (S16 / 2);
    if (!within(hit) || inGap(hit)) continue;
    const rise = 4 * S16;
    kit.note(hit - rise, rise, 1, 0.07 * level, 0.1, hiss(noise, 0.9), (age) => (age / rise) ** 3);
    crash(hit, 0.1 * level);
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

  // ── Held notes stop where the break before the ending starts.
  const cut = (notes: Held[]) =>
    notes.flatMap((note) => {
      if (inGap(note.at)) return [];
      const stop = Math.min(note.at + note.seconds, end, note.at < silence ? silence : end);
      return stop > note.at + 0.01 ? [{ ...note, seconds: stop - note.at }] : [];
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
