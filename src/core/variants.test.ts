import { describe, expect, it } from "vitest";
import { formatVariant, parseVariant, validateDefinition, variantFrame, variantToken } from "./index";

const definition = (variants?: unknown) => {
  const result = validateDefinition({
    width: 400,
    height: 300,
    scene: { nodes: [] },
    ...(variants ? { variants } : {}),
  });
  if (!result.ok) throw new Error(JSON.stringify(result.issues));
  return result.data;
};

describe("scene variants", () => {
  it("read and write the scene URL's variant", () => {
    expect(parseVariant("theme:dark,locale:pt-BR,ratio:9x16")).toEqual({
      theme: "dark",
      locale: "pt-BR",
      ratio: "9:16",
    });
    expect(formatVariant({ theme: "dark", locale: "de", ratio: "4:5" })).toBe("theme:dark,locale:de,ratio:4x5");
    expect(formatVariant({})).toBe("");
    // Nothing unknown or malformed gets through to the page.
    expect(parseVariant("theme:<script>,ratio:7x3,mode:x,locale:")).toEqual({});
    expect(parseVariant(null)).toEqual({});
    expect(variantToken({ theme: "dark", locale: "de", ratio: "9:16" })).toBe("dark-de");
  });

  it("render a listed ratio at its own size and camera, and fit any other one", () => {
    const scene = definition({ ratios: { "9:16": { width: 300, height: 534, camera: { x: 20 } } } });
    expect(variantFrame(scene)).toMatchObject({ width: 400, height: 300, scene: { scale: 1, left: 0, top: 0 } });
    expect(variantFrame(scene, "9:16")).toEqual({
      width: 300,
      height: 534,
      scene: { width: 300, height: 534, scale: 1, left: 0, top: 0 },
      camera: { x: 20 },
    });
    // 1:1 is not listed: the authored 400x300 is fitted, centred, into a 300x300 frame.
    expect(variantFrame(scene, "1:1")).toEqual({
      width: 300,
      height: 300,
      scene: { width: 400, height: 300, scale: 0.75, left: 0, top: (300 - 225) / 2 },
    });
  });

  it("are checked in the recipe", () => {
    expect(
      validateDefinition({ width: 400, height: 300, scene: { nodes: [] }, variants: { ratios: { "3:2": {} } } }).ok,
    ).toBe(false);
  });
});
