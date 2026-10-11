import { writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeWav, planMusic, renderMusic, type Music } from "../core";

/** Synthesize a clip's music to a WAV file for FFmpeg to mix in. The same function that
 * plays in the studio's preview runs here, so the export sounds like the preview.
 */
export type MusicTrack = { file: string; gain: number; duck: boolean };

export async function writeMusic(directory: string, music: Music, clip: Parameters<typeof planMusic>[1]): Promise<MusicTrack> {
  const file = path.join(directory, "music.wav");
  await writeFile(file, encodeWav(renderMusic(planMusic(music, clip))));
  return { file, gain: music.gain, duck: music.duck };
}
