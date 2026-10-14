import { writeFile } from "node:fs/promises";
import path from "node:path";
import { encodeWav, type Music, planMusic, type RenderedSounds, renderMusic } from "../core";

/** Synthesize a clip's music to a WAV file for FFmpeg to mix in. The same function that
 * plays in the studio's preview runs here, so the export sounds like the preview.
 */
export type MusicTrack = { file: string; gain: number; duck: boolean };

export async function writeMusic(
  directory: string,
  music: Music,
  clip: Parameters<typeof planMusic>[1],
): Promise<MusicTrack> {
  const file = path.join(directory, "music.wav");
  await writeFile(file, encodeWav(renderMusic(planMusic(music, clip))));
  return { file, gain: music.gain, duck: music.duck };
}

/** Write rendered sound effects to a WAV file for FFmpeg to lay over the clip. */
export async function writeSounds(directory: string, sounds: RenderedSounds): Promise<string> {
  const file = path.join(directory, "sounds.wav");
  await writeFile(file, encodeWav({ ...sounds, bpm: 0 }));
  return file;
}
