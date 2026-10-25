import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { composeTake, defaultEdit, type Take, type TakeEditFile, type TakeEvent, TakeFileSchema } from "../../src/core";

/** A synthetic take with known pixels, so rendering can be checked exactly.
 * Screen: four flat quadrants (red, green / blue, yellow), 640x360 CSS pixels at 2x.
 * Camera: flat magenta with a 440 Hz tone. Events: the pointer travels to the yellow
 * quadrant and clicks a small button there at 2000 ms.
 */
export const FFMPEG = path.resolve("node_modules/ffmpeg-static/ffmpeg");
export const CLICK = { t: 2000, x: 480, y: 270, rect: [450, 255, 60, 30] as [number, number, number, number] };
export const QUADRANTS = { red: [255, 0, 0], green: [0, 128, 0], blue: [0, 0, 255], yellow: [255, 255, 0] } as const;

export async function makeTake(
  root: string,
  id: string,
  options: { durationMs?: number; cam?: boolean } = {},
): Promise<Take> {
  const durationMs = options.durationMs ?? 4000;
  const dir = path.join(root, ".clipmunk/takes", id);
  await mkdir(dir, { recursive: true });
  const run = (args: string[]) => execFileSync(FFMPEG, ["-y", "-loglevel", "error", ...args], { cwd: dir });
  const d = durationMs / 1000;
  const boxes =
    "drawbox=x=640:y=0:w=640:h=360:c=green:t=fill,drawbox=x=0:y=360:w=640:h=360:c=blue:t=fill,drawbox=x=640:y=360:w=640:h=360:c=yellow:t=fill";
  run([
    "-f",
    "lavfi",
    "-i",
    `color=c=red:s=1280x720:r=30:d=${d},${boxes}`,
    "-c:v",
    "libvpx-vp9",
    "-b:v",
    "1M",
    "-g",
    "90",
    "-deadline",
    "realtime",
    "-cpu-used",
    "8",
    "screen.webm",
  ]);
  if (options.cam !== false) {
    run([
      "-f",
      "lavfi",
      "-i",
      `color=c=magenta:s=320x240:r=30:d=${d}`,
      "-f",
      "lavfi",
      "-i",
      `sine=frequency=440:duration=${d}`,
      "-c:v",
      "libvpx",
      "-c:a",
      "libopus",
      "-shortest",
      "cam.webm",
    ]);
    run(["-i", "cam.webm", "-vn", "-ac", "1", "-ar", "48000", "audio.wav"]);
  }
  const events: TakeEvent[] = [{ t: 0, k: "resize", width: 640, height: 360 }];
  for (let i = 0; i <= 40; i++)
    events.push({ t: 600 + i * 30, k: "move", x: 100 + ((CLICK.x - 100) * i) / 40, y: 80 + ((CLICK.y - 80) * i) / 40 });
  events.push(
    { t: 1850, k: "cursor", style: "pointer" },
    { t: CLICK.t, k: "down", x: CLICK.x, y: CLICK.y, button: 0, rect: CLICK.rect },
    { t: CLICK.t + 90, k: "up", x: CLICK.x, y: CLICK.y, button: 0 },
  );
  await writeFile(path.join(dir, "events.jsonl"), `${events.map((event) => JSON.stringify(event)).join("\n")}\n`);
  const record = TakeFileSchema.parse({
    version: 1,
    id,
    title: "Synthetic take",
    createdAt: "2026-10-05T12:00:00.000Z",
    source: {
      width: 640,
      height: 360,
      dpr: 2,
      durationMs,
      background: "rgb(255, 255, 255)",
      screen: { file: "screen.webm", offsetMs: 0, latencyMs: 20, width: 1280, height: 720 },
      ...(options.cam !== false
        ? {
            cam: { file: "cam.webm", offsetMs: 0, width: 320, height: 240, hasAudio: true },
            audio: { file: "audio.wav", offsetMs: 0 },
          }
        : {}),
      events: { file: "events.jsonl", count: events.length },
    },
  });
  const edit: TakeEditFile = { version: 1, edit: defaultEdit(durationMs) };
  await writeFile(path.join(dir, "edit.json"), `${JSON.stringify(edit, null, 2)}\n`);
  await writeFile(path.join(dir, "take.json"), `${JSON.stringify(record, null, 2)}\n`);
  return { ...record, edit: edit.edit };
}

/** A take as Clipmunk reads it from disk: take.json merged with its edit.json. */
export async function readTakeFiles(dir: string) {
  const edit = await readFile(path.join(dir, "edit.json"), "utf8").catch(() => undefined);
  return composeTake(
    JSON.parse(await readFile(path.join(dir, "take.json"), "utf8")),
    edit === undefined ? undefined : JSON.parse(edit),
  );
}
