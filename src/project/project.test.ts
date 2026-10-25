import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { getGuide, validateRecipe } from "../core";
import { initProject, listScenes, resolveInside, resolveStudio, syncProject, wrapRootRender } from "./index";

const roots: string[] = [];
async function host(files: Record<string, string>) {
  const root = await mkdtemp(path.join(os.tmpdir(), "clipmunk-test-"));
  roots.push(root);
  for (const [name, content] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), content);
  }
  return root;
}
const read = (root: string, file: string) => readFile(path.join(root, file), "utf8");
const manifest = (deps: Record<string, string>) =>
  JSON.stringify({ dependencies: { react: "19", "react-dom": "19", ...deps } });
const MAIN = `import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { App } from "./App";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <App />
  </StrictMode>,
);
`;
const VITE = {
  "package.json": manifest({ vite: "8" }),
  "tsconfig.json": "{}",
  "index.html": '<script type="module" src="/src/main.tsx"></script>',
  "src/main.tsx": MAIN,
};
const guide = getGuide();
const scenePair = {
  [guide.example.recipePath]: JSON.stringify(guide.example.recipe),
  [guide.example.componentPath]: guide.example.component,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("init", () => {
  it("connects a Vite app, wraps its root once, and is idempotent", async () => {
    const root = await host(VITE);
    const first = await initProject({}, { root });
    if (!first.ok) throw new Error(JSON.stringify(first.issues));
    expect(first.data.adapter).toBe("vite");
    expect(first.data.entry).toEqual({ status: "wrapped", path: "src/main.tsx" });
    const main = await read(root, "src/main.tsx");
    expect(main).toContain('import { ClipmunkStudioHost } from "./clipmunk/Studio";');
    expect(main.match(/<ClipmunkStudioHost>/g)).toHaveLength(1);
    expect(await read(root, "src/clipmunk/Studio.tsx")).toContain("import.meta.glob");
    expect(await read(root, "src/clipmunk/Studio.tsx")).toMatch(
      /import\.meta\.env\.DEV && typeof window !== "undefined"\) void import\("clipmunk\/recorder"\)/,
    );
    expect(first.data.recorder).toEqual({ status: "automatic" });
    expect(await read(root, "CLIPMUNK.md")).toContain("npx clipmunk guide");

    const snapshot = await Promise.all(
      ["src/main.tsx", "src/clipmunk/Studio.tsx", ".clipmunk/project.json", "CLIPMUNK.md"].map((file) =>
        read(root, file),
      ),
    );
    const second = await initProject({}, { root });
    expect(second.ok && second.data.files.every((file) => file.status === "verified")).toBe(true);
    expect(second.ok && second.data.entry.status).toBe("already");
    expect(
      await Promise.all(
        ["src/main.tsx", "src/clipmunk/Studio.tsx", ".clipmunk/project.json", "CLIPMUNK.md"].map((file) =>
          read(root, file),
        ),
      ),
    ).toEqual(snapshot);
  });

  it("generates untyped files for a JavaScript host", async () => {
    const root = await host({ "package.json": manifest({ vite: "8" }), "src/main.jsx": MAIN.replace("!)", ")") });
    const result = await initProject({}, { root });
    expect(result.ok && result.data.files.map((file) => file.path)).toContain("src/clipmunk/Studio.jsx");
    expect(await read(root, "src/clipmunk/Studio.jsx")).not.toContain("ReactNode");
  });

  it("adds a development-only route to Next.js without touching layouts", async () => {
    const layout = "export default function Layout({ children }) { return <html><body>{children}</body></html>; }";
    const root = await host({
      "package.json": manifest({ next: "16" }),
      "tsconfig.json": "{}",
      "app/layout.tsx": layout,
      ...scenePair,
    });
    const result = await initProject({}, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.adapter).toBe("next-app");
    expect(result.data.entry).toEqual({ status: "route", path: "app/clipmunk/page.tsx" });
    expect(result.data.studioUrl).toBe("http://127.0.0.1:3000/clipmunk?clipmunk=1");
    expect(await read(root, "app/layout.tsx")).toBe(layout);
    const page = await read(root, "app/clipmunk/page.tsx");
    expect(page).toContain('from "../../src/clipmunk/Studio"');
    expect(page).toContain("notFound()");
    expect(await read(root, "src/clipmunk/Studio.tsx")).toMatch(/^"use client";/);
    expect(await read(root, "src/clipmunk/catalog.ts")).toContain(
      '"./scenes/page-survey.tsx": () => import("./scenes/page-survey")',
    );
    // Recording needs one line in the root layout; init generates the component and says where it goes.
    expect(await read(root, "src/clipmunk/Recorder.tsx")).toContain("bootRecorder");
    expect(result.data.recorder.status).toBe("manual");
    expect(result.data.recorder.instruction).toContain('import { ClipmunkRecorder } from "../src/clipmunk/Recorder";');
    await writeFile(
      path.join(root, "app/layout.tsx"),
      `import { ClipmunkRecorder } from "../src/clipmunk/Recorder";\n${layout}`,
    );
    const wired = await initProject({}, { root });
    expect(wired.ok && wired.data.recorder).toEqual({ status: "automatic" });
  });

  it("uses the pages router when there is no app directory", async () => {
    const root = await host({
      "package.json": manifest({ next: "16" }),
      "tsconfig.json": "{}",
      "src/pages/index.tsx": "export default () => null;",
    });
    const result = await initProject({}, { root });
    expect(result.ok && result.data.entry).toEqual({ status: "route", path: "src/pages/clipmunk.tsx" });
    expect(await read(root, "src/pages/clipmunk.tsx")).toContain('from "../clipmunk/Studio"');
  });

  it("gives other React hosts a wrapper and an instruction instead of guessing", async () => {
    const root = await host({ "package.json": manifest({}), "src/index.jsx": MAIN });
    const result = await initProject({}, { root });
    if (!result.ok) throw new Error(JSON.stringify(result.issues));
    expect(result.data.adapter).toBe("react");
    expect(result.data.entry.status).toBe("manual");
    expect(result.data.entry.instruction).toContain("<ClipmunkStudioHost>");
    expect(await read(root, "src/index.jsx")).toBe(MAIN);
    expect(await read(root, "src/clipmunk/Studio.jsx")).toContain('process.env.NODE_ENV !== "production"');
  });

  it("refuses to overwrite a file it did not write, and upgrades one it did", async () => {
    const root = await host({ ...VITE, "CLIPMUNK.md": "my own notes" });
    const conflict = await initProject({}, { root });
    expect(!conflict.ok && conflict.issues[0]!.code).toBe("file-conflict");
    expect(await read(root, "CLIPMUNK.md")).toBe("my own notes");
    expect(await read(root, "src/main.tsx")).toBe(MAIN);

    await rm(path.join(root, "CLIPMUNK.md"));
    expect((await initProject({}, { root })).ok).toBe(true);
    await writeFile(path.join(root, "src/clipmunk/Studio.tsx"), "// edited by hand");
    const edited = await initProject({}, { root });
    expect(!edited.ok && edited.issues[0]!.path).toBe("src/clipmunk/Studio.tsx");
  });

  it("explains unsupported hosts", async () => {
    expect(await initProject({}, { root: await host({}) })).toMatchObject({
      ok: false,
      issues: [{ code: "no-project" }],
    });
    expect(await initProject({}, { root: await host({ "package.json": "{}" }) })).toMatchObject({
      ok: false,
      issues: [{ code: "unsupported-host" }],
    });
  });
});

describe("entry wrapping", () => {
  it("handles one-line and self-closing roots and keeps other code intact", () => {
    const edit = wrapRootRender(
      `import ReactDOM from "react-dom/client";\nimport App from "./App";\n\nReactDOM.createRoot(document.getElementById("root")).render(<App />);\n`,
      "./clipmunk/Studio",
    );
    if (edit.status !== "wrapped") throw new Error(edit.status);
    expect(edit.source).toContain(".render(\n  <ClipmunkStudioHost>\n    <App />\n  </ClipmunkStudioHost>,\n);");
    expect(edit.source.indexOf("ClipmunkStudioHost }")).toBeGreaterThan(
      edit.source.indexOf('import App from "./App";'),
    );
  });
  it("places the import after a multi-line import", () => {
    const edit = wrapRootRender(
      `import {\n  StrictMode,\n} from "react";\nconst root = createRoot(el);\nroot.render(<StrictMode><App title="a (b)" /></StrictMode>);\n`,
      "./clipmunk/Studio",
    );
    if (edit.status !== "wrapped") throw new Error(edit.status);
    expect(edit.source).toMatch(
      /\} from "react";\nimport \{ ClipmunkStudioHost \} from "\.\/clipmunk\/Studio";\nconst root/,
    );
    expect(edit.source).toContain('<StrictMode><App title="a (b)" /></StrictMode>');
  });
  it("declines anything it cannot read safely", () => {
    expect(wrapRootRender("root.render(app);", "./x").status).toBe("manual");
    expect(wrapRootRender("a.render(<A />); b.render(<B />);", "./x").status).toBe("manual");
    expect(wrapRootRender("hydrateRoot(el, <App />);", "./x").status).toBe("manual");
    expect(wrapRootRender("root.render(<p>Don't (</p>);", "./x").status).toBe("manual");
    expect(wrapRootRender("root.render(<ClipmunkStudioHost><App /></ClipmunkStudioHost>);", "./x").status).toBe(
      "already",
    );
  });
});

describe("scenes", () => {
  it("validates pairs and reports each problem with its file", async () => {
    const recipe = guide.example.recipe;
    const root = await host({
      ...VITE,
      ...scenePair,
      "src/clipmunk/scenes/orphan.scene.json": JSON.stringify({ ...recipe, id: "orphan" }),
      "src/clipmunk/scenes/renamed.scene.json": JSON.stringify(recipe),
      "src/clipmunk/scenes/renamed.tsx": "export default () => null;",
      "src/clipmunk/scenes/broken.scene.json": "{ not json",
      "src/clipmunk/scenes/typo.scene.json": JSON.stringify({
        ...recipe,
        id: "typo",
        definition: { ...recipe.definition, scene: { nodes: [{ id: "page" }], camra: {} } },
      }),
      "src/clipmunk/scenes/typo.tsx": "export default () => null;",
    });
    const result = await listScenes({ root });
    if (!result.ok) throw new Error("failed");
    expect(result.data.scenes.map((scene) => scene.id)).toEqual(["page-survey"]);
    expect(result.data.issues.map((issue) => issue.code).sort()).toEqual([
      "id-mismatch",
      "invalid-json",
      "invalid-scene",
      "missing-binding",
    ]);
    expect(result.data.issues.find((issue) => issue.code === "invalid-scene")!.path).toContain(
      "typo.scene.json: definition.scene",
    );
  });

  it("keeps the guide's example valid", () => {
    expect(validateRecipe(JSON.parse(JSON.stringify(guide.example.recipe))).ok).toBe(true);
    expect(guide.tracks.map((track) => track.target)).toEqual(["surface", "camera", "focus"]);
    expect(guide.tracks[0]!.properties).toContain("opacity");
  });

  it("syncs the static catalog for non-Vite hosts and skips broken scenes", async () => {
    const root = await host({
      "package.json": manifest({ next: "16" }),
      "tsconfig.json": "{}",
      "app/page.tsx": "",
      "src/clipmunk/scenes/lonely.scene.json": "{}",
    });
    expect((await syncProject({ root })).ok).toBe(false); // not initialised yet
    await initProject({}, { root });
    for (const [file, content] of Object.entries(scenePair)) await writeFile(path.join(root, file), content);
    const synced = await syncProject({ root });
    expect(synced.ok && [synced.data.status, synced.data.scenes]).toEqual(["updated", 1]);
    const catalog = await read(root, "src/clipmunk/catalog.ts");
    expect(catalog).toContain("page-survey.scene.json");
    expect(catalog).not.toContain("lonely");
    expect(
      (await syncProject({ root })).ok && ((await syncProject({ root })) as { data: { status: string } }).data.status,
    ).toBe("verified");
  });

  it("upgrades an adapter generated by an older version, and leaves an edited one alone", async () => {
    const root = await host({ ...VITE, ...scenePair });
    await initProject({}, { root });
    const file = "src/clipmunk/Studio.tsx";
    const current = await read(root, file);
    expect(current).toContain("clipmunk-frame");
    // What an older version generated, recorded as Clipmunk's own.
    const older = current.replace(/\/\/ \?clipmunk-frame[^\n]*\n/, "").replace("frame ? module.ClipmunkFrame : ", "");
    await writeFile(path.join(root, file), older);
    const projectFile = path.join(root, ".clipmunk/project.json");
    const project = JSON.parse(await read(root, ".clipmunk/project.json"));
    project.files[file] = createHash("sha256").update(older).digest("hex");
    await writeFile(projectFile, JSON.stringify(project));
    const synced = await syncProject({ root });
    expect(synced.ok && synced.data.studio).toEqual({ path: file, status: "updated" });
    expect(await read(root, file)).toBe(current);
    // Edited by hand: left alone, with what to do.
    await writeFile(path.join(root, file), `${current}// mine\n`);
    const edited = await syncProject({ root });
    expect(edited.ok && edited.data.issues.map((issue) => issue.code)).toEqual(["file-conflict"]);
    expect(await read(root, file)).toBe(`${current}// mine\n`);
  });

  it("builds studio URLs and remembers the dev server", async () => {
    const root = await host({ ...VITE, ...scenePair });
    await initProject({}, { root });
    const opened = await resolveStudio({ url: "http://localhost:4321/", sceneId: "page-survey" }, { root });
    expect(opened.ok && opened.data.url).toBe("http://localhost:4321/?clipmunk=1&clipmunk-scene=page-survey");
    expect(opened.ok && opened.data.reachable).toBe(false);
    expect(JSON.parse(await read(root, ".clipmunk/project.json")).devUrl).toBe("http://localhost:4321");
    expect(await resolveStudio({ url: "https://example.com" }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "invalid-url" }],
    });
    expect(await resolveStudio({ sceneId: "nope" }, { root })).toMatchObject({
      ok: false,
      issues: [{ code: "unknown-scene" }],
    });
  });
});

describe("path scoping", () => {
  it("rejects traversal, absolute paths and symlinks that leave the project", async () => {
    const root = await host({ "package.json": "{}" });
    const outside = await host({});
    await symlink(outside, path.join(root, "link"));
    await expect(resolveInside(root, "../x")).rejects.toMatchObject({ code: "outside-project" });
    await expect(resolveInside(root, "/etc/passwd")).rejects.toMatchObject({ code: "outside-project" });
    await expect(resolveInside(root, "link/file.txt")).rejects.toMatchObject({ code: "outside-project" });
    await expect(resolveInside(root, "src/new/file.txt")).resolves.toContain("file.txt");
  });
});
