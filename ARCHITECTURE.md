# Flick architecture

Flick is a TypeScript SDK that a developer installs into their own web app. It does two things:

1. **Scenes.** It turns the app's real React components into cinematic 3D shots (camera, depth of field, keyframed motion), authored as source files by the developer's coding agent. This is feature parity with [Flute](https://github.com/webprodigies-org/flute) (MIT), which Flick is modelled on.
2. **Takes.** It records the developer using their own app in a browser tab, then renders the recording with a smoothed synthetic cursor, automatic zooms, a camera bubble and voiceover.

Both produce MP4 files locally. There is no account, no hosted service and no AI integration inside Flick; the developer's own coding agent reads a guide and edits source files.

This document is the implementation map. If code and this document disagree, one of them is a bug.

- npm package: `@flickjs/record`
- CLI binary: `flick` (`npx flick …` after install; first run is `npx @flickjs/record init`, because the unscoped `flick` package on npm belongs to someone else)
- Runtime: Node 22.12+ for the CLI, React DOM 18.2+ or 19 for scenes, Chromium for recording and export

---

## 1. Principles

These are the rules every module follows. They exist so that preview and export can never disagree.

1. **One explicit clock.** Nothing in Flick reads wall-clock time to decide what a frame looks like. Every renderer is a function of `(definition, timeMs)`. Playback, scrubbing, thumbnails and export all call the same `seek(timeMs)`.
2. **The source of truth is files in the host repo.** Scenes, take edits and sequences are JSON validated by Zod schemas in `core`. The studio UI and the coding agent edit the same files. There is no database.
3. **Core is pure.** `core` has no DOM, no Node and no React imports. All maths (camera, focus, easing, auto-zoom, cursor smoothing) lives there and is unit-tested without a browser.
4. **Effects live at the edge.** Filesystem, processes and network are touched only by `daemon`, `export` and `project` service modules. Policy (validation, scoping, idempotency) lives in operations that call those services.
5. **The host app is not redesigned.** Scenes mount the host's real components with their providers and styles. Flick never clones UI, never resets host CSS, and ships nothing into production builds.
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
| **Capture bridge** | The object a page exposes on `window.__FLICK__` so the exporter can drive it frame by frame. |

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
  bridge/       The window.__FLICK__ contract and its browser implementation helpers.
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
| `@flickjs/record` | `Scene`, `Surface`, `useSceneTime`, core types and helpers | Browser |
| `@flickjs/record/core` | Everything in `core` | Any |
| `@flickjs/record/studio` | `FlickStudio`, `ScenePreview` | Browser, dev only |
| `@flickjs/record/recorder` | `createRecorder`, `mountRecorderHud` | Browser, dev only |
| `flick` binary | CLI | Node |

Dependencies: `zod`, `mediabunny`. Peer: `react`, `react-dom` (>=18.2 <20). Optional peer: `playwright` (export, snapshots). System prerequisite for export: FFmpeg on `PATH` (or its location in `FLICK_FFMPEG`). `mediabunny` is added with the take compositor in Phase 4.

---

## 4. Files in the host app

```
FLICK.md                              Agent handoff. Points at `flick guide`.
src/flick/Studio.tsx                  Generated adapter. Dev-only wrapper around the host app.
src/flick/catalog.ts                  Generated scene catalog (Next.js and generic React hosts only).
src/flick/scenes/<id>.scene.json      Scene recipe (committed).
src/flick/scenes/<id>.tsx             Scene component, default export (committed).
src/flick/sequences/<id>.sequence.json  Sequence (committed).
.flick/project.json                   Project identity and the ownership record of generated files.
.flick/.gitignore                     Ignores media, caches, exports and daemon state.
.flick/takes/<id>/take.json           Take manifest and edit (committed).
.flick/takes/<id>/screen.webm         Screen recording (ignored).
.flick/takes/<id>/cam.webm            Camera + microphone (ignored).
.flick/takes/<id>/events.jsonl        Pointer and interaction log (ignored).
.flick/audio/<file>                   Voiceover recordings (ignored).
.flick/exports/                       Default output directory (ignored).
.flick/daemon.json                    Port, pid and session token of a running daemon (ignored).
```

Scene ids and take ids are lowercase slugs (`[a-z0-9]+(-[a-z0-9]+)*`). A scene's id equals its file name and its recipe's `id` field.

Every generated file is recorded in `.flick/project.json` with a content hash. `init` and `sync` only overwrite a file whose current hash matches the record; an edited or unrelated file produces a repair message and no write.

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
  audio?: { file: string; offsetMs: number; gain: number }[];       // voiceover, files under .flick/audio
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
    zoom:   { mode: "auto"; params: AutoZoomParams } | { mode: "manual"; tracks: Track[] } | { mode: "off" };
    cursor: { visible: boolean; size: number; smoothing: number; clickEffect: "ripple" | "none"; hideWhenIdleMs?: number };
    cam:    { visible: boolean; shape: "circle" | "rounded"; corner: "tl" | "tr" | "bl" | "br"; size: number; mirror: boolean; tracks?: Track[] };
    audio:  { muted: boolean; gain: number; normalize: boolean };
  };
};
```

All `source` times are milliseconds on the take clock, which starts when the screen recorder starts. `offsetMs` shifts a media file onto that clock.

### 5.4 Event log

`events.jsonl` has one JSON object per line. `t` is milliseconds on the take clock. Coordinates are CSS pixels relative to the capture root.

| `k` | Fields | Notes |
|---|---|---|
| `move` | `x y` | Coalesced to one per animation frame |
| `down`, `up` | `x y button rect` | `rect` is the bounding box of the interacted element |
| `cursor` | `style` | `default`, `pointer` or `text`, from the computed cursor under the pointer |
| `scroll` | `x y` | Page scroll offset |
| `focus` | `rect editable` | Focused element box; `editable` marks text inputs |
| `type` | `rect` | A keystroke happened in this element. **The key is not recorded.** |
| `resize` | `width height` | Capture root size changed |

The log never contains typed text, element text or attribute values.

### 5.5 Sequence

```ts
type Sequence = {
  version: 1; id: string; title: string; width: number; height: number; fps: 30 | 60;
  items: { clip: { kind: "scene" | "take"; id: string }; trim?: { startMs: number; endMs: number };
           transition?: { kind: "cut" | "fade"; ms: number } }[];
  audio?: { file: string; offsetMs: number; gain: number }[];
};
```

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
- `quality="auto"` (studio default): starts at `preview`; if the measured frame time stays over budget for half a second, varying surfaces fall back to a single uniform blur sampled at the surface centre until playback pauses. Pausing always re-renders the current frame at `full`.

### 6.3 React binding

- `Scene` creates a **registry** and a **clock store**. It renders a flat backdrop element with CSS `perspective` and, inside it, a `preserve-3d` stage carrying the camera transform.
- `Surface` registers `{ id, parent, element, transform }` with the registry in a layout effect. The registry measures untransformed layout (`offsetWidth`, the `offsetParent` chain, minus scroll) and reports each surface's size and its centre offset from its parent's centre. A `ResizeObserver` and a `MutationObserver` keep measurements fresh.
- A Surface with nested Surfaces is a **group**. Groups keep `preserve-3d` and are never filtered, because a filter would flatten their children. A group's own paint goes in its `content` prop, which renders as a filtered leaf. The registry reports visible text or media sitting directly in a group as a diagnostic, and capture refuses a scene with diagnostics.
- Spatial wrappers ignore pointer events; visual leaves receive them, so the live UI stays interactive in preview.

**Frames do not go through React.** This is a deliberate departure from Flute, which re-renders the tree from state on every frame. In Flick, the clock store holds `timeMs`. On each tick the Scene evaluates motion and spatial maths once and writes `style.transform`, `style.opacity`, `style.filter` and the filter table attributes directly on the registered elements. React re-renders only when the definition, the registered structure or measurements change. Components that want scene time opt in with `useSceneTime()`, which subscribes through `useSyncExternalStore`; `seek()` wraps the update in `flushSync` so those components are committed before the frame is captured.

### 6.4 Diagnostics and recovery

- Invalid recipe JSON keeps the last valid definition on screen and lists the issues.
- A component that throws is caught by an error boundary with a retry action; fixing the source and saving recovers through the host's hot reload.
- The scene root carries `data-flick-valid="true|false"`. The capture bridge rejects `seek` while it is false.

---

## 7. Capture bridge (`bridge`)

Any page that can be exported exposes exactly one bridge:

```ts
interface FlickBridge {
  version: 1;
  kind: "scene" | "take";
  durationMs: number;
  width: number; height: number;          // authored frame size
  selector: string;                        // the element to screenshot, for DOM clips
  ready(): Promise<void>;                  // fonts, images, media metadata loaded
  seek(timeMs: number): Promise<void>;     // resolves when that frame is fully applied
  encode?(job: EncodeJob): AsyncIterable<EncodedChunk>;   // canvas clips: render and encode in-page
}
```

- Scenes implement `seek` and are captured by screenshot.
- Takes implement `encode`, because their frames are already on a canvas and in-page encoding measured roughly ten times faster than screenshots.
- Studio chrome is marked `data-flick-chrome` and hidden by the exporter in its own private page only.

---

## 8. Recorder (`recorder`)

Runs in the developer's own tab, in Chromium. Verified in spikes on Chromium 153 (Linux and macOS).

### 8.1 Capture

1. **Root.** The capture root is `document.body`, so modals and toasts portalled to `body` are recorded. The recorder HUD is a custom element appended to `<html>`, outside `body`.
2. **Screen.** `getDisplayMedia({ preferCurrentTab: true })`, then `track.restrictTo(RestrictionTarget.fromElement(body))`. This excludes the HUD. It requires `isolation: isolate` on `body` for the duration of the recording.
3. **Background shim.** A page background set on `html` or `body` is painted on the canvas, not inside `body`, so it is missing from a restricted capture. While recording, the recorder inserts a fixed, full-viewport element at the lowest z-index inside `body` carrying the computed page background, and also stores that colour in `source.background`.
4. **Cursor.** Chrome draws the native cursor into tab capture and has no capture option to turn it off. The recorder applies `cursor: none !important` to everything in `body` while recording, and the HUD draws a stand-in cursor on `<html>` so the developer can still see where they point. The recording is cursor-free.
5. **Camera and microphone.** One `getUserMedia` stream recorded by one `MediaRecorder`, so picture and voice stay in sync. If the camera is off, the microphone is recorded alone.
6. **Events.** Listeners on `window` in the capture phase write the event log (5.4).

### 8.2 Clocks

The take clock is `performance.now()` minus the moment the screen `MediaRecorder` fires `start`. Camera and microphone store their own start offset on that clock.

Screen frames arrive later than the DOM paints. At the start of a recording the recorder flashes a small sync marker inside `body` and watches the captured stream (a hidden `<video>` plus `requestVideoFrameCallback`) for the frame where it appears. The measured delay is stored as `source.screen.latencyMs` and applied when the compositor maps event time to video time.

### 8.3 Storage

Each `MediaRecorder` emits a chunk every second. The recorder uploads chunks to the daemon as they arrive (`PUT …/media/<track>?seq=n`), so a crashed tab loses at most a second. The event log is uploaded in batches the same way. `finalize` triggers ingest.

Without a daemon the HUD refuses to start and shows the command to run. Recording into browser downloads is not supported.

### 8.4 Ingest (daemon)

Raw `MediaRecorder` files have no duration or seek index. Ingest runs `ffmpeg -c copy` to remux each file (fast, lossless), probes dimensions and duration, extracts microphone audio to 48 kHz WAV, and writes `take.json` with a default `edit`. Tab capture has a variable frame rate by nature (it emits frames only when the page repaints); the compositor looks frames up by time, so no re-encode is needed.

---

## 9. Take compositor (`compositor`, `core/autozoom`, `core/cursor`)

A canvas renderer: `renderTake(ctx, take, derived, frames, timeMs)`.

### 9.1 Frame sources

`mediabunny` demuxes and decodes screen and camera video with WebCodecs. A frame is fetched by timestamp. Spikes confirmed exact frames for VP9 and H.264 in headless Chromium (120 of 120, random order). Preview and export use the same decoder path, so they match.

### 9.2 Layers, bottom to top

1. Canvas background (`edit.canvas.background`).
2. Screen frame over `source.background`, inset by `padding`, with rounded corners and a shadow, transformed by the zoom at `timeMs`.
3. Click effects, in screen space.
4. Synthetic cursor, in screen space, so it zooms with the content.
5. Camera bubble, in canvas space.

### 9.3 Auto-zoom

`generateZoomTracks(events, source, params)` in `core/autozoom.ts` is pure and deterministic:

1. **Activity.** Collect clicks, drags and typing bursts with their element rectangles. Hovering and scrolling are not activity.
2. **Segments.** Merge activity closer together than `mergeGapMs` (default 2500) into one zoom segment.
3. **Target.** For each segment, take the padded union of its element rectangles. Scale is `clamp(fit × fill, minScale, maxScale)` (defaults 1.25 and 2.2). The centre is clamped so the zoomed view never leaves the screen recording.
4. **Follow.** Inside a segment, when the cursor leaves the inner safe area of the current view, add a pan to re-centre on it.
5. **Timing.** Ease in over `easeMs` (default 700), finishing `leadMs` (default 300) before the first activity. Hold `holdMs` (default 1500) after the last activity, then ease out.

The output is three ordinary tracks on `{ kind: "zoom" }`. `edit.zoom.mode = "auto"` regenerates them on load from `params`; `flick zoom <take> --write` converts them to `manual` tracks in `take.json` for hand editing.

### 9.4 Cursor

`smoothCursor(events, smoothing)` in `core/cursor.ts` resamples `move` events to a fixed rate and applies a zero-phase smoothing filter, producing a path that is a pure function of the log. Clicks pin the path to the exact click position so the cursor never appears to miss its target. The cursor shape follows `cursor` events (arrow, hand, text beam), drawn from vector paths at any size.

### 9.5 Audio

Audio is never handled in the page. The exporter passes offsets, trim, gain and the normalize flag to FFmpeg, which mixes the microphone track and any voiceover files into the final MP4.

---

## 10. Studio (`studio`)

The studio runs inside the host app's dev server, in the host's React tree, so scenes get the host's providers. All studio UI renders in a shadow root so host CSS cannot leak in and studio CSS cannot leak out.

### 10.1 Mounting

`init` generates `src/flick/Studio.tsx`, which exports `FlickStudioHost`. The host wraps its app with it once:

```tsx
<ExistingProviders>
  <FlickStudioHost>
    <ExistingApp />
  </FlickStudioHost>
</ExistingProviders>
```

- Without `?flick` in the URL the wrapper returns `children` and imports nothing, so the app is unaffected.
- `?flick=1` renders the studio instead of the app. `&flick-scene=<id>` opens a scene (`&flick-take=<id>` will open a take). Navigation is by plain links, so back, forward and reload resolve the same URL.
- The wrapper lazy-loads `FlickStudio` from `@flickjs/record/studio` behind the bundler's compile-time development condition (`import.meta.env.DEV` or `process.env.NODE_ENV`), so a production build contains no Flick code. The installed-package check greps the production output to prove it.
- `FlickStudio` receives `scenes`: a map from module path to lazy loader for every recipe and component. It loads the recipes to build the library and loads a component only when its scene is opened.
- In Next.js the studio is a development-only route (`/flick`) instead of a wrapper.

### 10.2 Views

| View | What it does |
|---|---|
| **Library** | Grid of scenes (cached snapshot thumbnails) and takes. Shows validation issues per item. |
| **Scene player** | The authored frame fitted inside the viewport and clipped to its edges, so the preview shows exactly what export renders. Play, scrub, replay and export. Shows diagnostics and hot-reload status. |
| **Take editor** | Preview canvas, timeline with trim handles and zoom segments, controls for canvas, cursor, camera and audio. Edits save to `take.json` through the daemon. |
| **Recorder HUD** | Start, stop, pause, camera and microphone toggles, elapsed time, viewport size. Opened by shortcut (`Alt+Shift+R`) on any app route. |
| **Export panel** | Resolution, frame rate, output name; runs a daemon job and shows progress. Without a daemon it shows the equivalent CLI command. |

### 10.3 Playback session

One hook, `useClipSession`, owns the cursor: `timeMs`, `playing`, `seek`, `toggle`. It drives the clock store by `requestAnimationFrame` during playback, pauses when the tab is hidden or reduced motion is requested, clamps time when the duration changes and keeps the last valid definition while source is invalid. The capture bridge calls the same `seek`.

---

## 11. Daemon (`daemon`)

Started by `flick dev`. It binds `127.0.0.1` only and writes `.flick/daemon.json`.

### 11.1 Security

- Every request must carry the session token (`Authorization: Bearer …`). The token is random per start and reaches the studio in the URL fragment of the link `flick dev` prints, then lives in `sessionStorage`.
- The `Origin` must be a loopback origin and the `Host` header must be the daemon's own address, which blocks cross-site requests and DNS rebinding.
- All paths are resolved inside the project root; traversal, absolute paths and symlinks that leave the root are rejected.
- The daemon never executes project code.

### 11.2 API

| Method and path | Purpose |
|---|---|
| `GET /v1/status` | Version, project id, capabilities (FFmpeg and Chromium present) |
| `GET /v1/takes`, `GET /v1/takes/:id` | List and read takes |
| `POST /v1/takes` | Create a take, returns its id |
| `PUT /v1/takes/:id/media/:track?seq=n` | Append an uploaded chunk |
| `POST /v1/takes/:id/finalize` | Start ingest |
| `PATCH /v1/takes/:id` | Save `edit`; requires the revision hash it was read at |
| `DELETE /v1/takes/:id` | Delete a take and its media |
| `GET /v1/takes/:id/files/:name` | Serve media with range requests |
| `POST /v1/audio` | Store a voiceover recording |
| `POST /v1/exports` | Start an export job |
| `GET /v1/jobs/:id/events` | Server-sent progress events |
| `DELETE /v1/jobs/:id` | Cancel a job |
| `GET /render/…` | The standalone take render page used by export |

The daemon is a thin adapter: each route validates input with a `core` schema and calls the same operation the CLI calls.

---

## 12. Export (`export`)

### 12.1 Scenes (DOM)

1. Launch headless Chromium through Playwright at the output size, device scale factor 1.
2. Block navigation to anything but loopback HTTP.
3. Open the scene URL, hide `[data-flick-chrome]`, wait for the bridge and `ready()`.
4. For each frame `i`: `seek(i × 1000 / fps)`, then capture the `selector` rectangle and pipe it to FFmpeg.
5. FFmpeg encodes H.264 (`yuv420p`, `+faststart`) and mixes any scene audio.

Capture uses the DevTools protocol directly (`Page.captureScreenshot` with `optimizeForSpeed`), which measured about twice as fast as Playwright's PNG screenshot at 1080p. `--draft` switches to JPEG for roughly another 25%. Because every frame is a pure function of time, `--workers N` splits the frame range across N pages, encodes one segment per page and joins the segments without re-encoding. The default is half the CPU cores, capped at four.

Headless Chromium rasterises SVG filters on the CPU where no GPU is available. On a two-core cloud VM the six-band depth filter took about 4.6 seconds per 1280x896 frame, while scenes that only need uniform blur rendered at roughly ten frames per second. Export time on a real workstation has not been measured yet.

Host CSS animations and timers run on wall-clock time and are frozen during capture. Host components that should animate with the scene read `useSceneTime()`.

### 12.2 Takes (canvas)

1. Launch headless Chromium and open the daemon's render page for the take.
2. Call `bridge.encode({ fps, width, height })`. The page decodes, composites and encodes with `VideoEncoder`, streaming chunks back to Node.
3. Node muxes the chunks and FFmpeg adds audio. If the browser cannot encode H.264, it encodes VP9 and FFmpeg transcodes.

### 12.3 Sequences

Each item is exported to an intermediate file at the sequence's size and frame rate, then FFmpeg joins them with cuts or cross-fades and lays the sequence audio over the result.

### 12.4 Output rules

Outputs are project-relative `.mp4` paths. Existing files are never overwritten. Work happens in a temporary directory next to the target and the result is linked into place only on success. Cancellation (signal or job delete) kills the encoder and the browser and publishes nothing.

### 12.5 Snapshots

`flick snapshot --scene <id>` seeks one frame (default the midpoint) at `full` quality, captures a 320-pixel-wide PNG and writes it into the recipe if the recipe has not changed since it was read.

---

## 13. Project setup (`project`)

`flick init` detects the host and connects it. It is idempotent.

| Host | What `init` does |
|---|---|
| Vite + React | Generates `src/flick/Studio.tsx` with a lazy `import.meta.glob` of the scenes directory. Wraps the root render in the entry file when it matches the standard `createRoot(...).render(...)` form; otherwise prints the one-line wiring instruction. |
| Next.js App or Pages Router | Adds a development-only `/flick` route that loads the studio with SSR disabled. Does not touch layouts or config. Prints the one line that adds the recorder loader to the root layout. |
| Any other React DOM host | Generates the wrapper and a static scene catalog (`src/flick/catalog.ts`); prints wiring instructions. `flick sync` regenerates the catalog after scene files are added or removed. |

Entry-file edits are made by a small dependency-free scanner (`project/entry.ts`) that finds the single `.render(...)` call and wraps its JSX argument. It declines anything it cannot read with certainty (several render calls, a non-JSX argument, unbalanced text) and `init` then prints the instruction instead. The TypeScript compiler API is not used: TypeScript 7 no longer ships one, and JavaScript hosts have no TypeScript at all. Every `init` step is idempotent, so re-running it completes an interrupted run; there is no journal.

`init` also writes `FLICK.md` (a short pointer to `flick guide`), `.flick/project.json` and `.flick/.gitignore`.

### Agent handoff

`flick guide --json` prints the authoring guide for the installed version: concepts (camera, focus, parallax, timing, composition), the schema defaults, the animatable properties per target, a tested scene file pair, the commands and the workflow. Defaults, property lists and the example are derived from the schemas in `core/guide.ts`, so the guide cannot drift from what the validator accepts. `flick guide` prints it as prose; `--json` prints the structured form.

---

## 14. CLI (`cli`)

| Command | Purpose |
|---|---|
| `flick init [--adapter vite\|next\|react]` | Connect the host app |
| `flick dev [--port]` | Start the daemon and print the studio link |
| `flick guide [--json]` | Print the agent authoring guide |
| `flick scenes [--json]` | List validated scenes |
| `flick takes [--json]` | List takes |
| `flick sync` | Regenerate the static scene catalog |
| `flick open [--scene id \| --take id] --url <origin>` | Open the studio in the browser |
| `flick snapshot --scene id --url <origin> [--time ms]` | Save a thumbnail into the recipe |
| `flick zoom <take> [--write] [params]` | Preview or materialise auto-zoom tracks |
| `flick export --scene id \| --take id \| --sequence id [--fps] [--size] [--output] [--draft] [--workers]` | Render an MP4 |
| `flick doctor` | Check Node, FFmpeg, Chromium and the project connection |

Every command accepts `--json` and then prints only the operation result. Human output is a separate formatter over the same result.

---

## 15. Testing

| Layer | Tooling | What is proven |
|---|---|---|
| `core` | Vitest, no DOM | Schemas, easing, matrices, focus maths, auto-zoom, cursor smoothing, guide example validity |
| `react`, `studio` | Vitest + jsdom | Registration, diagnostics, session behaviour, recovery |
| Renderer pixels | Playwright | Real-browser focus (equal depth is equally sharp, tilt produces a gradient), transforms, cover framing |
| Export | Playwright + FFmpeg | Frame count, duration and cadence of real MP4s; no-overwrite; cancellation |
| Recorder | Headed Chromium with `--auto-accept-this-tab-capture` | HUD excluded, cursor-free capture, event log shape, chunk upload and ingest |
| Installed package | Packed tarball in a temporary Vite, Next and plain React host | `init` idempotency, studio loads, production build contains no Flick code |
| Boundaries | `scripts/check-boundaries.mjs` | Import rules in section 3 |

`examples/vite-app` is the development host. It is not published.

---

## 16. Build and release

- TypeScript strict, ES modules only.
- `scripts/build.mjs` uses Vite's library mode. The browser entry points (`.`, `./core`, `./studio`) are built in one pass so they share a single copy of the scene context; the CLI is a second, Node-targeted build. `tsc -p tsconfig.build.json` emits declarations. The recorder entry and the take render page join the build in their phases.
- `package.json` `files` allow-lists `dist/`. `sideEffects` is false except for the CLI entry, so unused browser code tree-shakes.
- Releases are published from a clean, verified checkout. Versions are immutable.

---

## 17. Build order

Each phase ends with something that runs and is tested.

| Phase | Delivers | Done when |
|---|---|---|
| 0. Spikes | Risk answers | **Complete.** Results are recorded in this document. |
| 1. Core and scene renderer | `core` schemas, motion, spatial and focus maths; `Scene`, `Surface`; `ScenePreview` with play and scrub; `examples/vite-app` | **Complete.** |
| 2. Flute parity | `init` and adapters, scene discovery and library, guide and `FLICK.md`, capture bridge, scene export, snapshots | **Complete.** `scripts/check-installed.mjs` goes from `init` to an exported MP4 in a fresh Vite app and a fresh Next.js app. |
| 3. Daemon and recorder | Daemon, take storage, HUD, capture, event log, ingest | A recording made in the example app is on disk with a valid `take.json` |
| 4. Take compositor | Frame sources, zoom, cursor, camera bubble, take editor, take export with audio | A take exports to MP4 with cursor, auto-zoom, camera and voice in sync |
| 5. Sequences and voiceover | Sequence schema and export, narration over scenes | A scene plus a take export as one file with a fade |
| 6. Release | Installed-package tests, docs, publish | `@flickjs/record` installs and works from the registry |

---

## 18. Known limits and open questions

- **Chromium only for recording and export.** Scenes preview in any modern browser.
- **Own tab only.** No desktop capture, no other windows, no system audio. Tab audio can be added later through the same capture call.
- **Depth of field is an approximation.** Gaussian kernels in the DOM; no aperture-shaped bokeh and no occlusion between surfaces.
- **Not yet verified:** the sync-marker latency measurement (8.2); decoding remuxed variable-frame-rate recordings by timestamp at retina resolution (9.1); `restrictTo` on `body` in macOS Chrome (verified on Linux only); H.264 `VideoEncoder` availability in Playwright's Chromium on macOS (12.2 has the VP9 fallback). Each is checked at the start of its phase.
- **Deferred:** a virtual-time export mode that advances host CSS animations and timers frame by frame; a visual keyframe editor for scenes; background blur for the camera.
- **Out of scope:** hosted rendering, accounts, a drag-and-drop builder, React Native.
