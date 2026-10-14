import { z } from "zod";
import { createTape, random, TAU } from "./synth";

/** Sound effects a scene asks for in its recipe, synthesized from code like the music.
 * Times are on the scene's authored clock, the one `useSceneTime` reports, so they can be
 * copied straight from the component that animates the same thing.
 */
export const SoundSchema = z.discriminatedUnion("kind", [
  z.strictObject({
    /** Key clicks while text is typed: `chars` characters at `perSecond`, starting at `atMs`. */
    kind: z.literal("typing"),
    atMs: z.number().finite().nonnegative(),
    chars: z.number().int().min(1).max(5000),
    perSecond: z.number().finite().min(1).max(400).default(12),
    /** A heavier Return key after the last character, as when a command is run. */
    enter: z.boolean().default(false),
    gain: z.number().finite().min(0).max(2).default(1),
  }),
]);
export type Sound = z.output<typeof SoundSchema>;
export type SoundInput = z.input<typeof SoundSchema>;

/** Keys closer together than this are not all heard: real typing rarely goes faster, and
 * a click for every character of fast on-screen typing turns into a buzz.
 */
const KEY_GAP_S = 0.06;
const ENTER_PAUSE_S = 0.14;
/** Sets how loud a key is: just under the music, as in a launch video, never over it. */
const KEY_LEVEL = 1.3;

/** One way a key part rings: a frequency, how long it takes to die away, and how loud it is. */
type Mode = [hz: number, decay: number, level: number];

/** A low-profile clicky keyboard such as a Keychron K3: flat plastic caps on short switches,
 * so a crisp, bright "chick" with almost no ring and no body below it. Each part is a short burst of
 * noise through a few broad, heavily damped bands; long, narrow rings at fixed pitches are
 * what make a synthesized key sound metallic, so nothing here rings for more than a
 * millisecond or two. The press is the switch's click and then the cap bottoming out; the
 * release is a quieter click as the key springs back up.
 */
const CLICK: Mode[] = [
  [5200, 0.0004, 1],
  [3600, 0.0005, 0.55],
  [7600, 0.0003, 0.9],
  [10000, 0.00025, 0.45],
];
const CLACK: Mode[] = [
  [3000, 0.0007, 0.8],
  [4400, 0.0005, 0.7],
  [2200, 0.0008, 0.4],
];
/** A space bar or Return key: a longer cap, a little lower and fuller, with its stabilizer. */
const HEAVY: Mode[] = [
  [2000, 0.0011, 0.8],
  [3100, 0.0008, 0.6],
  [1300, 0.0013, 0.35],
];

/** Ring `modes` from a burst of noise `burst` seconds long, and add it to the tape. */
function ring(
  tape: ReturnType<typeof createTape>,
  noise: () => number,
  at: number,
  modes: Mode[],
  tune: number,
  level: number,
  pan: number,
  burst: number,
  vary: () => number,
) {
  const { sampleRate } = tape;
  const longest = Math.max(...modes.map(([, decay]) => decay));
  const count = Math.round((longest * 7 + burst) * sampleRate);
  const from = Math.round(at * sampleRate);
  const filters = modes.map(([hz, decay, gain]) => {
    // A two-pole resonator: it rings at `hz` and falls by e every `decay` seconds.
    const radius = Math.exp(-1 / (decay * sampleRate));
    // No two presses ring at quite the same pitches, as with a real key.
    const angle = (TAU * Math.min(hz * tune * (0.92 + vary() * 0.16), sampleRate * 0.45)) / sampleRate;
    return {
      a1: 2 * radius * Math.cos(angle),
      a2: -radius * radius,
      // Scaled so every mode peaks at its own level, whatever its pitch.
      gain: gain * (1 - radius) * 2 * Math.sin(angle),
      y1: 0,
      y2: 0,
    };
  });
  const burstSamples = Math.max(1, Math.round(burst * sampleRate));
  // Broad bands this damped let low rumble through; a key has none, so it is taken out.
  const lowCut = Math.exp((-TAU * 1200) / sampleRate);
  let lastIn = 0,
    lastOut = 0;
  for (let i = 0; i < count; i++) {
    const index = from + i;
    const excite = i < burstSamples ? (noise() * 2 - 1) * (1 - i / burstSamples) ** 2 : 0;
    let sample = 0;
    for (const filter of filters) {
      const y = filter.gain * excite + filter.a1 * filter.y1 + filter.a2 * filter.y2;
      filter.y2 = filter.y1;
      filter.y1 = y;
      sample += y;
    }
    lastOut = lowCut * (lastOut + sample - lastIn);
    lastIn = sample;
    sample = lastOut;
    if (index < 0 || index >= tape.length) continue;
    tape.left[index] = tape.left[index]! + sample * level * Math.min(1, 1 - pan);
    tape.right[index] = tape.right[index]! + sample * level * Math.min(1, 1 + pan);
  }
}

/** One key: the press (click, then the cap bottoming out) and, when there is time before the
 * next key, the release.
 */
function strike(
  tape: ReturnType<typeof createTape>,
  noise: () => number,
  vary: () => number,
  at: number,
  level: number,
  pan: number,
  heavy: boolean,
  release: number | undefined,
) {
  // Every key on a board sounds a little different.
  const tune = 0.93 + vary() * 0.14;
  ring(tape, noise, at, CLICK, tune, level, pan, 0.0012, vary);
  // Low-profile switches travel only a little, so the cap lands soon after the click.
  const bottom = at + 0.006 + vary() * 0.004;
  if (heavy) {
    ring(tape, noise, bottom, HEAVY, tune, level * 1.1, pan, 0.004, vary);
    ring(tape, noise, bottom + 0.006, CLACK, tune * 0.85, level * 0.3, pan, 0.002, vary); // stabilizer
  } else ring(tape, noise, bottom, CLACK, tune, level * 0.9, pan, 0.0025, vary);
  if (release !== undefined) {
    ring(tape, noise, at + release, CLICK, tune * 0.97, level * 0.4, pan, 0.0012, vary);
    ring(tape, noise, at + release + 0.004, CLACK, tune * 1.05, level * 0.2, pan, 0.002, vary);
  }
}

/** When each key is heard, in seconds on the clip's clock, and whether it is a heavy one. */
export function typingKeys(sound: Sound, speed = 1, seed = 0): { at: number; heavy: boolean }[] {
  const rng = random(seed + 4000);
  const start = sound.atMs / 1000 / speed;
  const step = 1 / sound.perSecond / speed;
  const keys: { at: number; heavy: boolean }[] = [];
  let last = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < sound.chars; index++) {
    const at = start + index * step;
    if (at - last < KEY_GAP_S) continue;
    // A little human unevenness, and about one key in six is a space.
    keys.push({ at: at + (rng() - 0.5) * 0.012, heavy: rng() < 0.16 });
    last = at;
  }
  if (sound.enter) keys.push({ at: start + sound.chars * step + ENTER_PAUSE_S, heavy: true });
  return keys;
}

export type RenderedSounds = { sampleRate: number; left: Float32Array; right: Float32Array };

/** Render a scene's sound effects over `durationMs` of its clip. `speed` is the scene's motion
 * speed, which maps authored time to the clip's clock. The same sounds always render the same.
 */
export function renderSounds(request: {
  sounds: readonly Sound[];
  durationMs: number;
  speed?: number;
  sampleRate?: number;
  seed?: number;
}): RenderedSounds {
  const sampleRate = request.sampleRate ?? 44100;
  const tape = createTape(Math.max(1, Math.round((request.durationMs / 1000) * sampleRate)), sampleRate);
  const seed = request.seed ?? 0;
  const noise = random(seed * 11 + 17);
  const vary = random(seed + 5000);
  request.sounds.forEach((sound, index) => {
    const keys = typingKeys(sound, request.speed ?? 1, seed + index * 101);
    keys.forEach((key, position) => {
      const next = keys[position + 1]?.at ?? Number.POSITIVE_INFINITY;
      const release = 0.07 + vary() * 0.04;
      const level = KEY_LEVEL * sound.gain * (0.8 + vary() * 0.3);
      strike(
        tape,
        noise,
        vary,
        key.at,
        level,
        (vary() - 0.5) * 0.3,
        key.heavy,
        key.at + release < next - 0.01 ? release : undefined,
      );
    });
  });
  // A soft ceiling: one key never clips, and many at once stay under full scale.
  for (let i = 0; i < tape.length; i++) {
    tape.left[i] = Math.tanh(tape.left[i]!);
    tape.right[i] = Math.tanh(tape.right[i]!);
  }
  return { sampleRate, left: tape.left, right: tape.right };
}
