import { describe, expect, it } from "vitest";
import { applyBrand, applyRedaction, defaultEdit, redactionOf, STARTER_CONFIG, validateConfig } from "./index";

const issue = (input: unknown) => {
  const result = validateConfig(input);
  return result.ok ? undefined : result.issues[0];
};

describe("clipmunk.config.json", () => {
  it("accepts the starter and the spec's example", () => {
    expect(validateConfig(STARTER_CONFIG).ok).toBe(true);
    expect(
      validateConfig({
        version: 1,
        brand: { backdrop: "#2B2117", padding: 64, radius: 14, logo: "./brand/logo.svg", outro: true },
        redact: [".client-email", "[data-secret]", 'input[name="card"]', "tr:nth-child(2) > td"],
        presets: { launch: { music: { style: "lofi" } } },
        variants: { themes: ["light", "dark"], locales: ["en", "pt-BR"] },
      }).ok,
    ).toBe(true);
    expect(validateConfig({ version: 1 }).ok).toBe(true);
  });

  it("rejects what it does not know, with a path into the file", () => {
    expect(issue({ version: 1, fixtures: "./x" })?.path).toBe("clipmunk.config.json");
    expect(issue({ version: 2 })?.path).toBe("clipmunk.config.json: version");
    expect(issue({ version: 1, brand: { backdrop: "beige" } })).toMatchObject({
      path: "clipmunk.config.json: brand.backdrop",
      message: expect.stringContaining("hex colour"),
    });
    expect(issue({ version: 1, brand: { padding: -1 } })?.path).toBe("clipmunk.config.json: brand.padding");
  });

  it("checks selectors as far as it can without a browser", () => {
    for (const bad of ["", "[data-secret", "div)", 'a[title="x]', "a { color: red }", "a; b"])
      expect(issue({ version: 1, redact: [bad] })?.path, bad).toBe("clipmunk.config.json: redact.0");
    expect(validateConfig({ version: 1, redact: ['a[title="(x"]'] }).ok).toBe(true); // brackets inside quotes
  });

  it("keeps files inside the project and names variants plainly", () => {
    for (const logo of ["/etc/logo.svg", "../logo.svg", "brand/../../x", "C:\\logo.svg"])
      expect(issue({ version: 1, brand: { logo } })?.path, logo).toBe("clipmunk.config.json: brand.logo");
    expect(issue({ version: 1, variants: { themes: ["Dark Mode"] } })?.path).toBe(
      "clipmunk.config.json: variants.themes.0",
    );
    expect(issue({ version: 1, variants: { locales: ["english"] } })?.path).toBe(
      "clipmunk.config.json: variants.locales.0",
    );
  });

  it("turns the brand into a take's frame", () => {
    const edit = defaultEdit(5000);
    expect(applyBrand(edit, undefined)).toBe(edit);
    const branded = applyBrand(edit, { backdrop: "#2B2117", padding: 64, radius: 14 });
    expect(branded.canvas).toEqual({ ...edit.canvas, background: "#2B2117", padding: 64 / 1080, radius: 14 });
    expect(applyBrand(edit, { padding: 400 }).canvas.padding).toBe(0.37037037037037035);
    expect(
      applyBrand({ ...edit, canvas: { ...edit.canvas, width: 600, height: 600 } }, { padding: 400 }).canvas.padding,
    ).toBe(0.4);
    expect(applyBrand(edit, { logo: "./logo.svg" }).canvas).toEqual(edit.canvas);
  });

  it("reads redaction as a list of selectors or as selectors with a mode and live masking", () => {
    expect(redactionOf(undefined)).toEqual({ selectors: [], mode: "blur", live: false });
    expect(redactionOf({ redact: [".a"] })).toEqual({ selectors: [".a"], mode: "blur", live: false });
    const written = { version: 1, redact: { selectors: [".a"], mode: "block", live: true } };
    expect(validateConfig(written).ok).toBe(true);
    expect(redactionOf(written as never)).toEqual({ selectors: [".a"], mode: "block", live: true });
    expect(issue({ version: 1, redact: { selectors: ["a {"] } })?.path).toBe(
      "clipmunk.config.json: redact.selectors.0",
    );
    expect(issue({ version: 1, redact: { selectors: [], mode: "pixelate" } })?.path).toMatch(
      /^clipmunk\.config\.json: redact/,
    );
  });

  it("gives a new take one redaction entry per configured or logged selector", () => {
    const edit = defaultEdit(4000);
    expect(applyRedaction(edit, undefined)).toBe(edit);
    expect(applyRedaction(edit, { redact: { selectors: [".a", ".b"], mode: "block" } }, [".b", ".c"]).redact).toEqual([
      { sel: ".a", mode: "block" },
      { sel: ".b", mode: "block" },
      { sel: ".c", mode: "block" },
    ]);
    // A broken config still hides what the recording logged; an entry already there is kept as is.
    const own = { ...edit, redact: [{ sel: ".c", mode: "block" as const }] };
    expect(applyRedaction(own, undefined, [".c", ".d"]).redact).toEqual([
      { sel: ".d", mode: "blur" },
      { sel: ".c", mode: "block" },
    ]);
  });
});
