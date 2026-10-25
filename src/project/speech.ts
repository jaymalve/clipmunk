import { readFile } from "node:fs/promises";
import { detectSpeech, type Span, type Take } from "../core";
import { readText, resolveInside, writeText } from "./services";
import { takeDir } from "./takes";

/** Where a take's voice track has speech, on the take clock, so pacing never speeds it up.
 * Found once with an energy detector and kept in `speech.json` beside the take: a cache that is
 * not part of the recording (it stays out of git), rebuilt whenever it is missing or stale.
 */
export const SPEECH_FILE = "speech.json";
type Cached = { version: 1; audio: string; offsetMs: number; spans: Span[] };

export async function readSpeech(root: string, take: Take): Promise<Span[]> {
  const audio = take.source.audio;
  if (!audio) return [];
  const file = `${takeDir(take.id)}/${SPEECH_FILE}`;
  try {
    const cached = JSON.parse((await readText(root, file)) ?? "null") as Cached | null;
    if (cached?.version === 1 && cached.audio === audio.file && cached.offsetMs === audio.offsetMs) return cached.spans;
  } catch {
    // A broken cache is rebuilt.
  }
  const wav = await readFile(await resolveInside(root, `${takeDir(take.id)}/${audio.file}`)).catch(() => undefined);
  const pcm = wav && readWav(wav);
  if (!pcm) return [];
  const spans = detectSpeech(pcm.samples, pcm.sampleRate).map(
    ([from, to]): Span => [from + audio.offsetMs, to + audio.offsetMs],
  );
  const cache: Cached = { version: 1, audio: audio.file, offsetMs: audio.offsetMs, spans };
  await writeText(root, file, `${JSON.stringify(cache)}\n`).catch(() => {});
  return spans;
}

/** The first channel of a 16-bit PCM WAV (what ingest's FFmpeg writes), as numbers in -1..1. */
export function readWav(data: Buffer): { samples: Float32Array; sampleRate: number } | undefined {
  if (data.toString("ascii", 0, 4) !== "RIFF" || data.toString("ascii", 8, 12) !== "WAVE") return undefined;
  let offset = 12,
    channels = 1,
    sampleRate = 48000,
    bits = 16;
  while (offset + 8 <= data.length) {
    const id = data.toString("ascii", offset, offset + 4);
    const size = data.readUInt32LE(offset + 4);
    const body = offset + 8;
    if (id === "fmt ") {
      channels = data.readUInt16LE(body + 2);
      sampleRate = data.readUInt32LE(body + 4);
      bits = data.readUInt16LE(body + 14);
    } else if (id === "data") {
      if (bits !== 16) return undefined;
      const end = Math.min(data.length, body + size);
      const count = Math.floor((end - body) / (2 * channels));
      const samples = new Float32Array(count);
      for (let index = 0; index < count; index++)
        samples[index] = data.readInt16LE(body + index * 2 * channels) / 32768;
      return { samples, sampleRate };
    }
    offset = body + size + (size % 2);
  }
  return undefined;
}
