import { type ChildProcess, spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { Fault } from "../project";

/** FFmpeg process handling. The binary is, in order: CLIPMUNK_FFMPEG, the `ffmpeg-static`
 * package if the project has it installed, then `ffmpeg` on PATH.
 */
let resolved: string | undefined;
export function ffmpegPath(): string {
  if (process.env.CLIPMUNK_FFMPEG) return process.env.CLIPMUNK_FFMPEG;
  if (resolved) return resolved;
  try {
    const manifest = createRequire(path.join(process.cwd(), "package.json")).resolve("ffmpeg-static/package.json");
    const binary = path.join(path.dirname(manifest), process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg");
    if (existsSync(binary)) {
      resolved = binary;
      return resolved;
    }
  } catch {
    // not installed; fall through to PATH
  }
  resolved = "ffmpeg";
  return resolved;
}
export const MISSING_FFMPEG =
  "FFmpeg was not found. Install it (https://ffmpeg.org/download.html) so `ffmpeg` is on your PATH, or run `npm install -D ffmpeg-static` in this project, or set CLIPMUNK_FFMPEG to its location.";
const MISSING = MISSING_FFMPEG;

export type Encoder = { write(frame: Buffer): Promise<void>; finish(): Promise<void>; kill(): void };

/** Encode a stream of PNG or JPEG frames to an H.264 MP4 segment of exactly `frames` frames. */
export function startEncoder(options: {
  output: string;
  fps: number;
  width: number;
  height: number;
  frames: number;
  input: "png" | "mjpeg";
  cwd: string;
}): Encoder {
  const { width, height } = options;
  const child = spawn(
    ffmpegPath(),
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "image2pipe",
      "-framerate",
      String(options.fps),
      "-c:v",
      options.input,
      "-i",
      "pipe:0",
      "-an",
      // Fit the captured frame inside the output and centre it on black.
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease:flags=lanczos,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1`,
      "-c:v",
      "libx264",
      "-preset",
      "medium",
      "-crf",
      "16",
      "-pix_fmt",
      "yuv420p",
      "-frames:v",
      String(options.frames),
      "-n",
      options.output,
    ],
    { cwd: options.cwd, stdio: ["pipe", "ignore", "pipe"] },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk: Buffer) => (stderr = (stderr + chunk.toString()).slice(-2000)));
  child.stdin!.on("error", () => {});
  const done = new Promise<void>((resolve, reject) => {
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Fault("missing-ffmpeg", MISSING) : error),
    );
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Fault(
              "encoding-failed",
              `FFmpeg failed: ${stderr.trim() || (signal ? `it was stopped by the system (${signal}), which usually means the machine ran out of memory at this output size` : `exit code ${code}`)}`,
            ),
          ),
    );
  });
  done.catch(() => {});
  return {
    write: (frame) =>
      Promise.race([
        new Promise<void>((resolve, reject) =>
          child.stdin!.write(frame, (error) => (error ? reject(error) : resolve())),
        ),
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
    child.once("error", (error: NodeJS.ErrnoException) =>
      reject(error.code === "ENOENT" ? new Fault("missing-ffmpeg", MISSING) : error),
    );
    child.once("close", (code) => resolve({ code, stderr, child }));
  });
}

/** Join segments without re-encoding and move the index to the front for streaming. */
export async function concatSegments(segments: string[], listFile: string, output: string, cwd: string): Promise<void> {
  const { code, stderr } = await run(
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      listFile,
      "-c",
      "copy",
      "-movflags",
      "+faststart",
      "-n",
      output,
    ],
    cwd,
  );
  if (code !== 0)
    throw new Fault(
      "encoding-failed",
      `FFmpeg could not join ${segments.length} segments: ${stderr.trim().slice(-800)}`,
    );
}

export async function ffmpegVersion(): Promise<string | undefined> {
  return new Promise((resolve) => {
    const child = spawn(ffmpegPath(), ["-version"], { stdio: ["ignore", "pipe", "ignore"] });
    let out = "";
    child.stdout!.on("data", (chunk: Buffer) => (out += chunk.toString()));
    child.once("error", () => resolve(undefined));
    child.once("close", (code) =>
      resolve(code === 0 ? (/ffmpeg version (\S+)/.exec(out)?.[1] ?? "unknown") : undefined),
    );
  });
}

/** Decode a file and report what is really in it. Used by tests and `clipmunk doctor`-style checks. */
export async function probeVideo(
  file: string,
  cwd: string,
): Promise<{ frames: number; width: number; height: number; fps: number; durationMs: number }> {
  const { stderr } = await run(["-hide_banner", "-nostdin", "-i", file, "-map", "0:v:0", "-f", "null", "-"], cwd);
  const size = /Video:.*?\s(\d{2,5})x(\d{2,5})[\s,]/.exec(stderr);
  const frames = [...stderr.matchAll(/frame=\s*(\d+)/g)].pop();
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  if (!size || !frames || !duration)
    throw new Fault("probe-failed", `Could not read ${file}: ${stderr.trim().slice(-400)}`);
  return {
    frames: Number(frames[1]),
    width: Number(size[1]),
    height: Number(size[2]),
    fps: Number(/([\d.]+)\s*fps/.exec(stderr)?.[1] ?? 0),
    durationMs: (Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000,
  };
}

export type MediaInfo = { durationMs: number; width?: number; height?: number; hasVideo: boolean; hasAudio: boolean };

/** Read container facts from FFmpeg's header report. */
export async function probeMedia(file: string, cwd: string): Promise<MediaInfo> {
  const { stderr } = await run(["-hide_banner", "-nostdin", "-i", file], cwd);
  const duration = /Duration:\s*(\d+):(\d+):([\d.]+)/.exec(stderr);
  const video = /Stream #.*Video:.*?\s(\d{2,5})x(\d{2,5})[\s,]/.exec(stderr);
  if (!/Stream #/.test(stderr))
    throw new Fault("unreadable-media", `FFmpeg could not read ${file}: ${stderr.trim().split("\n").pop()}`);
  return {
    durationMs: duration
      ? Math.round((Number(duration[1]) * 3600 + Number(duration[2]) * 60 + Number(duration[3])) * 1000)
      : 0,
    width: video ? Number(video[1]) : undefined,
    height: video ? Number(video[2]) : undefined,
    hasVideo: !!video,
    hasAudio: /Stream #.*Audio:/.test(stderr),
  };
}

/** Rewrite a MediaRecorder file without re-encoding so it gains a duration and a seek index. */
export async function remux(input: string, output: string, cwd: string): Promise<void> {
  const { code, stderr } = await run(
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-c", "copy", output],
    cwd,
  );
  if (code !== 0) throw new Fault("ingest-failed", `FFmpeg could not finalise ${input}: ${stderr.trim().slice(-600)}`);
}

/** Pull the voice track out as 48 kHz mono WAV, the form the exporter mixes from. */
export async function extractAudio(input: string, output: string, cwd: string): Promise<void> {
  const { code, stderr } = await run(
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-y", "-i", input, "-vn", "-ac", "1", "-ar", "48000", output],
    cwd,
  );
  if (code !== 0)
    throw new Fault("ingest-failed", `FFmpeg could not extract audio from ${input}: ${stderr.trim().slice(-600)}`);
}

/** Turn the page-encoded video into the final MP4: add the voice track, trimmed and levelled,
 * put generated music under it, and move the index to the front. The picture is copied
 * untouched when it is already H.264.
 */
export async function finishTake(options: {
  video: string;
  output: string;
  cwd: string;
  durationMs: number;
  copyVideo: boolean;
  audio?: { file: string; startMs: number; gain: number; normalize: boolean };
  music?: MusicInput;
}): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", options.video];
  const graph: string[] = [];
  let sound: string | undefined;
  let inputs = 1;
  if (options.audio) {
    // startMs is where the clip begins inside the audio file; negative means the voice starts later.
    if (options.audio.startMs > 0) args.push("-ss", (options.audio.startMs / 1000).toFixed(3));
    args.push("-i", options.audio.file);
    const chain = ["aresample=48000"];
    if (options.audio.startMs < 0) chain.push(`adelay=${Math.round(-options.audio.startMs)}:all=1`);
    if (options.audio.gain !== 1) chain.push(`volume=${options.audio.gain.toFixed(3)}`);
    if (options.audio.normalize) chain.push("loudnorm=I=-16:TP=-1.5:LRA=11");
    graph.push(`[${inputs}:a:0]${chain.join(",")}[voice]`);
    sound = "voice";
    inputs++;
  }
  if (options.music) {
    args.push("-i", options.music.file);
    const mixed = underlay(sound, `[${inputs}:a:0]`, options.music);
    graph.push(...mixed.lines);
    sound = mixed.out;
  }
  args.push("-map", "0:v:0");
  if (sound) {
    graph.push(`[${sound}]apad[out]`);
    args.push("-filter_complex", graph.join(";"), "-map", "[out]", "-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  }
  args.push(
    ...(options.copyVideo
      ? ["-c:v", "copy"]
      : ["-c:v", "libx264", "-preset", "medium", "-crf", "16", "-pix_fmt", "yuv420p"]),
  );
  args.push("-t", (options.durationMs / 1000).toFixed(3), "-movflags", "+faststart", "-n", options.output);
  const { code, stderr } = await run(args, options.cwd);
  if (code !== 0) throw new Fault("encoding-failed", `FFmpeg could not finish the video: ${stderr.trim().slice(-800)}`);
}

export type MusicInput = { file: string; gain: number; duck: boolean };
/** Filter lines that put music under a clip's sound. With `duck`, the music drops while the
 * clip's own sound (a voice) is present and comes back afterwards. Returns the label to map.
 */
function underlay(main: string | undefined, musicInput: string, music: MusicInput): { lines: string[]; out: string } {
  const level = `${musicInput}aresample=48000,aformat=channel_layouts=stereo,volume=${music.gain.toFixed(3)}[mus]`;
  if (!main) return { lines: [level], out: "mus" };
  if (!music.duck)
    return {
      lines: [level, `[${main}][mus]amix=inputs=2:normalize=0:dropout_transition=0[withmusic]`],
      out: "withmusic",
    };
  return {
    lines: [
      level,
      `[${main}]aformat=channel_layouts=stereo,asplit=2[voicemix][voicekey]`,
      "[mus][voicekey]sidechaincompress=threshold=0.02:ratio=8:attack=20:release=450[ducked]",
      "[voicemix][ducked]amix=inputs=2:normalize=0:dropout_transition=0[withmusic]",
    ],
    out: "withmusic",
  };
}

export type PlacedAudio = { file: string; offsetMs: number; gain: number };
/** One FFmpeg filter chain that places a sound on a timeline: delayed or cut at the front, at its volume. */
const placed = (input: string, track: PlacedAudio, label: string) =>
  `${input}aresample=48000,${track.offsetMs >= 0 ? `adelay=${Math.round(track.offsetMs)}:all=1` : `atrim=start=${(-track.offsetMs / 1000).toFixed(3)},asetpts=PTS-STARTPTS`},volume=${track.gain.toFixed(3)}[${label}]`;

/** Lay sound files and generated music over a finished video. The picture is copied untouched. */
export async function addAudio(options: {
  video: string;
  output: string;
  cwd: string;
  durationMs: number;
  tracks: PlacedAudio[];
  music?: MusicInput;
}): Promise<void> {
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", options.video];
  for (const track of options.tracks) args.push("-i", track.file);
  if (options.music) args.push("-i", options.music.file);
  const graph = options.tracks.map((track, index) => placed(`[${index + 1}:a:0]`, track, `a${index}`));
  let sound: string | undefined;
  if (options.tracks.length) {
    graph.push(
      `${options.tracks.map((_, index) => `[a${index}]`).join("")}amix=inputs=${options.tracks.length}:normalize=0:dropout_transition=0[sound]`,
    );
    sound = "sound";
  }
  if (options.music) {
    const mixed = underlay(sound, `[${options.tracks.length + 1}:a:0]`, options.music);
    graph.push(...mixed.lines);
    sound = mixed.out;
  }
  graph.push(`[${sound}]apad[out]`);
  args.push(
    "-filter_complex",
    graph.join(";"),
    "-map",
    "0:v:0",
    "-map",
    "[out]",
    "-c:v",
    "copy",
    "-c:a",
    "aac",
    "-b:a",
    "192k",
    "-ar",
    "48000",
  );
  args.push("-t", (options.durationMs / 1000).toFixed(3), "-movflags", "+faststart", "-n", options.output);
  const { code, stderr } = await run(args, options.cwd);
  if (code !== 0) throw new Fault("encoding-failed", `FFmpeg could not add the audio: ${stderr.trim().slice(-800)}`);
}

/** Join rendered clips into one video. `fadesMs[i]` is how long clip i cross-fades in over
 * clip i-1 (0 means a cut). Clips without sound get silence so every join is uniform, and
 * `overlay` sounds are mixed over the whole result.
 */
export async function joinClips(options: {
  clips: { file: string; durationMs: number; hasAudio: boolean }[];
  fadesMs: number[];
  fps: number;
  width: number;
  height: number;
  overlay: PlacedAudio[];
  music?: MusicInput;
  totalMs: number;
  output: string;
  cwd: string;
}): Promise<{ audio: boolean }> {
  const { clips, fadesMs } = options;
  const args = ["-hide_banner", "-loglevel", "error", "-nostdin"];
  for (const clip of clips) args.push("-i", clip.file);
  for (const track of options.overlay) args.push("-i", track.file);
  if (options.music) args.push("-i", options.music.file);
  // Clip sound is only wired up when some clip or overlay has any; music alone needs none of it.
  const audio = clips.some((clip) => clip.hasAudio) || options.overlay.length > 0;
  const seconds = (ms: number) => (ms / 1000).toFixed(3);
  const graph: string[] = [];
  clips.forEach((clip, index) => {
    // Same size, cadence, pixel format and time base for every clip, or the joins fail.
    graph.push(
      `[${index}:v:0]scale=${options.width}:${options.height}:force_original_aspect_ratio=decrease,pad=${options.width}:${options.height}:(ow-iw)/2:(oh-ih)/2:black,setsar=1,format=yuv420p,setpts=PTS-STARTPTS,fps=${options.fps}[v${index}]`,
    );
    if (audio)
      graph.push(
        clip.hasAudio
          ? `[${index}:a:0]aresample=48000,aformat=channel_layouts=stereo,apad,atrim=0:${seconds(clip.durationMs)},asetpts=PTS-STARTPTS[a${index}]`
          : `anullsrc=r=48000:cl=stereo,atrim=0:${seconds(clip.durationMs)}[a${index}]`,
      );
  });
  let video = "v0",
    sound = "a0",
    length = clips[0]!.durationMs;
  for (let index = 1; index < clips.length; index++) {
    const fade = fadesMs[index] ?? 0;
    if (fade > 0) {
      graph.push(
        `[${video}][v${index}]xfade=transition=fade:duration=${seconds(fade)}:offset=${seconds(length - fade)}[x${index}]`,
      );
      if (audio) graph.push(`[${sound}][a${index}]acrossfade=d=${seconds(fade)}:c1=tri:c2=tri[y${index}]`);
    } else {
      graph.push(`[${video}][v${index}]concat=n=2:v=1:a=0[x${index}]`);
      if (audio) graph.push(`[${sound}][a${index}]concat=n=2:v=0:a=1[y${index}]`);
    }
    video = `x${index}`;
    sound = `y${index}`;
    length += clips[index]!.durationMs - fade;
  }
  if (options.overlay.length) {
    for (const [index, track] of options.overlay.entries()) {
      const line = placed(`[${clips.length + index}:a:0]`, track, `o${index}`);
      graph.push(line.replace(`[o${index}]`, `,aformat=channel_layouts=stereo[o${index}]`));
    }
    graph.push(
      `[${sound}]${options.overlay.map((_, index) => `[o${index}]`).join("")}amix=inputs=${options.overlay.length + 1}:normalize=0:dropout_transition=0[mixed]`,
    );
    sound = "mixed";
  }
  let heard: string | undefined = audio ? sound : undefined;
  if (options.music) {
    const mixed = underlay(heard, `[${clips.length + options.overlay.length}:a:0]`, options.music);
    graph.push(...mixed.lines);
    heard = mixed.out;
  }
  args.push("-filter_complex", graph.join(";"), "-map", `[${video}]`);
  if (heard) args.push("-map", `[${heard}]`, "-c:a", "aac", "-b:a", "192k", "-ar", "48000");
  args.push(
    "-c:v",
    "libx264",
    "-preset",
    "medium",
    "-crf",
    "16",
    "-pix_fmt",
    "yuv420p",
    "-t",
    seconds(options.totalMs),
    "-movflags",
    "+faststart",
    "-n",
    options.output,
  );
  const { code, stderr } = await run(args, options.cwd);
  if (code !== 0)
    throw new Fault("encoding-failed", `FFmpeg could not join the sequence: ${stderr.trim().slice(-900)}`);
  return { audio: !!heard };
}
