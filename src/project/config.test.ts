import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { configWarnings, initProject, readConfig } from "./index";

const roots: string[] = [];
afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

describe("the project config", () => {
  const empty = async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-config-"));
    roots.push(root);
    return root;
  };
  const write = (root: string, text: string) => writeFile(path.join(root, "clipmunk.config.json"), text);

  it("is empty when there is no file", async () => {
    expect(await readConfig(await empty())).toEqual({ ok: true, data: { config: { version: 1 }, exists: false } });
  });

  it("reports a file that is not JSON, or not a config", async () => {
    const root = await empty();
    await write(root, "{ version: 1 }");
    expect(await readConfig(root)).toMatchObject({ ok: false, issues: [{ path: "clipmunk.config.json" }] });
    await write(root, JSON.stringify({ version: 1, brand: { radius: "14px" } }));
    expect(await readConfig(root)).toMatchObject({
      ok: false,
      issues: [{ path: "clipmunk.config.json: brand.radius" }],
    });
  });

  it("warns about a logo that is not there, without refusing the config", async () => {
    const root = await empty();
    await write(root, JSON.stringify({ version: 1, brand: { logo: "./brand/logo.svg", backdrop: "#000" } }));
    const read = await readConfig(root);
    if (!read.ok) throw new Error(JSON.stringify(read.issues));
    expect(await configWarnings(root, read.data.config)).toMatchObject([{ path: "clipmunk.config.json: brand.logo" }]);
    await mkdir(path.join(root, "brand"));
    await writeFile(path.join(root, "brand/logo.svg"), "<svg/>");
    expect(await configWarnings(root, read.data.config)).toEqual([]);
  });

  it("is written by init only when the project has none", async () => {
    const root = await empty();
    await writeFile(
      path.join(root, "package.json"),
      JSON.stringify({ dependencies: { react: "19", "react-dom": "19", vite: "8" } }),
    );
    const first = await initProject({}, { root });
    if (!first.ok) throw new Error(JSON.stringify(first.issues));
    expect(first.data.files).toContainEqual({ path: "clipmunk.config.json", status: "created" });
    const read = await readConfig(root);
    expect(read.ok && read.data.config.brand).toEqual({ backdrop: "#0b0b0f", padding: 64, radius: 16 });
    await write(root, JSON.stringify({ version: 1, redact: [".secret"] }));
    const second = await initProject({}, { root });
    expect(second.ok && second.data.files.map((file) => file.path)).not.toContain("clipmunk.config.json");
    expect(await readFile(path.join(root, "clipmunk.config.json"), "utf8")).toBe('{"version":1,"redact":[".secret"]}');
  });
});
