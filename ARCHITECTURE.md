# Clipmunk architecture

Clipmunk is a TypeScript SDK that a developer installs into their own web app. It does two things:

1. **Scenes.** It turns the app's real React components into cinematic 3D shots (camera, depth of field, keyframed motion), authored as source files by the developer's coding agent. This is feature parity with [Flute](https://github.com/webprodigies-org/flute) (MIT), which Clipmunk is modelled on.
2. **Takes.** It records the developer using their own app in a browser tab, then renders the recording with a smoothed synthetic cursor, automatic zooms, a camera bubble and voiceover.

Both produce MP4 files locally. There is no account, no hosted service and no AI integration inside Clipmunk; the developer's own coding agent reads a guide and edits source files.

This document is the implementation map. If code and this document disagree, one of them is a bug.

- npm package: `clipmunk`
- CLI binary: `clipmunk` (`npx clipmunk …`; the package and the binary share a name, so the first run is simply `npx clipmunk init`)
- Runtime: Node 22.12+ for the CLI, React DOM 18.2+ or 19 for scenes, Chromium for recording and export

---

## 1. Principles

These are the rules every module follows. They exist so that preview and export can never disagree.

1. **One explicit clock.** Nothing in Clipmunk reads wall-clock time to decide what a frame looks like. Every renderer is a function of `(definition, timeMs)`. Playback, scrubbing, thumbnails and export all call the same `seek(timeMs)`.
2. **The source of truth is files in the host repo.** Scenes, take edits and sequences are JSON validated by Zod schemas in `core`. The studio UI and the coding agent edit the same files. There is no database.
3. **Core is pure.** `core` has no DOM, no Node and no React imports. All maths (camera, focus, easing, auto-zoom, cursor smoothing) lives there and is unit-tested without a browser.
4. **Effects live at the edge.** Filesystem, processes and network are touched only by `daemon`, `export` and `project` service modules. Policy (validation, scoping, idempotency) lives in operations that call those services.
5. **The host app is not redesigned.** Scenes mount the host's real components with their providers and styles. Clipmunk never clones UI, never resets host CSS, and ships nothing into production builds.
6. **Generators emit ordinary data.** Auto-zoom, cascades and cursor smoothing are pure functions that output the same keyframe tracks a human or agent could write by hand. Nothing is magic at render time.
7. **Honest limits.** Depth of field is a Gaussian approximation in the DOM, not ray-traced bokeh. Recording covers the app's own tab in Chromium, not the desktop.

---

## 2. Concepts

| Term | Meaning |
|---|---|
| **Clip** | Anything with a duration that can render a frame at time `t`. Two kinds: Scene and Take. |
| **Scene** | A 3D shot of live React UI. A JSON recipe plus a component file. Rendered in the DOM with CSS 3D transforms and SVG filters. |
| **Surface** | A React wrapper that places a subtree in 3D space inside a Scene. |
| **Take** | One recording session: screen video, optional camera and microphone, and an event log. Rendered on a canvas. |
| **Track** | A keyframed numeric property: `{ target, property, keyframes }`. Scenes and takes use the same track model. |
| **Sequence** | An ordered list of clips with transitions and audio, exported as one video. |
| **Studio** | The in-app UI for browsing, playing, editing and exporting clips. |
| **Daemon** | A local server on `127.0.0.1` that stores media, reads and writes project files and runs export jobs for the studio. |
| **Capture bridge** | The object a page exposes on `window.__CLIPMUNK__` so the exporter can drive it frame by frame. |

---

## 3. Module map

One package, one `src/` tree, enforced import boundaries.

```
src/
  core/         pure TypeScript + Zod. Schemas, maths, generators, agent guide.
  react/        Scene, Surface, focus filter, scene clock. React DOM.
  compositor/   Canvas renderer for takes. Browser, no React.
  recorder/     Capture session, event log, HUD. Browser, no React.
  studio/       Library, player, take editor, export UI. React, rendered in a shadow root.
  bridge/       The window.__CLIPMUNK__ contract and its browser implementation helpers.
  daemon/       HTTP server, take storage, job runner. Node.
  export/       Playwright frame pump, FFmpeg encode and mux. Node.
  project/      init, framework adapters, discovery, sync. Node.
  cli/          Argument parsing and terminal output. Node.
```

### Import rules

| Module | May import |
|---|---|
| `core` | nothing but `zod` |
| `bridge` | `core` |
| `react` | `core`, `bridge`, `react`, `react-dom` |
| `compositor` | `core`, `bridge`, `mediabunny` |
| `recorder` | `core` |
| `studio` | `core`, `bridge`, `react`, `compositor`, `recorder` |
| `daemon`, `export`, `project` | `core`, Node built-ins, each other's operations |
| `cli` | `core`, `daemon`, `export`, `project` |

Browser modules never import Node modules and the reverse. `scripts/check-boundaries.mjs` parses every import in `src/` and fails the build on a violation.

### Package entry points

| Import | Contents | Environment |
|---|---|---|
| `clipmunk` | `Scene`, `Surface`, `useSceneTime`, core types and helpers | Browser |
| `clipmunk/core` | Everything in `core` | Any |
| `clipmunk/studio` | `ClipmunkStudio`, `ScenePreview` | Browser, dev only |
| `clipmunk/recorder` | `bootRecorder`, `mountRecorderHud`, `createRecorder`, the daemon client | Browser, dev only |
| `clipmunk/vite` | `clipmunk()`, a Vite plugin that marks host elements with their source file in `vite dev` (12.6) | Node, dev only |
| `clipmunk/next` | `withClipmunk(config)`, the same for `next dev --webpack`, through `dist/next-loader.cjs` (12.6) | Node, dev only |
| `clipmunk` binary | CLI | Node |

The plugins carry only `core/source.ts`, not the rest of core. Dependencies: `zod`, `mediabunny`. Peer: `react`, `react-dom` (>=18.2 <20). Optional peer: `playwright` (export, snapshots). System prerequisite for saving recordings and for export: FFmpeg. It is looked up as `CLIPMUNK_FFMPEG`, then the `ffmpeg-static` package if the project has it installed, then `ffmpeg` on `PATH`. `clipmunk dev` warns at startup when none is found, and the recorder refuses to start a recording the daemon could not save.

---

## 4. Files in the host app

```
CLIPMUNK.md                              Agent handoff. Points at `clipmunk guide`.
clipmunk.config.json                     Project-wide settings: brand, redaction, presets, variants (committed).
src/clipmunk/Studio.tsx                  Generated adapter. Dev-only wrapper around the host app.
src/clipmunk/catalog.ts                  Generated scene catalog (Next.js and generic React hosts only).
src/clipmunk/scenes/<id>.scene.json      Scene recipe (committed).
src/clipmunk/scenes/<id>.tsx             Scene component, default export (committed).
src/clipmunk/sequences/<id>.sequence.json  Sequence (committed).
.clipmunk/project.json                   Project identity and the ownership record of generated files.
.clipmunk/.gitignore                     Ignores media, caches, exports and daemon state.
.clipmunk/takes/<id>/take.json           The recording: what was captured, written once at ingest (committed).
.clipmunk/takes/<id>/edit.json           Every change made to the take since (committed).
.clipmunk/takes/<id>/screen.webm         Screen recording (ignored).
.clipmunk/takes/<id>/cam.webm            Camera + microphone (ignored).
.clipmunk/takes/<id>/audio.wav           Voice track extracted at ingest (ignored).
.clipmunk/takes/<id>/events.jsonl        Pointer and interaction log (ignored).
.clipmunk/takes/<id>/recorder.log        Recorder breadcrumbs for diagnosis (ignored).
.clipmunk/audio/<file>                   Narration recordings and any music or voiceover files (ignored).
.clipmunk/exports/                       Default output directory (ignored).
.clipmunk/daemon.json                    Port, pid and session token of a running daemon (ignored).
```

Scene ids and take ids are lowercase slugs (`[a-z0-9]+(-[a-z0-9]+)*`). A scene's id equals its file name and its recipe's `id` field.

Every generated file is recorded in `.clipmunk/project.json` with a content hash. `init` and `sync` only overwrite a file whose current hash matches the record; an edited or unrelated file produces a repair message and no write.

---

## 5. Data model

All schemas live in `src/core` as Zod strict objects. TypeScript types are derived from them. Every document carries a `version`; `core/migrate.ts` upgrades older versions on read.

### 5.1 Tracks and time

```ts
type Keyframe = { timeMs: number; value: number; easing?: "linear" | "easeInOut" | "cinematic" };
type Track    = { target: Target; property: string; keyframes: Keyframe[] };
type Motion   = { durationMs: number; speed?: number; tracks: Track[] };
```

- Keyframe times are strictly increasing. A track holds its first and last value outside its keyframes.
- `easing` applies to the segment that starts at that keyframe. `cinematic` is the quintic smootherstep (zero velocity and acceleration at both ends) and is the default.
- `speed` (default 1) scales authored time to presentation time. Presentation duration is `durationMs / speed`.
- `evaluateMotion(motion, elapsedMs)` returns a plain object of overrides per target. It never throws; invalid input returns issues and no overrides.

Targets by clip kind:

| Clip | Target | Properties |
|---|---|---|
| Scene | `{ kind: "surface", id }` | `x y z rotateX rotateY rotateZ scale opacity` |
| Scene | `{ kind: "camera" }` | `x y z rotateX rotateY rotateZ` |
| Scene | `{ kind: "focus" }` | `distance fStop focalLength maxBlur` |
| Take | `{ kind: "zoom" }` | `x y scale` (centre in source pixels, magnification) |
| Take | `{ kind: "cam" }` | `x y size opacity` |
| Take | `{ kind: "cursor" }` | `scale opacity` |

### 5.2 Scene

```ts
type SceneRecipe = {
  version: 1; id: string; title: string; description?: string;
  definition: {
    width: number; height: number;              // authored frame, default 1400 x 980
    scene: {
      camera: { x, y, z, rotateX, rotateY, rotateZ, perspective };   // perspective 100..10000, default 1400
      focus:  { distance, fStop, focalLength, maxBlur };            // defaults 1400, 8, 50, 6
      nodes:  { id: string; parentId?: string; transform?: Transform }[];
    };
    motion?: Motion;
  };
  audio?: { file: string; offsetMs: number; gain: number }[];       // voiceover, files under .clipmunk/audio
  snapshot?: { image: string; timeMs: number };                     // small PNG data URL for the library
};
```

Units are pixels and degrees. `+x` is right, `+y` is down, `+z` is toward the viewer. The camera translation is subtracted from scene positions; camera rotation rotates the stage. Nodes form a tree by `parentId`; cycles, duplicate ids and missing parents are validation errors.

The matching `<id>.tsx` default-exports a component that returns `Surface` elements whose ids match `nodes`. It imports the host's real components and wraps them in whatever providers they need. It never renders `Scene` itself; the studio supplies that.

The recipe owns each surface's resting transform (`nodes[].transform`); a `transform` prop on a `Surface` overrides individual fields. The studio compares the recipe with what is rendered and reports a node with no Surface, a Surface with no node, and a parent that differs.

### 5.3 Take

```ts
type Take = {
  version: 1; id: string; title: string; createdAt: string;
  source: {                                    // written once at ingest, never edited
    width: number; height: number; dpr: number; durationMs: number;
    background: string;                        // computed page background, composited under the video
    screen: { file: string; offsetMs: number; latencyMs: number };
    cam?:   { file: string; offsetMs: number; width: number; height: number; hasAudio: boolean };
    mic?:   { file: string; offsetMs: number };  // present only when recording audio without a camera
    events: string;                            // "events.jsonl"
  };
  edit: {                                      // everything the user or agent changes
    trim:   { startMs: number; endMs: number };
    canvas: { width: number; height: number; background: string; padding: number; radius: number; shadow: number };
    zoom:   { mode: "auto"; params: AutoZoomParams } | { mode: "manual"; tracks: ZoomTrack[] } | { mode: "off" };
    cursor: { visible: boolean; size: number; smoothing: number; clickEffect: "ripple" | "none"; hideWhenIdleMs?: number };
    cam:    { visible: boolean; shape: "circle" | "rounded"; corner: "tl" | "tr" | "bl" | "br"; size: number; mirror: boolean; tracks?: Track[] };
    audio:  { muted: boolean; gain: number; normalize: boolean };
    redact: ({ sel: string; mode: "blur" | "block" }                                  // follows the log's redact boxes
           | { rect: [x, y, w, h]; fromMs: number; toMs: number; mode: "blur" | "block" })[];  // a hand-drawn box
    captions: { auto: boolean; items: { atMs: number; durMs: number; text: string; source: "auto" | "manual" }[] };
    keys:   { visible: boolean };                // shortcut pills from the log's combo events
    pace:   { deadAir: { on: boolean; maxGapMs: number; speed: number }; typing: { on: boolean; speed: number } };
    frame?: { ratio: "16:9" | "9:16" | "1:1" | "4:5" };  // reframe; absent, the whole recording is fitted
  };
};
```

All `source` times are milliseconds on the take clock, which starts when the screen recorder starts. `offsetMs` shifts a media file onto that clock.

A take is stored as two files, and `Take` above is their merged view, which is all the compositor and the exporters see:

- `take.json` holds `version`, `id`, `title`, `createdAt` and `source`. It is written once at ingest and never again, so the recording is never rewritten.
- `edit.json` holds `{ version: 1, title?, edit }`. Every save writes only this file. `title` is present only when the take has been renamed.

`composeTake` in `core/take.ts` merges them. The edit comes from `edit.json`; failing that, from an `edit` inside `take.json`, which is where takes recorded before `edit.json` existed keep theirs (their first save writes `edit.json`, and `take.json` stays as it is); failing that, from the defaults. `project/takes.ts` reads and saves takes for the daemon, the CLI and the exporter. The revision a save is checked against is a hash of both files.

### 5.4 Event log

`events.jsonl` has one JSON object per line. `t` is milliseconds on the take clock. Coordinates are CSS pixels relative to the capture root.

| `k` | Fields | Notes |
|---|---|---|
| `move` | `x y` | Coalesced to one per animation frame |
| `down` | `x y button rect el?` | `rect` is the bounding box of the interacted element; `el` says which element it was |
| `up` | `x y button` | |
| `cursor` | `style` | `default`, `pointer` or `text`, from the computed cursor under the pointer |
| `scroll` | `x y` | Page scroll offset |
| `focus` | `rect editable el?` | Focused element box; `editable` marks text inputs |
| `type` | `rect` | A keystroke happened in this element. **The key is not recorded.** |
| `combo` | `keys` | A key pressed with Meta, Control or Alt held, such as `["Meta", "K"]`, read from the physical key. Never logged in a password field. |
| `route` | `path` | The page's path at the start and on every change. The query and fragment are left out, because they can carry tokens. |
| `redact` | `sel rects` | The boxes of every element matching one of the config's redaction selectors, logged on the first frame and whenever they change |
| `resize` | `width height` | Capture root size changed |

`el` is `{ sel, role?, name?, testId? }`, made by `recorder/identity.ts`:

- `sel` is a CSS selector that matched only that element when it was logged. It prefers a stable id (React's generated ids are skipped), a test id (`data-testid`, `data-test`, `data-cy`), `aria-label` or a field's `name`. Failing those, it is the shortest path of tags, hand-written classes (hashed CSS-in-JS classes are skipped) and `:nth-of-type` that is unique, stopping at an ancestor that names itself.
- `role` is the explicit or implicit ARIA role.
- `name` is the accessible name, at most 80 characters, from `aria-labelledby`, `aria-label`, a field's `<label>`, placeholder or title, or a control's visible text and image alts. A field's value is never used, except for button inputs, whose value is their visible label. Only controls (buttons, links, fields, tabs and the like) are named, so clicking a table cell records no cell text.

Privacy rules, enforced in the recorder and tested on a real recording:

- No typed text, no field values, and no attribute values beyond the ones a selector uses.
- An element matching a redaction selector, or inside one, gets no `name` and no `testId`, and its selector uses no attribute values.
- In a password field, only `type` with its `rect` is logged: no shortcut, no name beyond its label.

The recorder fetches the redaction selectors from `GET /v1/config` when a take starts. A selector the page cannot parse is skipped and noted in `recorder.log`; if the config cannot be read, the take records without redaction and says so in the same log. Takes recorded before these fields existed simply lack them, and every consumer treats them as optional.

### 5.5 Sequence

```ts
type Sequence = {
  version: 1; id: string; title: string;
  width: number; height: number; fps: 30 | 60;          // defaults 1920 x 1080 at 60
  items: { clip: { kind: "scene" | "take"; id: string };
           transition: { kind: "cut" | "fade"; ms: number } }[];   // how the item arrives from the one before
  audio?: { file: string; offsetMs: number; gain: number }[];      // laid over the whole sequence
};
```

A fade overlaps two clips, so it shortens the total by its length, and it is capped at half of the shorter neighbour. `planSequence(items, durations)` in `core/sequence.ts` computes each item's start, each fade and the total; the exporter and the tests use the same function. The first item's transition is ignored. Items have no trim of their own: a take is trimmed in its own edit.

Sound files are named by plain file name and live in `.clipmunk/audio`. The same `{ file, offsetMs, gain }` shape attaches sound to a scene (`recipe.audio`) and to a sequence.

### 5.5a Music

```ts
type Music = { style: "upbeat" | "lofi"; seed?: number; gain: number; duck: boolean; sync: boolean };
```

A scene (`recipe.music`), a take (`edit.music`) and a sequence (`music`) can each carry one. Without a `seed`, each clip gets its own tune, derived from its kind and id, and keeps it across exports; a `seed` picks a specific one. `gain` defaults to 0.5, `duck` (default on) lowers the music while a voice is present, and `sync` (default on) lines the music up with the clip's key moments. When a sequence has music, its clips are exported without their own.

### 5.5b Project configuration

```ts
type Config = {
  version: 1;
  brand?: { backdrop?: string; padding?: number; radius?: number; logo?: string; outro?: boolean };
  redact?: string[]                                    // CSS selectors, or:
         | { selectors: string[]; mode?: "blur" | "block"; live?: boolean };
  presets?: Record<string, Preset>;                    // named partial edits, below
  variants?: { themes?: string[]; locales?: string[] };
};
```

`clipmunk.config.json` at the project root. It is JSON so Clipmunk reads it without running project code, and so the daemon can write it. Every field is optional and a missing file is the empty config. `core/config.ts` holds the schema; `project/config.ts` reads it, and every issue's path names the file and the field (`clipmunk.config.json: brand.backdrop`).

- **Brand.** `backdrop` is a hex or `rgb()`/`hsl()` colour, `padding` is pixels on the frame's short side, and `radius` is pixels. `applyBrand` turns them into the take edit's `canvas` (padding becomes the edit's fraction of the short side, at most 0.4). Ingest applies the brand once, when it writes `edit.json`, so a later change to the brand never alters an existing take. A config that does not validate is ignored at ingest rather than losing a recording; `clipmunk doctor` reports it. `logo` (a path inside the project) and `outro` are validated and stored but not drawn yet.
- **Redaction.** Selectors are checked as far as is possible without a browser: balanced brackets, parentheses and quotes, and no `{`, `}` or `;`. The short form is a list of selectors; the long form adds `mode` (how new takes hide them, `blur` by default) and `live`. `redactionOf` reads either. The recorder logs the selectors' boxes (5.4) and, with `live: true`, also blurs the elements in the page while recording, so they never reach `screen.webm`; that is off by default because the developer then sees their own app blurred. Ingest gives the new take's edit one entry per selector, from the config and from every selector the log has boxes for (`applyRedaction`), so a take recorded with redaction keeps it even if the config cannot be read at ingest. Like the brand, this happens once.
- **Variants** name themes by slug and locales by language tag. Scenes are rendered in them (6.5).

**Presets** (`core/presets.ts`) are named partial edits, keyed by a slug:

```ts
type Preset = {
  title?: string; description?: string;
  edit?: { canvas?: Partial<Canvas>; zoom?: Zoom; cursor?: Partial<Cursor>; cam?: Partial<Cam>; audio?: Partial<Audio> };
  music?: Music | null;
  export?: { size?: "WxH"; fps?: number; formats?: ("mp4" | "gif" | "poster")[]; ratios?: ("16:9" | "9:16" | "1:1" | "4:5")[] };
};
```

- `applyPreset(edit, preset)` is a pure merge: each section merges field by field, `zoom` and `music` are replaced whole, `music: null` removes music, and the trim is never touched because it belongs to one recording. Sections hold only what they set: their defaults are stripped from the schema, so a preset never carries a whole section by accident. A preset's zoom must be `auto` or `off`, because manual keyframes are positions in one recording.
- `presetFromEdit(edit, fields)` copies the chosen sections of an edit into a preset ("save current as preset"). It leaves out the music seed, so each clip that uses the preset keeps its own tune, and refuses manual zooms.
- `project/presets.ts` lists, applies and saves. Applying to a take reads the preset from the config and saves through the usual revision check. A scene carries no take edit, so a preset gives a scene only its music (`applyPresetToScene` in `daemon/audio.ts`). Saving rewrites `clipmunk.config.json` with every other key in its place and the file's own indentation (a tab or a number of spaces), so the diff is the preset alone; a preset of the same name is replaced only when asked, and keeps its place. A config that does not validate is never written.
- `export` options fill in what an export job (12.4a) leaves out.

### 5.6 Results and errors

Every operation returns `{ ok: true, data } | { ok: false, issues: { code, path?, message }[] }`. Codes are stable strings (`invalid-scene`, `output-exists`, `missing-ffmpeg`, …). Messages tell the reader how to fix the problem. Operations do not throw for expected failures.

---

## 6. Scene renderer (`core/spatial`, `react`)

### 6.1 Spatial evaluation

`evaluateScene(scene, measurements)` in `core/spatial.ts`:

1. Builds the camera matrix from the negated camera translation and the camera rotation.
2. For each node, composes `parent world × translate(layout offset + transform) × rotateX × rotateY × rotateZ × scale`. Layout offsets come from the registry (6.3), so a Surface starts exactly where CSS laid it out.
3. Returns each node's world matrix, depth and focus field, plus issues (surface behind the camera plane, non-finite matrices, zero-area surfaces).

CSS output mirrors the same order: `translate3d() rotateX() rotateY() rotateZ() scale()`.

### 6.2 Depth of field

The projection plane sits at `+perspective`. A point with camera-space `z` has depth `perspective − z`. For a surface, depth varies linearly across its plane:

```
depth(x, y) = depth₀ + depthX · x + depthY · y
sigma(depth) = min(maxBlur, focalLength / (4 · fStop · (distance − focalLength)) · |depth − distance|)
```

`sigma` is the Gaussian standard deviation that matches a thin-lens circle of confusion, expressed on the surface's local plane so CSS perspective magnifies it exactly once.

Each visual leaf gets one of three treatments, chosen by `core`:

| Case | Treatment | Measured cost on an Apple M5 at 2x |
|---|---|---|
| Blur is zero everywhere | No filter | 120 fps |
| Blur is uniform across the surface (flat to camera, or fully past the cap) | CSS `blur()` | 120 fps |
| Blur varies across the surface | SVG filter: N Gaussian bands, each masked by a depth-weight table, summed | 77 fps at 3 bands, 46 fps at 5 bands, 19 fps for 3 surfaces at 5 bands |

The depth-varying filter uses two tiny alpha-ramp images (one per axis) blended into a linear depth texture, then one `feComponentTransfer` table per band converts depth to that band's weight. Band weights are hat functions that sum to one. Bands with zero weight everywhere are omitted.

**Quality tiers.** Because the varying filter is the only expensive path:

- `quality="full"`: 6 bands. Always used by export and snapshots, where frame time does not matter.
- `quality="preview"`: 3 bands.
- The studio currently uses `preview` while playing and `full` when paused.
- `quality="auto"` (planned, not built): starts at `preview`; if the measured frame time stays over budget for half a second, varying surfaces fall back to a single uniform blur sampled at the surface centre until playback pauses. Pausing always re-renders the current frame at `full`.

### 6.3 React binding

- `Scene` creates a **registry** and a **clock store**. It renders a flat backdrop element with CSS `perspective` and, inside it, a `preserve-3d` stage carrying the camera transform.
- `Surface` registers `{ id, parent, element, transform }` with the registry in a layout effect. The registry measures untransformed layout (`offsetWidth`, the `offsetParent` chain, minus scroll) and reports each surface's size and its centre offset from its parent's centre. A `ResizeObserver` and a `MutationObserver` keep measurements fresh.
- A Surface with nested Surfaces is a **group**. Groups keep `preserve-3d` and are never filtered, because a filter would flatten their children. A group's own paint goes in its `content` prop, which renders as a filtered leaf. The registry reports visible text or media sitting directly in a group as a diagnostic, and capture refuses a scene with diagnostics.
- Spatial wrappers ignore pointer events; visual leaves receive them, so the live UI stays interactive in preview.

**Frames do not go through React.** This is a deliberate departure from Flute, which re-renders the tree from state on every frame. In Clipmunk, the clock store holds `timeMs`. On each tick the Scene evaluates motion and spatial maths once and writes `style.transform`, `style.opacity`, `style.filter` and the filter table attributes directly on the registered elements. React re-renders only when the definition, the registered structure or measurements change. Components that want scene time opt in with `useSceneTime()`, which subscribes through `useSyncExternalStore`; `seek()` wraps the update in `flushSync` so those components are committed before the frame is captured.

### 6.4 Diagnostics and recovery

- Invalid recipe JSON keeps the last valid definition on screen and lists the issues.
- A component that throws is caught by an error boundary with a retry action; fixing the source and saving recovers through the host's hot reload.
- The scene root carries `data-clipmunk-valid="true|false"`. The capture bridge rejects `seek` while it is false.

---

### 6.5 Variants

One scene renders in several themes, locales and shapes. Clipmunk never knows how the host does theming or translation: `useSceneVariant()` (from `clipmunk`) returns `{ theme?, locale?, ratio? }`, and the scene component hands it to the host's own providers, such as `<ThemeProvider theme={variant.theme}>`. `ratio` is absent for the scene's authored shape; a component may read it to lay out differently.

- **Where values come from.** Themes and locales are listed in the config's `variants` (5.5b); ratios are 16:9, 9:16, 1:1 and 4:5.
- **How they reach the page.** In the scene URL: `clipmunk-variant=theme:dark,locale:de,ratio:9x16` (`parseVariant` and `formatVariant` in `core/variants.ts`, which drop anything malformed). The player reads it, provides it to the scene with `SceneVariantProvider`, and keeps it in the address when the variant select changes it, so the exporter opens exactly what the player shows.
- **Ratios.** A recipe may give a ratio its own frame size and camera: `definition.variants.ratios["9:16"] = { width, height, camera? }`; the camera fields given override the scene's. A ratio the recipe does not list is fitted: the scene renders at its authored size, centred in a frame of that shape (1080 pixels or the authored short side, whichever is smaller, on the short side). Clipmunk never reflows a scene. `variantFrame` computes both, and the capture bridge reports the variant's frame size.
- **Export.** `exportScene` takes `variant` and opens the scene with it; an export job (12.4a) renders every combination of its `variants` and `ratios` with the ordinary scene exporter, named `<scene>.<ratio>.<variant>.mp4`. A bare variant in a job (`dark`) must be one of the config's themes or locales; `theme:x` and `locale:x` name one directly.

The example app's `themed-card` scene is the reference: it reads the variant, passes `theme` to the app's own `ThemeProvider`, lays out differently for 9:16, and has a 9:16 entry in its recipe.

## 7. Capture bridge (`bridge`)

Any page that can be exported exposes exactly one bridge:

```ts
interface ClipmunkBridge {
  version: 1;
  kind: "scene" | "take";
  durationMs: number;
  width: number; height: number;          // authored frame size
  selector: string;                        // the element to screenshot, for DOM clips
  ready(): Promise<void>;                  // fonts, images, media metadata loaded
  seek(timeMs: number): Promise<void>;     // resolves when that frame is fully applied
  encode?(job: { fps; width?; height? }): Promise<EncodedClip>;   // canvas clips: render and encode in-page
}
```

- Scenes implement `seek` and are captured by screenshot.
- Takes implement `encode`, because their frames are already on a canvas and in-page encoding measured roughly ten times faster than screenshots. File bytes leave the page through a `__CLIPMUNK_WRITE__(base64, position)` binding the exporter provides, and progress through `__CLIPMUNK_PROGRESS__`.
- Studio chrome is marked `data-clipmunk-chrome` and hidden by the exporter in its own private page only.

---

## 8. Recorder (`recorder`)

Runs in the developer's own tab, in Chromium. Verified in spikes on Chromium 153 (Linux and macOS).

### 8.1 Capture

1. **Root.** The capture root is `document.body`, so modals and toasts portalled to `body` are recorded. The recorder HUD is a custom element appended to `<html>`, outside `body`.
2. **Screen.** `getDisplayMedia({ preferCurrentTab: true })`, then `track.restrictTo(RestrictionTarget.fromElement(body))`. This excludes the HUD. It requires `isolation: isolate` on `body` for the duration of the recording.
3. **Background shim.** A page background set on `html` or `body` is painted on the canvas, not inside `body`, so it is missing from a restricted capture. While recording, the recorder inserts a fixed, full-viewport element at the lowest z-index inside `body` carrying the computed page background, and also stores that colour in `source.background`.
4. **Cursor.** Chrome draws the native cursor into tab capture and has no capture option to turn it off. The recorder applies `cursor: none !important` to everything in `body` while recording, and the HUD draws a stand-in cursor on `<html>` so the developer can still see where they point. The recording is cursor-free.
5. **Camera and microphone.** One `getUserMedia` stream recorded by one `MediaRecorder`, so picture and voice stay in sync. If the camera is off, the microphone is recorded alone.
6. **Events.** Listeners on `window` in the capture phase write the event log (5.4). Events that originate in the HUD are skipped. To log the cursor shape an element asks for, the recorder switches its own `cursor: none` rule off for the instant of the style read; nothing is painted in between.
7. **Live redaction.** With `redact.live` in the config (5.5b), a style sheet blurs the redaction selectors' elements while recording, one rule per selector so a selector the browser cannot parse drops only its own rule. Their boxes are logged either way, so the export hides them as well.

### 8.2 Clocks

The take clock is `performance.now()` minus the moment `start()` is called on the screen `MediaRecorder`. The recorder's `start` *event* is not used: it was measured firing 220 to 300 ms after recording had really begun, which put every logged event that far ahead of the picture. Camera and microphone store their own `start()` time as an offset on the same clock.

The file's own clock begins at the first frame that follows `start()`, and a tab capture emits a frame only when the page repaints. So the recorder repaints one pixel on every frame for the first 800 ms of a recording. The first frame then shows the page at take time zero, and because each later frame is delayed by the same capture latency, the picture at video time `t` is the page at take time `t`. A test clicks after 1.8 seconds of a still page and checks that the click is visible in the video within a few frames of its logged time (measured: +58, -9 and +17 ms).

`source.screen.latencyMs` is still measured, by flashing a marker between two colours before recording and timing paint to capture, but it is informational. Takes recorded before this fix (5 October 2026) can show the cursor a quarter of a second ahead of the picture.

### 8.3 Storage

Each `MediaRecorder` emits a chunk every second. The recorder uploads chunks to the daemon as they arrive (`PUT …/media/<track>?seq=n`), so a crashed tab loses at most a second. The event log is uploaded in batches the same way. `finalize` triggers ingest. If ingest fails, the uploaded files stay in place and the HUD offers to retry the save.

Chunks of a track must arrive in order: the daemon rejects any other sequence number, and the recorder retries a chunk before sending the next. Without a daemon the HUD refuses to start and shows the command to run. Recording into browser downloads is not supported.

Take ids read as a timestamp (`take-20261005-142233`), so listings sort by time.

### 8.4 Stopping, interruptions and diagnosis

- **Stopping.** The HUD's Stop button, `Alt+Shift+R`, and the browser's own "Stop sharing" control all end a recording the same way.
- **Full page loads end a tab capture.** Client-side route changes are fine; a reload or a real navigation is not. While recording, the recorder keeps the take id and timing in `sessionStorage`. When the page loads again, the HUD reopens by itself, says what happened and offers to save the part the daemon already holds, or to discard it.
- **The studio is not recordable.** Its pages navigate with full page loads, so the HUD declines to record on any URL with `?clipmunk`.
- **Upload failures stop the recording** at once and offer to save what was uploaded. The daemon accepts a retried chunk whose response was lost without writing it twice.
- **No step can hang.** The HUD shows which start step is in progress. The capture restriction has a timeout, and the latency measurement never waits on `video.play()`, which stays pending on a still page because a tab capture emits no frame until something repaints.
- **Diagnosis.** The recorder sends breadcrumbs (start parameters, page unload, script errors, visibility changes, track events, upload failures, stop) to `PUT /v1/takes/:id/log`; the daemon appends them to `.clipmunk/takes/<id>/recorder.log`.

### 8.5 Ingest (daemon)

Raw `MediaRecorder` files have no duration or seek index. Ingest runs `ffmpeg -c copy` to remux each file (fast, lossless), probes dimensions, extracts the voice track to 48 kHz mono WAV (`audio.wav`, from the camera file when it carries audio, otherwise from the microphone file), rewrites `events.jsonl` keeping only lines that match the event schema, and writes `take.json` and an `edit.json` holding the default edit with the project's brand and redaction applied and pacing on (the edit first, so a listed take always has one). It then finds where the voice track has speech (9.8) and caches it in `speech.json` beside the take. `source.durationMs` is the recorder's own clock, not the container's, because a static page produces no frames near the end. Tab capture has a variable frame rate by nature (it emits frames only when the page repaints); the compositor looks frames up by time, so no re-encode is needed.

---

## 9. Take compositor (`compositor`, `core/autozoom`, `core/cursor`)

`drawTake(ctx, width, height, take, frame)` draws one frame and is a pure function of its arguments. `createTakeRenderer` wraps it with media and derived data, and exposes `renderAt(clipMs)` for the preview and `encode(job, write, progress)` for export; both draw through the same function. Clip time starts at zero at the trim start and reaches take time through the take's time map (9.8); everything derived from the log (zoom, cursor, redaction, captions, keys) works on take time.

### 9.1 Frame sources

`mediabunny` demuxes and decodes the screen and camera files with WebCodecs. Because recordings have a variable frame rate, "the frame at time t" is the latest frame whose timestamp is not after `t`. Playback and export ask for increasing times, served by one forward decode; a request that goes backwards or jumps more than 1.5 seconds ahead restarts decoding from the nearest keyframe. A real `MediaRecorder` take (remuxed, variable frame rate) is decoded, composited and exported in the recorder test suite.

### 9.2 Layers, bottom to top

1. Canvas background (`edit.canvas.background`).
2. The screen frame over `source.background`, inset by `padding`, with rounded corners and a shadow, moved by the zoom at that time. With reframing, only the crop window (9.9) is laid out, so it fills the frame.
3. Redacted areas (9.6), drawn on the screen frame so they move and zoom with it.
4. Click ripples, in screen space.
5. The synthetic cursor, in screen space, so it grows with the zoom. Arrow, hand and text-beam shapes are vector paths.
6. The camera bubble, in canvas space: a circle or rounded square in a chosen corner, cover-cropped and optionally mirrored.
7. The caption strip and key pills (9.7), in canvas space along the bottom of the recording, so they stay readable at any zoom.

Pixel-valued settings (corner radius, cursor size, margins) are authored against the edit's canvas size and scaled for any other output size, so a half-size export looks the same.

### 9.3 Auto-zoom

`generateZoomTracks(events, source, params)` in `core/autozoom.ts` is pure and deterministic:

1. **Activity.** Clicks and keystrokes, each with its element's box. A click whose box is nearly the whole page (the background) aims at the pointer instead. Hovering and scrolling are not activity.
2. **Segments.** Activity closer together than `mergeGapMs` (default 2500) forms one zoom segment.
3. **Scale.** One magnification per segment: half of what would make its largest target fill the frame, clamped to `minScale` and `maxScale` (defaults 1.25 and 2.2).
4. **Follow.** Inside a segment the view stays put while the action remains in the inner 62% of the view, and pans when it leaves.
5. **Timing.** Ease in over `easeMs` (default 700), arriving `leadMs` (default 300) before the first activity. Hold `holdMs` (default 1500) after the last, then ease out. A segment that starts before the previous one has finished easing out pans straight to it.

The view is clamped so it never shows anything outside the recording; a property test checks this at every 50 ms. The output is three ordinary tracks (`x`, `y`, `scale`) on `{ kind: "zoom" }`. With `edit.zoom.mode = "auto"` they are regenerated from `params`; `clipmunk zoom <take> --write` stores them as `manual` tracks in the take's `edit.json` for hand editing.

### 9.4 Cursor

`prepareCursor(events, smoothing)` in `core/cursor.ts` resamples the pointer path at 120 Hz and smooths it with a forward-then-backward exponential filter, so the smoothed cursor does not lag the real pointer. The path is then pulled back toward each click within 140 ms either side, so it passes through the click position exactly, and it is held past the last event so it settles on the true final position. Cursor shape follows the logged `cursor` events; `pressed` shrinks it slightly between `down` and `up`. The cursor is not drawn before the pointer first moves.

### 9.5 Audio

The preview plays the extracted voice track alongside the clock, through the time map: it is muted in sped-up stretches and moved back into step when it drifts. Export never handles audio in the page: FFmpeg receives the voice file with its offset, the time map's segments, the gain and the loudness flag, keeps the normal-speed segments, puts silence of the new length in place of the sped-up ones, and writes AAC into the final MP4. The voice is never time-stretched, so it is never pitch-shifted.

### 9.6 Redaction

`redactionTrack(events, edit.redact)` in `core/redact.ts` is pure: it gives the boxes to hide at any time, in source CSS pixels.

- **Selector entries** follow the log's `redact` events. Each event carries every box of its selector and holds until the next one; an empty list means the element is gone.
- **No frame shows it.** The picture and the log can disagree by a frame or two, so around every change both the old and the new boxes are covered for 150 ms either side (which also covers the time before the first event), and every logged box is grown by 4 px on each side.
- **Box entries** are drawn exactly as given, from `fromMs` until `toMs`, for anything a selector does not cover. The Studio will draw them by hand; for now they are written in `edit.json`.

`drawTake` hides each box on the screen frame, under the cursor. `block` fills it with a solid colour. `blur` redraws the part of the recording the blur reaches, clipped to the box, with a Gaussian blur of a quarter of the box's short side and at least 6 source pixels, so text of any size in the box is unreadable. Every export path draws through `drawTake`, so MP4 has it now and GIF and poster will too. The take editor lists the entries, each with blur or block.

### 9.7 Captions and key pills

`generateCaptions(events, redaction)` in `core/captions.ts` is pure and deterministic, like auto-zoom:

1. **Bursts.** Clicks and keystrokes closer together than 2.5 seconds are one burst, and a burst gets at most one caption.
2. **Phrase.** From the burst's first click on a named control, by its role: "Click New invoice" for a button, "Open Settings" for a link, tab or menu item, "Choose Monthly" for a radio or option, "Toggle Dark mode" for a checkbox or switch, and "Type in Search" for a field typed into during the burst. A control has a name only when the recorder logged one, which it never does inside a redaction selector (5.4), and a click inside a redacted box (9.6) is skipped as well.
3. **Timing.** From 300 ms before that click until a second after the burst's last activity, at least 1.8 seconds, and ending before the next caption starts.

`resolveCaptions(edit, events)` gives what a take shows. With `captions.auto` on, the generated captions are recomputed and the edit's manual items replace the ones they overlap; a manual item with empty text hides the caption at its time. With it off, the stored items are shown as they are. The take editor lists the captions with their text editable, and an edit stores a manual item at that caption's time. `captionAt` fades a caption in and out over 150 ms.

`keyPills(events)` in `core/keys.ts` turns `combo` events into pills such as "⌘ K", each shown for 900 ms, at most three at once. The recorder logs a combo only when Meta, Control or Alt is held and never in a password field, so plain typing never makes a pill.

`drawTake` draws the caption centred along the bottom of the recording, and the pills in a row above it (or in its place when no caption shows). Both use the edit's backdrop colour, which the brand sets, at 88% opacity, with black or white text, whichever reads better; long text shrinks to fit the recording's width.

### 9.8 Pacing and the time map

`buildTimeMap(edit, events, speech)` in `core/timemap.ts` is the one place that maps between clip time (what plays) and take time (the recording). It is piecewise linear: a list of segments of take time, each with a speed, that tile the trim. With pacing off it is one segment, the trim, at normal speed.

- **Dead air.** A gap between two inputs (pointer, keys, scroll, focus; a box moving on the page is not input) longer than `maxGapMs` (600) plays at `speed` (4x), keeping half of `maxGapMs` at normal speed at each end so actions never start abruptly. The time before the first input and after the last counts as a gap.
- **Typing.** A run of at least three keystrokes no more than a second apart plays at `typing.speed` (2x).
- **Speech.** Nothing with speech in it is sped up, with 200 ms of room either side. `detectSpeech` finds speech in 20 ms frames by loudness, with a threshold 10 dB over the recording's noise floor kept between -50 and -35 dBFS; `project/speech.ts` runs it on `audio.wav` and caches the spans, on the take clock, in `speech.json` beside the take. It is a cache, not part of the recording: it stays out of git and is rebuilt when missing. The daemon serves the spans with the take, so the editor and the exporter's page build the same map.
- **Who uses it.** The compositor (frames and every overlay), music moments (`takeMoments`), the timeline (which stripes the fast parts), the trim buttons, the preview's voice, the export's duration, frame count and audio.

Pacing is off in the schema, so takes recorded before it play as they always did; ingest turns it on for new takes, and the take editor has a checkbox for each kind.

### 9.9 Reframing

`edit.frame.ratio` reframes a take to 16:9, 9:16, 1:1 or 4:5. The canvas takes the ratio (1080 pixels on the short side, `ratioCanvas`), and the export's size scales it. Without `frame`, the whole recording is fitted into the canvas as before.

`reframePath(events, source, aspect)` in `core/reframe.ts` is pure. For a shape narrower than the recording it gives a crop window as tall as the recording and as wide as the canvas's inner shape allows, whose left edge follows the clicked elements: it starts on the first click, and moves to each later one with auto-zoom's easing and lead (it arrives 300 ms early, over at most 700 ms), never leaving before the previous press is released. It centres on the clicked box, kept inside the recording, or on the pointer for a click on the page background. So every clicked box that fits is inside the window from its press to its release; a randomized unit test and the recorder suite check this. A shape as wide as the recording or wider crops nothing.

The renderer lays out the window in place of the recording and keeps the zoom's view inside it, centred on it when not zoomed. The take editor's Shape select sets the ratio; 4:3 fits the whole recording.

## 10. Studio (`studio`)

The studio runs inside the host app's dev server, in the host's React tree, so scenes get the host's providers. All studio UI renders in a shadow root so host CSS cannot leak in and studio CSS cannot leak out.

### 10.1 Mounting

`init` generates `src/clipmunk/Studio.tsx`, which exports `ClipmunkStudioHost`. The host wraps its app with it once:

```tsx
<ExistingProviders>
  <ClipmunkStudioHost>
    <ExistingApp />
  </ClipmunkStudioHost>
</ExistingProviders>
```

- Without `?clipmunk` in the URL the wrapper returns `children`, so the app is unaffected. In development the generated module also calls `bootRecorder()` from `clipmunk/recorder`, which remembers a daemon link in the URL and registers the recorder shortcut; nothing is shown until it is used.
- The Studio itself is not in the app: it is served by the daemon (10.3a). `?clipmunk=1` in the app shows a one-line page pointing to it, or forwards there, keeping the clip in the address, when the browser knows a running daemon.
- `?clipmunk-frame=1&clipmunk-scene=<id>` renders the frame page (10.4), which the Studio frames and export opens. It is the only screen left in the app.
- The wrapper lazy-loads `ClipmunkFrame` or the hand-off from `clipmunk/studio` behind the bundler's compile-time development condition (`import.meta.env.DEV` or `process.env.NODE_ENV`), so a production build contains no Clipmunk code. The installed-package check greps the production output to prove it.
- `ClipmunkFrame` receives `scenes`: a map from module path to lazy loader for every recipe and component. It loads the recipes and the one component it shows.
- In Next.js the studio is a development-only route (`/clipmunk`) instead of a wrapper.
- `clipmunk init` and `clipmunk sync` replace an adapter generated by an older version through the ownership record (13), and report one the developer has edited instead of touching it.

### 10.2 Views

All of these are in the standalone Studio except the recorder HUD, which runs in the app.

| View | What it does |
|---|---|
| **Library** | Every take, scene and sequence as a card (`studio-app/Library.tsx`): thumbnail (a scene's snapshot, a take's poster), length, size, ratio and the scene's theme count, with filters by kind and search by name. A card shows "Rendering n%" while an export job for it runs (from `job` events on `/v1/events`, which name the clip). Its Export button opens the export panel: ratios and themes as toggles, formats as checkboxes, the file count ("2 ratios × 2 themes = 4 files"), and a queue with each planned file's progress; files land in `.clipmunk/exports`. "New scene" gives a prompt to paste to the coding agent; Clipmunk never writes scenes itself. Lists refresh when a take is recorded or a clip or the config changes. |
| **Scene player** | The rail, and the host's frame page in an iframe, with "Preview as" any variant, "Compare" for a second live frame in another variant that follows the first one's time, and "Pick an element to hide", which adds the clicked element's selector to the config's redaction (`POST /v1/config/redact`): the authored frame fitted inside the viewport and clipped to its edges, so the preview shows exactly what export renders. Play, scrub, replay and export. Shows diagnostics and hot-reload status. |
| **Take editor** | A rail of every clip on the left; the composited preview on a canvas, with "Preview as" another ratio (a reframed copy, not saved); the timeline's tracks (`studio/Tracks.tsx`): the take (kept range with draggable ends, sped-up parts striped), clicks, zooms, captions, redactions and music accents, any of which selects what the inspector shows; the inspector (`studio/Inspector.tsx` and `TakeControls.tsx`): a zoom's target selector, scale and easing (editing one stores the zooms as manual keyframes), a caption's text, the redaction list with "Draw a box to hide" (drag over the preview), and otherwise every group: pace, zoom, cursor, frame (with the brand's backdrop as the first swatch), overlays (automatic captions, shortcuts, the face bubble), camera, captions, music and voice. A preset bar above the preview lists the config's presets with their one-line summaries (`studio/PresetBar.tsx`): choosing one previews it at once, Apply makes it the edit, and "Save current as preset" writes the chosen parts to `clipmunk.config.json` with a minimal diff (5.5b); a config change on disk updates the bar through `/v1/events`. Undo and redo (buttons and Ctrl+Z) go through the daemon's history. Edits apply to the preview at once and are saved to `edit.json`, which the footer names, half a second later, against a revision hash. |
| **Recorder HUD** | Record, stop, camera and microphone toggles, elapsed time, viewport size, a stand-in cursor and a live camera preview. A plain-DOM custom element on `<html>`; opened by `Alt+Shift+R` or `?clipmunk-record=1` on any app route. There is no pause. |
| **Sequence builder** | Create a sequence by name, add scenes and takes, reorder and remove them, choose a cut or a fade and its length, and set the shape and frame rate. Saved to the sequence file through the daemon. There is no live preview of a whole sequence; it is seen by exporting. |
| **Export panel** | Resolution (the clip's own size, 720p, 1080p, 1440p or 4K, always in the clip's own shape and never over 3840 pixels a side) and frame rate where the clip allows a choice; runs a daemon job and shows progress. Without a daemon it shows the equivalent CLI command, including the chosen size. A sequence's resolution is set in its builder, because it is stored in the sequence file. |

### 10.3 Playback session

One hook, `useClipSession`, owns the cursor: `timeMs`, `playing`, `seek`, `toggle`. It drives the clock store by `requestAnimationFrame` during playback, pauses when the tab is hidden or reduced motion is requested, clamps time when the duration changes and keeps the last valid definition while source is invalid. The capture bridge calls the same `seek`.

---


### 10.3a The standalone Studio

`src/studio-app` is a static single-page app, built by `scripts/studio-app.mjs` into `dist/studio-app/` and served by the daemon at its own address (`http://127.0.0.1:4747/`). `clipmunk dev` prints its link with the daemon link in the fragment. It reuses the studio's components: the library (scenes from `GET /v1/scenes?detail=1`, refreshed through `/v1/events`), the take editor, the sequence builder and the export panel, which all talk only to the daemon, so they work while the host app is not running. The scene player frames the host's frame page (10.4) at the `devUrl` from `GET /v1/status`, hands it the daemon link, and drives it with the frame protocol; the controls (play, scrub, variant, narration, music, export) live in the Studio. When no `ready` arrives, it says the host's dev server is not answering and how to start it. An export started from the Studio renders from the project's `devUrl`. The recorder HUD links each saved take to it ("Open in Studio"), and `clipmunk open` opens it.

### 10.4 The frame page

`ClipmunkFrame` renders one scene alone, fitted to the window, with no controls: the scene player in its bare mode. It installs the capture bridge, so export opens it (12.1), and it runs the Studio's message protocol (`studio/frame-agent.ts`), so the standalone Studio (19.1) can show the scene in an iframe and drive it. Every message carries `cm: 1`. Messages are accepted only from a loopback origin on the daemon's port (from the daemon link in the frame's address), and replies go only there.

| Message | From | What it does |
|---|---|---|
| `seek { t, seq }` | Studio | Show scene time `t`. The latest seek wins and stale ones are dropped; `frame { t, seq }` replies once that frame is drawn. |
| `play { from? }`, `pause` | Studio | The frame owns the clock while playing and reports `tick { t }` every frame, then `stopped { t }`. Music and sound effects preview in the frame. |
| `pick { on }` | Studio | Outline the element under the pointer; a click replies `picked { el, rect }`, with `el` as in the event log (5.4) and `rect` in scene pixels. The click never reaches the scene. |
| `variant { variant }` | Studio | Render another variant (6.5). |
| `narrate { action }` | Studio | Start, stop or remove narration recorded in the frame. |
| `ready { durationMs, width, height, variant }` | Frame | The scene is drawn; sent again after a hot reload or a new variant. |
| `narration { phase, hasNarration }` | Frame | The narration state. |

The export suite captures every scene of the example app at its start, middle and end from both the studio page and the frame page and checks the PNGs are byte-identical.

## 11. Daemon (`daemon`)

Started by `clipmunk dev`. It binds `127.0.0.1` only and writes `.clipmunk/daemon.json`.

### 11.1 Security

- Every request must carry the session token (`Authorization: Bearer …`). The token is random per start and reaches the studio in the URL fragment of the link `clipmunk dev` prints, then lives in `localStorage` for that origin so every tab of the app can reach the daemon. A restarted daemon has a new token; the stale one fails the status check and the HUD asks for the new link.
- `GET` requests may pass the token as `?token=` instead, because media elements and `EventSource` cannot set headers. Writes never accept it.
- The `Origin` must be a loopback origin and the `Host` header must be the daemon's own address, which blocks cross-site requests and DNS rebinding.
- All paths are resolved inside the project root; traversal, absolute paths and symlinks that leave the root are rejected.
- The daemon never executes project code.
- The standalone Studio's own files (any `GET` outside `/v1`) need no token: they hold no project data. They still need the daemon's `Host`, and carry `Content-Security-Policy: frame-ancestors 'none'` and `X-Frame-Options: DENY`, so no other page can frame the Studio. A path outside the app's folder serves the app's page, never another file.

### 11.2 API

| Method and path | Purpose |
|---|---|
| `GET /v1/status` | Version, project id, capabilities (FFmpeg and Chromium present), and the host's `devUrl` and `studioPath` from `project.json` |
| `GET /v1/events` | One server-sent-events stream for the Studio: `take` (recorded), `edit` (a take, scene or sequence changed through the daemon), `config` (the config file changed on disk), `job` (progress and outcome of any job, with the `clip` an export is for) |
| `GET /v1/config` | The validated `clipmunk.config.json` and whether it exists, or its issues |
| `GET /v1/presets`, `POST /v1/presets` | List presets with a one-line summary; save one (`{ name, preset }` or `{ name, fromTake, fields }`, `replace` to overwrite) |
| `POST /v1/takes/:id/preset`, `POST /v1/scenes/:id/preset` | Apply a preset by `{ name }` to a take's edit, or a preset's music to a scene |
| `GET /v1/takes`, `GET /v1/takes/:id` | List and read takes |
| `POST /v1/takes` | Create a take, returns its id |
| `PUT /v1/takes/:id/media/:track?seq=n` | Append an uploaded chunk |
| `PUT /v1/takes/:id/log` | Append a recorder breadcrumb to `recorder.log` |
| `POST /v1/takes/:id/finalize` | Start ingest |
| `PATCH /v1/takes/:id` | Save `edit` and `title` to `edit.json`; requires the revision hash it was read at |
| `DELETE /v1/takes/:id` | Delete a take and its media |
| `GET /v1/takes/:id/files/:name` | Serve media with range requests |
| `GET /v1/takes/:id/history`, `POST /v1/takes/:id/undo`, `POST /v1/takes/:id/redo` | Whether there is anything to undo or redo; step back or forward one edit (`{ revision }`), saved through the normal revision check. Every `PATCH` is recorded in `.clipmunk/history/<id>.json` (ignored by git, the last 50) |
| `GET /v1/preview?kind=take\|scene&id=&at=ms&variant=` | One frame of a clip as a PNG, rendered headless as export renders it |
| `GET /v1/jobs/:id` | A job's latest event, for a caller that asks rather than listens |
| `POST /v1/config/redact` | Add a redaction selector (`{ selector }`) to `clipmunk.config.json`, in whichever form the file writes `redact`, keeping everything else as it was |
| `GET /v1/takes/:id/poster` | A PNG of the screen at the take's first click, made once and cached as `poster.png` beside it |
| `GET /v1/scenes` | List validated scenes; `?detail=1` adds each recipe (definition, snapshot, music, sounds) for the Studio |
| `PUT /v1/scenes/:id/music` | Set or clear a scene's generated music in its recipe |
| `PUT /v1/scenes/:id/narration?offset=ms` | Store a narration recording and point the scene's recipe at it |
| `DELETE /v1/scenes/:id/narration` | Remove a scene's narration and its file |
| `GET /v1/audio/:file` | Serve a sound from `.clipmunk/audio`, for the preview |
| `GET /v1/sequences`, `GET /v1/sequences/:id` | List and read sequences |
| `PUT /v1/sequences/:id`, `DELETE /v1/sequences/:id` | Save (only when every clip exists) or delete a sequence |
| `POST /v1/exports` | Start an export job: `{ clip, formats?, ratios?, size?, fps?, preset?, posterAtMs? }` for several outputs (12.4a), or the single-file `{ sceneId }`, `{ takeId }` or `{ sequenceId }` |
| `GET /v1/jobs/:id/events` | Server-sent progress events |
| `DELETE /v1/jobs/:id` | Cancel a job |
| `GET /v1/takes/:id/frame?at=ms` | A still of the recording itself (the raw screen, on the recording's clock) as a PNG, cached in `.clipmunk/cache/frames` |
| `GET /v1/stale` | Every exported clip's staleness (`{ clip, stale, changes, exportedAt, outputs }`) and the banner's sentence; `GET /v1/scenes` and `GET /v1/takes` carry the same as `freshness` per clip |
| `GET /v1/chat` | The chat with the agent, and whether an agent is listening |
| `POST /v1/chat` | A developer's message, with its context chips |
| `GET /v1/chat/next?timeoutMs=&agent=` | Long poll: the next undelivered message (the agent's `wait_for_chat`) |
| `POST /v1/chat/reply` | The agent's answer, with an optional proposal (checked to apply) and follow-ups |
| `POST /v1/chat/:message/keep\|undo` | Apply a proposal through the take's history, or step back |

The daemon is a thin adapter: each route validates input with a `core` schema and calls the same operation the CLI calls.

---


### 11.3 The MCP server

`clipmunk mcp` (`src/mcp`) is a Model Context Protocol server on stdio for the developer's coding agent (`claude mcp add clipmunk -- npx clipmunk mcp`; `init` prints the lines for Claude Code, Codex and Cursor). It implements only what tools need (`initialize`, `tools/list`, `tools/call`, `ping`) as newline-delimited JSON-RPC, so it carries no SDK. It finds the running daemon through `.clipmunk/daemon.json`, and says to run `clipmunk dev` when there is none. Every tool calls a daemon route and only formats the answer:

| Tool | Daemon route | Returns |
|---|---|---|
| `list_clips` | `/v1/takes`, `/v1/scenes`, `/v1/sequences` | ids, kinds, titles and lengths, and for an out-of-date clip the changed files |
| `get_take(id)` | `/v1/takes/:id` and its log | the edit, its revision, and the log as readable lines (`summarizeEvents`: pages, clicks with role, name and selector, typing, shortcuts) |
| `get_scene(id)` | `/v1/scenes?detail=1` | the recipe and its component file |
| `edit_take(id, patch, note, revision?)` | `PATCH /v1/takes/:id` | a JSON merge patch over the edit (`mergePatch`; an object that switches its `mode` is replaced), validated and saved against the revision through the history; the changes (`diffJson`) |
| `apply_preset(id, preset)` | `POST /v1/takes\|scenes/:id/preset` | |
| `preview(id, atMs, variant?)` | `/v1/preview` | a PNG image of the frame |
| `export(id, options)`, `get_job(id)` | `POST /v1/exports`, `/v1/jobs/:id` | a job id; its progress or its outputs |
| `get_take_frames(id, times?)` | `/v1/takes/:id/frame` | PNG stills of the recording at recording times (default: each click, a second apart) |
| `check_scene(id, times?, variant?)` | `/v1/scenes?detail=1`, `/v1/preview` | the scene's issues, and frames at scene times (default: start, two thirds, end), to compare with the take's |
| `wait_for_chat(timeoutMs?)` | `GET /v1/chat/next` | the developer's next message and what it is about, or "no message yet" |
| `reply_chat(text, proposal?, followUps?)` | `POST /v1/chat/reply` | |

### 11.4 The chat

The Studio's take editor and scene player have a Chat panel for talking to the coding agent. MCP cannot push into an agent's session, so the agent waits on a blocking tool (`wait_for_chat`), which long-polls the daemon; the waiting state lives in the daemon, not in `clipmunk mcp`, which the agent's client may restart at any time. A message that reaches an agent whose call was cancelled goes back in line. The conversation is `.clipmunk/chat/messages.json` (`daemon/chat.ts`, ignored by git), so a reload or a daemon restart loses nothing; every change is a `chat` event on `/v1/events`.

Each developer message carries context chips: the clip on screen (always), a moment (the playhead, on the recording's clock for takes), or an element picked in a scene's frame. The agent answers with text, up to four follow-ups (sent with one click) and optionally a proposal: a merge patch over a take's edit, checked against the take's current edit when it is sent. A proposal changes nothing until the developer presses Keep, which saves it through the take's history (`.clipmunk/history`, as the editor's undo does), so Undo is one step back. In the take editor, Preview shows the proposed edit in place (like a preset) and the diff is against the edit on screen; the editor reads the take back after Keep or Undo. When no agent is listening, the panel shows the sentence to give it: "Watch the Clipmunk chat".

"Make a scene from this take" in the take editor sends a chat message with the take attached. The guide's "From a take" section (`guide.fromTake`, with a tested example recipe) tells the agent how: read the summary, look at `get_take_frames`, map elements to components, render them with fixture data and derive every state from scene time, copy the take's timing and zoom targets into the camera, compare with `check_scene` at matching times, say what could not be reproduced, and keep the take.

## 12. Export (`export`)

### 12.1 Scenes (DOM)

1. Launch headless Chromium through Playwright at the output size, device scale factor 1.
2. Block navigation to anything but loopback HTTP.
3. Open the scene's frame page (10.4), with its variant if any, hide `[data-clipmunk-chrome]`, wait for the bridge and `ready()`.
4. For each frame `i`: `seek(i × 1000 / fps)`, then capture the `selector` rectangle and pipe it to FFmpeg.
5. FFmpeg encodes H.264 (`yuv420p`, `+faststart`) and mixes any scene audio.

Capture uses the DevTools protocol directly (`Page.captureScreenshot` with `optimizeForSpeed`), which measured about twice as fast as Playwright's PNG screenshot at 1080p. `--draft` switches to JPEG for roughly another 25%. Because every frame is a pure function of time, `--workers N` splits the frame range across N pages, encodes one segment per page and joins the segments without re-encoding. The default is half the CPU cores, capped at four.

Headless Chromium rasterises SVG filters on the CPU where no GPU is available. On a two-core cloud VM the six-band depth filter took about 4.6 seconds per 1280x896 frame, while scenes that only need uniform blur rendered at roughly ten frames per second. On an Apple M5 with the default four workers, the same depth-filter scene exported at 4K (3086x2160, 30 fps, 210 frames) in 18.3 seconds, about 87 ms per frame, and a uniform-blur scene at 3600x2160 in 5.6 seconds for 45 frames. Scene export at 4K is therefore practical on a workstation; the slow figures above are specific to machines without a GPU.

Host CSS animations and timers run on wall-clock time and are frozen during capture. Host components that should animate with the scene read `useSceneTime()`.

### 12.2 Takes (canvas)

1. Start a private daemon for the export (it serves the take and its media) and launch headless Chromium.
2. Open the take editor in the private daemon's own Studio (10.3a), with its address in the URL fragment. There is no separate render page: export runs the same editor code as the preview, and the host app does not need to be running.
3. Call `bridge.encode({ fps, width, height })`. The page decodes, draws and encodes every frame with `VideoEncoder`, muxes with `mediabunny`, and passes file bytes to Node through a page binding.
4. FFmpeg adds the voice track and moves the index to the front. The picture is copied untouched when the browser encoded H.264; otherwise (VP9 or AV1) FFmpeg re-encodes it.

Size defaults to the edit's canvas; giving a width or height scales the other to match. Frame rate is 30 or 60.

### 12.3 Sequences

1. Read the sequence and check that every clip it names exists.
2. Render each distinct clip once, at the sequence's size and frame rate, with the ordinary scene and take exporters. A clip whose shape differs from the sequence's is fitted inside the frame.
3. Join the results in one FFmpeg filter graph: `xfade` and `acrossfade` for a fade, `concat` for a cut. A clip without sound contributes silence so every join is uniform.
4. Mix the sequence's own audio over the result and write H.264 and AAC.

Intermediate files live in a temporary directory under `.clipmunk/exports` and are removed whether the export succeeds or not.

### 12.3a Sound on scenes

A scene's `audio` clips are mixed into its export after the picture is encoded (the picture is copied, not re-encoded). A file that has gone missing does not fail the export; the result carries a warning naming it.

**Narration.** In the scene player, Narrate plays the scene from the start while recording the microphone, and stops when the scene ends. The daemon stores the recording as 48 kHz mono WAV in `.clipmunk/audio`, named `<scene>-narration-<timestamp>.wav`, and rewrites the recipe's `audio` to point at it with the measured offset between the microphone starting and playback starting. A new narration replaces the previous one and deletes its file; other sounds on the scene are kept.

### 12.3b Generated music

Background music is synthesized by `renderMusic` in `core/music.ts`: a pure TypeScript function from `{ style, seed, durationMs, accentsMs }` to stereo samples. It uses no recordings, samples or third-party tracks, so the result carries nobody else's rights; that is the reason it exists, and the reason no music is bundled.

- **How it is made.** A seeded random generator picks a key and one of a few chord progressions for the style. Voices are computed sample by sample: detuned chord pads through a low-pass, a bass line, a pitch-swept kick, noise-based snare and hats, and a plucked melody drawn from the chord with echoes. Lo-fi adds swing, tape hiss and crackle.
- **Stable by construction.** The mix goes through a fixed gain per style and a soft clipper, never a gain measured from the audio. So a longer clip starts with exactly the same music as a shorter one, and adding an accent cannot change how loud the rest is. Each style is set to a similar loudness (about 0.15 RMS, peaks under 0.8).
- **Fitted to the clip.** It is rendered to the clip's exact length with a fade in and a fade out, so there is no looping. A sequence passes the time of each join as an accent: a short swell into a low thump.
- **Synced to the picture.** `core/moments.ts` finds a clip's key moments: in a scene, when each surface finishes arriving (the last keyframe of any track that moves or fades it; camera and focus travel are ignored); in a take, the first click of each burst of activity, on the trimmed clock; in a sequence, each join. With `sync` on, `fitTempo` picks a tempo within 8% of the style's own, and a starting point inside the first beat, that puts beats, or the points halfway between beats, on those moments. Each moment also gets an accent placed exactly on it (softer in scenes and takes than at a sequence's joins). Because the tempo may only move 8%, several unrelated moments cannot always land on the rhythm exactly; `fitTempo` reports the average miss, and the accents are exact regardless. A test renders a fitted tune with accents off and checks the kick drum lands on every moment when a tempo in range can reach them. `planMusic` wraps all of this and is the one function both the studio and the exporter call.
- **Same in preview and export.** The studio renders the same function into an `AudioBuffer` and starts it at the clock's position; the exporter writes it to a WAV for FFmpeg. Ducking under a voice (`sidechaincompress`) happens at export only, so the preview plays the music at its full level.

`clipmunk music <style>` writes a sample WAV for listening to a style.

### 12.4 Output rules

These rules live in one place, `export/output.ts`, and the scene, take and sequence exporters all use it: `claimOutput` picks a path that overwrites nothing, `workDirectory` makes the scratch folder beside it, `publish` links the result into place, and `cancellation` turns an abort signal into a `check()` and a list of things to stop.

Outputs are project-relative paths (`.mp4`, and `.gif` and `.png` from jobs). Existing files are never overwritten. Work happens in a temporary directory next to the target and the result is linked into place only on success. Cancellation (signal or job delete) kills the encoder and the browser and publishes nothing.

### 12.4a Jobs with several outputs

`exportJob` in `export/job.ts` takes `{ clip: { kind, id }, formats, ratios?, size?, fps?, preset?, posterAtMs?, gifMaxBytes? }` and makes one file per format in each ratio, named `<clip>[.<ratio>].<ext>` in `.clipmunk/exports/` (`9:16` is written `9x16`), with `-2`, `-3` added rather than overwriting.

- **One render per ratio.** The MP4 of each ratio is rendered by the ordinary exporter; a ratio reframes a take (9.9) through the page bridge, which renders a reframed copy and puts the take back. Ratios are for takes; scenes get theirs as variants.
- **GIF.** FFmpeg `palettegen` and `paletteuse` from the MP4, 15 fps with 720 pixels on the short side. Over the limit (5 MB by default), the frame rate steps down to 12, 10 and 8, then the size to 540, 480, 360, 270 and 180, and the result says what was chosen.
- **Poster.** A PNG of the MP4 at `posterAtMs`, or by default at a take's first click (after pacing), a scene's first key moment, or a sequence's start.
- **Presets.** `preset` names one in the config whose `export` options (`size`, `fps`, `formats`, `ratios`) fill in what the job leaves out.
- **All or nothing.** Everything is made in one work directory and published only when every output is ready, so a failed or cancelled job publishes nothing. Progress counts every step of every output; cancelling stops the browser and any running FFmpeg.

The CLI runs a job when `--format`, `--ratio` or `--preset` is given; `POST /v1/exports` runs one when the body names a `clip`, and the single-file shapes still work.

### 12.5 Snapshots

`clipmunk snapshot --scene <id>` seeks one frame (default the midpoint) at `full` quality, captures a 320-pixel-wide PNG and writes it into the recipe if the recipe has not changed since it was read.

### 12.6 Sources and the export manifest

Every export records which source files the clip was made from, so a later check can say which videos are out of date. `.clipmunk/manifest.json` (committed; `project/manifest.ts`) holds, per clip (`scene:<id>`, `take:<id>`, `sequence:<id>`), `{ files: { path: sha256 }, exportedAt, outputs }`. It is written once per export: by the scene, take or sequence exporter when called on its own, and by a job (12.4a) for all its outputs, while the renders inside a job or a sequence pass `manifest: false`. A manifest that cannot be written never fails the export.

- **Scenes:** the recipe and the import graph of its component (`project/imports.ts`). The scanner removes comments, reads static `import`s (not `import type`), side-effect imports and `export … from` at statement starts, and resolves them like a bundler: relative paths with extensions and index files (and `./x.js` naming `./x.ts`), then `compilerOptions.paths` and `baseUrl` from tsconfig.json or jsconfig.json (JSON with comments, following relative `extends`). Packages and `node_modules` are not followed; styles and other assets are included but not read. It never runs code.
- **Takes:** the take's `edit.json`, plus the import graph of every file its log names as an element's `src`. In development `clipmunk/vite` (a `serve`-only, `enforce: "post"` plugin) and `clipmunk/next` (a webpack `enforce: "post"` loader, dev only) run `tagSources` (`core/source.ts`) on each compiled project module: every `jsxDEV("tag", {…})`, `jsx`/`jsxs` or `createElement` call for a lowercase host tag gets `"data-clipmunk-src": "<file>"`, so components and production builds are untouched. The recorder's `identify` reads the nearest mark into `el.src`. Next 16's default dev server, Turbopack, is not covered (use `next dev --webpack`); a take recorded without marks has only its edit in the manifest.
- **Sequences:** the sequence file and its clips' files.

### 12.7 Stale clips

A clip is out of date when a file its last export recorded hashes differently now, or is gone (`compareSources` in `core/manifest.ts`, `clipFreshness` in `project/stale.ts`). Each change names the last commit that touched the file, unless the change is not committed yet. `clipmunk stale` lists them; with `--base <ref>` each recorded file is compared with that ref's copy (`git show <ref>:./<file>`) instead, so CI can ask what a pull request changed whatever the age of the manifest, and the commits are those since the ref. `describeStale` writes the one sentence the Studio and the PR comment use: "2 clips are out of date. `<PlanCards />` and `<UsageChart />` changed in a3f9c1." (a PascalCase component file is shown as its component).

The daemon keeps the answer current (`daemon/freshness.ts`): once a second it stats the manifest and every file it lists, recomputes when one moved and emits a `stale` event when a clip's staleness changed. Polling a few dozen files is cheaper than a recursive watch of the project (which would include `node_modules`) and survives editors that replace files. The Studio library shows the sentence as a banner, an "Out of date" badge and the changed files on each stale card, "Re-export" for a stale scene or sequence (a job in the formats it was last exported in) and "Record again" for a stale take, which opens the app with the recorder ready. `list_clips` tells the agent the same.

---

## 13. Project setup (`project`)

`clipmunk init` detects the host and connects it. It is idempotent.

| Host | What `init` does |
|---|---|
| Vite + React | Generates `src/clipmunk/Studio.tsx` (the frame page, the hand-off to the Studio and the recorder boot) with a lazy `import.meta.glob` of the scenes directory. Wraps the root render in the entry file when it matches the standard `createRoot(...).render(...)` form; otherwise prints the one-line wiring instruction. |
| Next.js App or Pages Router | Adds a development-only `/clipmunk` route that loads the frame page (or the hand-off to the Studio) with SSR disabled. Does not touch layouts or config. Generates `src/clipmunk/Recorder.tsx` and prints the one line that adds `<ClipmunkRecorder />` to the root layout; `init` reports the recorder as connected once that line is present. |
| Any other React DOM host | Generates the wrapper and a static scene catalog (`src/clipmunk/catalog.ts`); prints wiring instructions. `clipmunk sync` regenerates the catalog after scene files are added or removed. |

Entry-file edits are made by a small dependency-free scanner (`project/entry.ts`) that finds the single `.render(...)` call and wraps its JSX argument. It declines anything it cannot read with certainty (several render calls, a non-JSX argument, unbalanced text) and `init` then prints the instruction instead. The TypeScript compiler API is not used: TypeScript 7 no longer ships one, and JavaScript hosts have no TypeScript at all. Every `init` step is idempotent, so re-running it completes an interrupted run; there is no journal.

`init` also writes `CLIPMUNK.md` (a short pointer to `clipmunk guide`), `.clipmunk/project.json` and `.clipmunk/.gitignore`. When the project has no `clipmunk.config.json` it writes a starter one; that file belongs to the developer from the start, so it is never recorded as generated and never rewritten. `clipmunk dev` keeps the generated `.clipmunk/.gitignore` current in older projects when it is unedited (`refreshStateFiles`).

### Agent handoff

`clipmunk guide --json` prints the authoring guide for the installed version: concepts (camera, focus, parallax, timing, composition), the schema defaults, the animatable properties per target, a tested scene file pair, the commands and the workflow. Defaults, property lists and the example are derived from the schemas in `core/guide.ts`, so the guide cannot drift from what the validator accepts. `clipmunk guide` prints it as prose; `--json` prints the structured form.

---

## 14. CLI (`cli`)

| Command | Purpose |
|---|---|
| `clipmunk init [--adapter vite\|next\|react]` | Connect the host app |
| `clipmunk mcp` | Serve Clipmunk's tools to a coding agent over MCP on stdio (11.3) |
| `clipmunk dev [--port]` | Start the daemon and print the Studio link, and the link that connects the app for recording |
| `clipmunk guide [--json]` | Print the agent authoring guide |
| `clipmunk scenes [--json]` | List validated scenes |
| `clipmunk takes [--json]` | List takes |
| `clipmunk stale [--base <ref>] [--json]` | List exported clips whose sources changed since their export, or since a git ref (12.7) |
| `clipmunk sync` | Regenerate the static scene catalog |
| `clipmunk open [--scene id \| --take id] --url <origin>` | Open the studio in the browser |
| `clipmunk snapshot --scene id --url <origin> [--time ms]` | Save a thumbnail into the recipe |
| `clipmunk zoom <take> [--write]` | List a take's zoom segments, or store them as manual keyframes |
| `clipmunk preset list \| apply <name> --take id \| --scene id \| save <name> --take id --fields <parts> [--title] [--replace]` | List, apply or save presets in `clipmunk.config.json` |
| `clipmunk sequences [--json]` | List sequences and their validation issues |
| `clipmunk music <style> [--seed] [--seconds] [--output]` | Write a WAV sample of the generated music |
| `clipmunk export --scene id \| --take id \| --sequence id [--fps] [--size] [--output] [--draft] [--workers]` | Render an MP4. A sequence takes its size and frame rate from its file. |
| `clipmunk doctor` | Check Node, FFmpeg, Chromium, the project connection and `clipmunk.config.json` (including a logo file that is missing) |

Every command accepts `--json` and then prints only the operation result. Human output is a separate formatter over the same result.

Each command is one small function: project and listing commands in `cli/commands.ts`, rendering commands in `cli/render-commands.ts`. `cli/run.ts` only parses the arguments and looks the command up in a table; `cli/invocation.ts` defines what a command receives, including the single `print` that serves both output modes.

---

## 15. Testing

| Layer | Tooling | What is proven |
|---|---|---|
| `core` | Vitest, no DOM | Schemas, easing, matrices, focus maths, auto-zoom, cursor smoothing, guide example validity |
| `react`, `studio` | Vitest + jsdom | Registration, diagnostics, session behaviour, recovery |
| Renderer pixels | Playwright | Real-browser focus (equal depth is equally sharp, tilt produces a gradient), transforms, cover framing |
| Export | Playwright + FFmpeg | Frame count, duration and cadence of real MP4s; no-overwrite; cancellation |
| Recorder | Headed Chromium with `--auto-accept-this-tab-capture` | HUD excluded, cursor-free capture, event log shape, video-to-event sync, keyboard stop, reload recovery, chunk upload and ingest, and a real take edited and exported |
| Takes | Playwright + FFmpeg on a synthetic take with known pixels | Layout, zoom, cursor and camera pixels; editor controls and saving; trim; exported MP4 frames, size and voice track |
| Sequences and narration | Playwright + FFmpeg on the example app | Narration stored, replaced, removed and recorded through the studio; a scene and a take joined by fade and by cut, checked for length, frames, sound and the mixed picture mid-fade; the sequence builder saving a valid file |
| Generated music | Vitest for the synthesizer; Playwright + FFmpeg for its use | Exact length, no clipping, determinism, fades, accents and WAV encoding; music audible in scene, take and sequence exports; controls saving to scene, take and sequence files. Nothing tests how it sounds. |
| Installed package | Packed tarball in a temporary Vite, Next and plain React host | `init` idempotency, studio loads, production build contains no Clipmunk code |
| Boundaries | `scripts/check-boundaries.mjs` | Import rules in section 3 |

`examples/vite-app` is the development host. It is not published.

---

## 16. Build and release

- TypeScript strict, ES modules only.
- Biome formats and lints everything (`npm run lint`, `npm run format`; line width 120). `npm run verify` runs the linter, the import-boundary check, the type checker and the unit tests. One rule is off, `noNonNullAssertion`, because strict indexed access makes `!` the normal way to say an index is known to be in range; every other exception is a `biome-ignore` comment that states its reason.
- `scripts/build.mjs` uses Vite's library mode. The browser entry points (`.`, `./core`, `./studio`) are built in one pass so they share a single copy of the scene context; the CLI is a second, Node-targeted build. `tsc -p tsconfig.build.json` emits declarations. The recorder is a fourth browser entry point (`./recorder`). `mediabunny` stays external, so the host's bundler resolves the one installed copy.
- `package.json` `files` allow-lists `dist/`. `sideEffects` is false except for the CLI entry, so unused browser code tree-shakes.
- Releases are published from a clean, verified checkout. Versions are immutable.

---

## 17. Build order

Each phase ends with something that runs and is tested.

| Phase | Delivers | Done when |
|---|---|---|
| 0. Spikes | Risk answers | **Complete.** Results are recorded in this document. |
| 1. Core and scene renderer | `core` schemas, motion, spatial and focus maths; `Scene`, `Surface`; `ScenePreview` with play and scrub; `examples/vite-app` | **Complete.** |
| 2. Flute parity | `init` and adapters, scene discovery and library, guide and `CLIPMUNK.md`, capture bridge, scene export, snapshots | **Complete.** `scripts/check-installed.mjs` goes from `init` to an exported MP4 in a fresh Vite app and a fresh Next.js app. |
| 3. Daemon and recorder | Daemon, take storage, HUD, capture, event log, ingest | **Complete.** `tests/recorder` records the example app in headed Chromium and validates the take on disk. |
| 4. Take compositor | Frame sources, zoom, cursor, camera bubble, take editor, take export with audio | **Complete.** `tests/take` checks the composite pixel by pixel on a synthetic take and exports it; `tests/recorder` edits and exports a real recording. |
| 5. Sequences and voiceover | Sequence schema and export, narration over scenes | **Complete.** `tests/sequence` narrates a scene through the studio, and exports a scene plus a take as one file with a fade, with a cut, and with music over the whole. |
| 6. Release | Installed-package tests, docs, publish | `clipmunk` installs and works from the registry |
| 7. Studio and the next feature set | Standalone Studio, edit sidecars, `clipmunk.config.json` and presets, redaction, captions, reframing, GIF and poster, scene variants, MCP and agent chat, take to scene, stale detection, GitHub Action | Planned. Direction in section 19; the PR-by-PR plan and its progress log are in `studio_implementation.md`. |

---

## 18. Known limits and open questions

- **Chromium only for recording and export.** Scenes preview in any modern browser.
- **Own tab only.** No desktop capture, no other windows, no system audio. Tab audio can be added later through the same capture call.
- **Depth of field is an approximation.** Gaussian kernels in the DOM; no aperture-shaped bokeh and no occlusion between surfaces.
- **Not yet verified:** recording on macOS end to end (the recorder is tested on Linux under a virtual display, where the latency measurement returns a value but no real cursor exists); playback smoothness of a retina-resolution take in the editor on a real machine (decoding is verified, speed is not); how voice and picture line up by ear in a real export; `restrictTo` on `body` in macOS Chrome (verified on Linux only); H.264 `VideoEncoder` availability in Playwright's Chromium on macOS (12.2 has the VP9 fallback). Each is checked at the start of its phase.
- **Deferred:** a virtual-time export mode that advances host CSS animations and timers frame by frame; a visual keyframe editor for scenes; background blur for the camera.
- **Not planned:** replaying a take by re-driving the live app (section 19.2). Revisit only with evidence of flows that cannot reasonably be written as a scene.
- **Out of scope:** hosted rendering, accounts, a drag-and-drop builder, React Native.

---

## 19. Direction: the Studio and the next feature set

Agreed on 2026-10-25 from the "Clipmunk Studio" build spec. This section records the decisions; the sections above still describe the code as it is, and each one is rewritten by the PR that changes it. The ordered plan, and a log of what is done, lives in `studio_implementation.md`.

The rules in section 1 still hold, and the spec adds none that conflict: everything binds to `127.0.0.1`, there are no accounts, uploads or telemetry, Clipmunk never calls a model, all state is files in the repo, nothing ships in a production build, and a raw recording is never rewritten.

### 19.1 The Studio moves out of the host app

Done: the frame page is in 10.4 and the standalone Studio in 10.3a; the app keeps only the frame page, the hand-off at `?clipmunk=1` and the recorder.

The Studio becomes its own prebuilt web app, served by the daemon at `http://127.0.0.1:4747/` (the daemon's existing default port). It no longer runs inside the host's React tree.

- **Scenes** still render in the host app, because only the host can run its components. The Studio shows them in an iframe of a dev-only **frame page** on the host's dev server (`?clipmunk-frame=…`), which renders just the scene, installs the capture bridge and listens for messages from the Studio: seek (latest position wins, stale seeks are dropped), play and pause (the frame runs its own clock and reports time), pick an element, and choose a variant. Export opens the same frame page, so preview and export still cannot disagree.
- **Takes** need nothing from the host: the compositor draws on the Studio's own canvas from media the daemon serves. So a take can be edited, and exported, while the host app is not running.
- **What stays in the host:** the generated adapter (now thinner: the frame page and the recorder boot) and the recorder HUD, since recording captures the app's own tab.
- **Why:** the Studio stops depending on the host's React version, bundler and global quirks, keeps working when the host is broken, and can show the same scene in several real viewports side by side (9:16 next to 16:9, light next to dark), which the in-app Studio cannot.
- **Evidence:** a spike (branch `spike/studio`, `spikes/studio/README.md`) showed the iframe preview pixel-identical to the in-app page at four times on a light and a depth-blur scene; the unmodified take editor running on another origin; export, hot reload and a cross-origin element picker working; and microphone, camera and autoplay allowed in the frame. On an Apple M5 at device pixel ratio 2, the depth-blur scene scrubbed in a median 8.3 ms per seek both in-app and in the iframe, played at 120 fps both ways, and two side-by-side iframes held 120 fps each. Every figure sat at the 120 Hz display cap, so sharing a saturated GPU was not reached; if it ever matters, only the focused frame plays and the others hold their frame.
- The API stays REST under `/v1` with server-sent events for anything pushed to the Studio. A WebSocket is added only if a feature needs it.

### 19.2 Takes stay recordings; there is no replay

A take remains what it is today: screen video plus an event log, edited by compositing on top. Re-driving the live app from a log ("replay") is not built.

- **Why:** a recording works on any app as it is (real backend, auth, websockets, canvas, third-party widgets). Replay works only on an app made deterministic with a frozen clock and fixtures, and it fails quietly when it goes off course. Almost every feature in the spec works on recordings.
- **Scenes are the always-fresh clip.** A scene re-renders the host's real components from code at export time, so it shows today's UI, can come in variants, and is safe to re-export in CI. A scene shows a flow by deriving every state from scene time (a puppet), not by running the app's logic.
- **Consequences for the spec:** theme and locale variants are a scene feature. A take gets aspect-ratio variants only, by reframing (a crop that follows the action). Stale detection re-exports stale scenes and flags stale takes to be recorded again. The spec's frozen clock and fixtures are dropped, because only replay needed them; scenes are deterministic through the scene clock.
- **Take to scene.** The bridge between the two kinds: the developer's agent reads a take (its event summary and still frames from the video) and writes a scene that reproduces it, then checks its preview against the take's frames. Clipmunk provides the tools and the guide; the agent does the writing.

### 19.3 Configuration is JSON

The file, its schema, the brand, redaction, presets and variants are in section 5.5b; export jobs use presets' export options (12.4a) and scene variants (6.5).

### 19.4 Edits live beside the recording

Done: section 5.3 describes the two files.

### 19.5 The event log learns what was touched

Done: section 5.4 describes the element identity, the new kinds and the privacy rules. Captions, redaction, take to scene and stale detection build on it. `el.src` (the source file of the element) is added with the source map.

### 19.6 The agent works through MCP

`clipmunk mcp` is a stdio MCP server that the developer's agent (Claude Code, Cursor, Codex) connects to. It proxies tool calls to the daemon: list and read clips, edit a take with a JSON merge patch, apply a preset, render a preview frame, export. Agent chat in the Studio is a queue in the daemon: the panel posts messages, the agent waits on a blocking tool call for the next one, and proposed edits come back as a diff the developer keeps or undoes. MCP cannot push into an agent session, so chat works while the agent is waiting on that call; the guide tells it how.

### 19.7 Stale detection and the GitHub Action

Each export records the source files its clip depends on, with content hashes, in `.clipmunk/manifest.json`. For a scene, the files come from the import graph of its component, found by scanning imports, not by running code. For a take, a dev-only build plugin tags rendered elements with their source file and the recorder logs it. A clip is stale when a recorded file's content has changed. The GitHub Action checks a pull request for stale clips, re-exports the stale scenes, and comments with what changed. GitHub's API cannot attach a video to a comment, so how the files reach the comment is decided in that PR.

