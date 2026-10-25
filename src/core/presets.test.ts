import { describe, expect, it } from "vitest";
import {
  applyPreset,
  defaultEdit,
  describePreset,
  type Preset,
  PresetSchema,
  presetFromEdit,
  type TakeEdit,
  validateConfig,
} from "./index";

const base = defaultEdit(8000);
const trimmed: TakeEdit = { ...base, trim: { startMs: 500, endMs: 6000 } };
const parse = (input: unknown) => PresetSchema.parse(input);
const applied = (edit: TakeEdit, preset: Preset) => {
  const result = applyPreset(edit, preset);
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.data;
};

describe("presets", () => {
  it("hold only what they set, without filling in defaults", () => {
    expect(parse({ edit: { cursor: { size: 2 } } })).toEqual({ edit: { cursor: { size: 2 } } });
    expect(parse({ edit: { zoom: { mode: "auto" } } }).edit?.zoom).toMatchObject({ params: { maxScale: 2.2 } });
  });

  it("refuse manual zooms, unknown parts, a trim and bad export options", () => {
    const manual = { mode: "manual", tracks: [] };
    expect(PresetSchema.safeParse({ edit: { zoom: manual } }).success).toBe(false);
    expect(PresetSchema.safeParse({ edit: { trim: { startMs: 0, endMs: 1 } } }).success).toBe(false);
    expect(PresetSchema.safeParse({ edit: { cursor: { glow: true } } }).success).toBe(false);
    expect(PresetSchema.safeParse({ export: { size: "1080p" } }).success).toBe(false);
    expect(PresetSchema.safeParse({ export: { fps: 29 } }).success).toBe(false);
    expect(PresetSchema.safeParse({ export: { ratios: ["21:9"] } }).success).toBe(false);
    expect(PresetSchema.safeParse({ export: { size: "1920x1080", fps: 60, formats: ["gif"] } }).success).toBe(true);
  });

  it("are checked inside the config, with a path to the preset", () => {
    const result = validateConfig({ version: 1, presets: { launch: { edit: { cam: { size: 9 } } } } });
    expect(result.ok || result.issues[0]!.path).toBe("clipmunk.config.json: presets.launch.edit.cam.size");
    expect(validateConfig({ version: 1, presets: { "Launch!": {} } }).ok).toBe(false);
  });

  it("merge sections field by field and leave the trim alone", () => {
    const next = applied(trimmed, parse({ edit: { cursor: { size: 2 }, canvas: { background: "#2B2117" } } }));
    expect(next.trim).toEqual(trimmed.trim);
    expect(next.cursor).toEqual({ ...base.cursor, size: 2 });
    expect(next.canvas).toEqual({ ...base.canvas, background: "#2B2117" });
    expect(next.cam).toEqual(base.cam);
  });

  it("replace zoom and music whole, and remove music with null", () => {
    const withMusic: TakeEdit = { ...base, music: { style: "upbeat", seed: 7, gain: 0.3, duck: true, sync: true } };
    const next = applied(withMusic, parse({ edit: { zoom: { mode: "off" } }, music: { style: "lofi" } }));
    expect(next.zoom).toEqual({ mode: "off" });
    expect(next.music).toEqual({ style: "lofi", gain: 0.5, duck: true, sync: true });
    expect(applied(withMusic, parse({ music: null })).music).toBeUndefined();
    expect(applied(withMusic, parse({})).music).toEqual(withMusic.music);
  });

  it("are made from the chosen parts of an edit, and give the same parts back", () => {
    const source: TakeEdit = {
      ...trimmed,
      cursor: { ...base.cursor, size: 2.5, clickEffect: "none" },
      cam: { ...base.cam, visible: false },
      music: { style: "lofi", seed: 42, gain: 0.4, duck: false, sync: true },
    };
    const made = presetFromEdit(source, ["cursor", "cam", "music"], { title: "Quiet" });
    if (!made.ok) throw new Error(JSON.stringify(made.issues));
    expect(made.data.music).toEqual({ style: "lofi", gain: 0.4, duck: false, sync: true }); // no seed
    const onto = applied(base, made.data);
    expect(onto.cursor).toEqual(source.cursor);
    expect(onto.cam).toEqual(source.cam);
    expect(onto.canvas).toEqual(base.canvas); // not chosen
    expect(onto.trim).toEqual(base.trim);
    expect(presetFromEdit(base, ["music"]).ok && presetFromEdit(base, ["music"])).toMatchObject({
      data: { music: null },
    });
  });

  it("will not save hand-placed zooms or nothing at all", () => {
    const manual: TakeEdit = { ...base, zoom: { mode: "manual", tracks: [] } };
    expect(presetFromEdit(manual, ["zoom"]).ok).toBe(false);
    expect(presetFromEdit(manual, ["cursor"]).ok).toBe(true);
    expect(presetFromEdit(base, []).ok).toBe(false);
  });

  it("describe themselves in one line", () => {
    expect(
      describePreset(
        parse({
          export: { size: "1920x1080" },
          music: null,
          edit: { zoom: { mode: "auto", params: { maxScale: 1.8 } } },
        }),
      ),
    ).toBe("1080p · no music · zoom up to 1.8x");
    expect(
      describePreset(
        parse({ export: { size: "3840x2160" }, music: { style: "lofi" }, edit: { cam: { visible: true } } }),
      ),
    ).toBe("4K · lofi · camera");
    expect(describePreset(parse({}))).toBe("no changes");
  });
});
