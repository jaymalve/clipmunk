import { execFileSync, spawnSync } from "node:child_process";
import { FFMPEG } from "./take";

/** Measurements of real media files, taken with FFmpeg, shared by the end-to-end suites. */

/** Average colour of a region of one frame, as [r, g, b]. `crop` is FFmpeg's `w:h:x:y`. */
export function colourAt(file: string, seconds: number, crop: string): number[] {
  const filter = `crop=${crop},scale=1:1`;
  const args = [
    "-loglevel",
    "error",
    "-ss",
    String(seconds),
    "-i",
    file,
    "-vf",
    filter,
    "-frames:v",
    "1",
    "-f",
    "rawvideo",
    "-pix_fmt",
    "rgb24",
    "-",
  ];
  return [...execFileSync(FFMPEG, args).subarray(0, 3)];
}

/** Whether every channel of a colour is within `tolerance` of the expected one. */
export const near = (actual: number[], expected: readonly number[], tolerance = 40) =>
  expected.every((channel, index) => Math.abs(actual[index]! - channel) <= tolerance);

/** Mean loudness of a file's sound in decibels, from FFmpeg's own measurement. */
export function loudness(file: string): number {
  const report = spawnSync(FFMPEG, ["-hide_banner", "-i", file, "-af", "volumedetect", "-f", "null", "-"], {
    encoding: "utf8",
  }).stderr;
  return Number(/mean_volume: (-?[\d.]+) dB/.exec(report)?.[1] ?? Number.NaN);
}
