import { afterEach, describe, expect, it } from "vitest";
import { ffmpegPath, ffmpegVersion } from "./ffmpeg";

const saved = process.env.CLIPMUNK_FFMPEG;
afterEach(() => {
  if (saved === undefined) delete process.env.CLIPMUNK_FFMPEG;
  else process.env.CLIPMUNK_FFMPEG = saved;
});

describe("finding FFmpeg", () => {
  it("prefers CLIPMUNK_FFMPEG", () => {
    process.env.CLIPMUNK_FFMPEG = "/somewhere/ffmpeg";
    expect(ffmpegPath()).toBe("/somewhere/ffmpeg");
  });
  it("falls back to the project's ffmpeg-static package without any configuration", async () => {
    delete process.env.CLIPMUNK_FFMPEG;
    expect(ffmpegPath()).toMatch(/node_modules[\\/]ffmpeg-static[\\/]ffmpeg(\.exe)?$/);
    expect(await ffmpegVersion()).toBeTruthy();
  });
  it("reports a missing binary as absent instead of throwing", async () => {
    process.env.CLIPMUNK_FFMPEG = "/nonexistent/ffmpeg";
    expect(await ffmpegVersion()).toBeUndefined();
  });
});
