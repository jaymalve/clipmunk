const KEY = "clipmunk:muted";
const EVENT = "clipmunk:mute";

let context: AudioContext | null = null;

export function isMuted() {
  return window.localStorage.getItem(KEY) === "1";
}

export function setMuted(muted: boolean) {
  window.localStorage.setItem(KEY, muted ? "1" : "0");
  window.dispatchEvent(new Event(EVENT));
}

export function subscribeMute(listener: () => void) {
  window.addEventListener(EVENT, listener);
  return () => window.removeEventListener(EVENT, listener);
}

function blip(audio: AudioContext, at: number, from: number, to: number) {
  const oscillator = audio.createOscillator();
  const gain = audio.createGain();
  oscillator.type = "triangle";
  oscillator.frequency.setValueAtTime(from, at);
  oscillator.frequency.exponentialRampToValueAtTime(to, at + 0.07);
  gain.gain.setValueAtTime(0.0001, at);
  gain.gain.exponentialRampToValueAtTime(0.12, at + 0.01);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + 0.09);
  oscillator.connect(gain).connect(audio.destination);
  oscillator.start(at);
  oscillator.stop(at + 0.1);
}

/** Two quick rising squeaks: "chip-chip". Silent when sound is off. */
export function chirp(pitch = 1) {
  if (isMuted()) return;
  context ??= new AudioContext();
  const now = context.currentTime;
  blip(context, now, 1500 * pitch, 2500 * pitch);
  blip(context, now + 0.11, 1700 * pitch, 2900 * pitch);
}

/** Tells the effects layer where Chip was poked, so it can float a word there. */
export function poke(x: number, y: number, pitch = 1) {
  chirp(pitch);
  window.dispatchEvent(new CustomEvent("clipmunk:poke", { detail: { x, y } }));
}
