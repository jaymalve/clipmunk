import { spawn, type ChildProcess } from "node:child_process";
import { Fault } from "../project";

/** FFmpeg process handling. FLICK_FFMPEG overrides the binary; otherwise `ffmpeg` on PATH. */
export const ffmpegPath = () => process.env.FLICK_FFMPEG || "ffmpeg";
const MISSING = "FFmpeg was not found. Install it (https://ffmpeg.org/download.html) and make sure `ffmpeg` is on your PATH, or set FLICK_FFMPEG to its location.";

export type Encoder = { write(frame: Buffer): Promise<void>; finish(): Promise<void>; kill(): void };

/** Encode a stream of PNG or JPEG frames to an H.264 MP4 segment of exactly `frames` frames. */
export function startEncoder(options: { output: string; fps: number; width: number; height: number; frames: number; input: "png" | "mjpeg"; cwd: string }): Encoder {
  const { width, height } = options;
  const child = spawn(
    ffmpegPath(),
    [
      "-hide_banner", "-loglevel", "error", "-nostdin",
      "-f", "image2pipe", "-framerate", String(options.fps), "-c:v", options.input, "-i", "pipe:0",
      "-an",
      // Fit the captured frame inside the output and centre it on black.
      "-vf", `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      "-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p",
      "-frames:v", String(options.frames), "-n", options.output,
    ],
    { cwd: options.cwd, stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  child.stdin!.on("error", () => {});
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Fault("missing-ffmpeg", MISSING) : error));
    child.once("close", (code) => (code === 0 ? resolve() : reject(new Fault("encoding-failed", `FFmpeg failed: ${stderr.trim() || `exit code ${code}`}`))));
  });
  done.catch(() => {});
  return {
    write: (frame) =>
      Promise.race([
        new Promise<void>((resolve, reject) => child.stdin!.write(frame, (error) => (error ? reject(error) : resolve()))),
        done.then(() => {
          throw new Fault("encoding-failed", "FFmpeg stopped before all frames were written.");
        }),
      ]),
    finish: () => {
      child.stdin!.end();
      return done;
    },
    kill: () => void child.kill("SIGKILL"),
  };
}

function run(args: string[], cwd: string): Promise<{ code: number | null; stderr: string; child: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const child = spawn(ffmpegPath(), args, { cwd, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr!.on("data", (chunk: Buffer) => (stderr += chunk.toString()));
    child.once("error", (error: NodeJS.ErrnoException) => reject(error.code === "ENOENT" ? new Fault("missing-ffmpeg", MISSING) : error));
    child.once("close", (code) => resolve({ code, stderr, child }));
  });
}

/** Join segments without re-encoding and move the index to the front for streaming. */
export async function concatSegments(segments: string[], listFile: string, output: string, cwd: string): Promise<void> {
  const { code, stderr } = await run(["-hide_banner", "-loglevel", "error", "-nostdin", "-f", "concat", "-safe", "0", "-i", listFile, "-c", "copy", "-movflags", "+faststart", "-n", output], cwd);
  if (code !== 0) throw new Fault("encoding-failed", `FFmpeg could not join ${segments.length} segments: ${stderr.trim().slice(-800)}`);
}

export async function ffmpegVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) => resolve(code === 0 ? /ffmpeg version (\S+)/.exec(out)?.[1] ?? "unknown" : undefined));
  });
}

/** Decode a file and report what is really in it. Used by tests and `flick doctor`-style checks. */
export async function probeVideo(file: string, cwd: string): Promise<{ frames: number; width: number; height: number; fps: number; durationMs: number }> {
  const { stderr } = await run(["-hide_banner", "-nostdin", "-i", file, "-map", "0:v:0", "-f", "null", "-"], cwd);
  const size = /Video:.*?\s(\d{2,5})x(\d{2,5})[\s,]/.exec(stderr);
  const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].pop();
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  if (!size || !frames || !duration) throw new Fault("probe-failed", `Could not read ${file}: ${stderr.trim().slice(-400)}`);
  return {
    frames: Number(frames[1]),
    width: Number(size[1]),
    height: Number(size[2]),
    fps: Number(/([\d.]+)\s*fps/.exec(stderr)?.[1] ?? 0),
    durationMs: (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
  };
}
