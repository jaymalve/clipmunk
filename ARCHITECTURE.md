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
| `@flickjs/record/recorder` | `bootRecorder`, `mountRecorderHud`, `createRecorder`, the daemon client | Browser, dev only |
| `flick` binary | CLI | Node |

Dependencies: `zod`, `mediabunny`. Peer: `react`, `react-dom` (>=18.2 <20). Optional peer: `playwright` (export, snapshots). System prerequisite for saving recordings and for export: FFmpeg. It is looked up as `FLICK_FFMPEG`, then the `ffmpeg-static` package if the project has it installed, then `ffmpeg` on `PATH`. `flick dev` warns at startup when none is found, and the recorder refuses to start a recording the daemon could not save.

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
.flick/takes/<id>/audio.wav           Voice track extracted at ingest (ignored).
.flick/takes/<id>/events.jsonl        Pointer and interaction log (ignored).
.flick/takes/<id>/recorder.log        Recorder breadcrumbs for diagnosis (ignored).
.flick/audio/<file>                   Narration recordings and any music or voiceover files (ignored).
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
    zoom:   { mode: "auto"; params: AutoZoomParams } | { mode: "manual"; tracks: ZoomTrack[] } | { mode: "off" };
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
  version: 1; id: string; title: string;
  width: number; height: number; fps: 30 | 60;          // defaults 1920 x 1080 at 60
  items: { clip: { kind: "scene" | "take"; id: string };
           transition: { kind: "cut" | "fade"; ms: number } }[];   // how the item arrives from the one before
  audio?: { file: string; offsetMs: number; gain: number }[];      // laid over the whole sequence
};
```

A fade overlaps two clips, so it shortens the total by its length, and it is capped at half of the shorter neighbour. `planSequence(items, durations)` in `core/sequence.ts` computes each item's start, each fade and the total; the exporter and the tests use the same function. The first item's transition is ignored. Items have no trim of their own: a take is trimmed in its own edit.

Sound files are named by plain file name and live in `.flick/audio`. The same `{ file, offsetMs, gain }` shape attaches sound to a scene (`recipe.audio`) and to a sequence.

### 5.5a Music

```ts
type Music = { style: "upbeat" | "lofi"; seed: number; gain: number; duck: boolean };
```

A scene (`recipe.music`), a take (`edit.music`) and a sequence (`music`) can each carry one. `seed` picks a different tune in the same style, `gain` defaults to 0.5, and `duck` (default on) lowers the music while a voice is present. When a sequence has music, its clips are exported without their own.

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
  encode?(job: { fps; width?; height? }): Promise<EncodedClip>;   // canvas clips: render and encode in-page
}
```

- Scenes implement `seek` and are captured by screenshot.
- Takes implement `encode`, because their frames are already on a canvas and in-page encoding measured roughly ten times faster than screenshots. File bytes leave the page through a `__FLICK_WRITE__(base64, position)` binding the exporter provides, and progress through `__FLICK_PROGRESS__`.
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
6. **Events.** Listeners on `window` in the capture phase write the event log (5.4). Events that originate in the HUD are skipped. To log the cursor shape an element asks for, the recorder switches its own `cursor: none` rule off for the instant of the style read; nothing is painted in between.

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
- **The studio is not recordable.** Its pages navigate with full page loads, so the HUD declines to record on any URL with `?flick`.
- **Upload failures stop the recording** at once and offer to save what was uploaded. The daemon accepts a retried chunk whose response was lost without writing it twice.
- **No step can hang.** The HUD shows which start step is in progress. The capture restriction has a timeout, and the latency measurement never waits on `video.play()`, which stays pending on a still page because a tab capture emits no frame until something repaints.
- **Diagnosis.** The recorder sends breadcrumbs (start parameters, page unload, script errors, visibility changes, track events, upload failures, stop) to `PUT /v1/takes/:id/log`; the daemon appends them to `.flick/takes/<id>/recorder.log`.

### 8.5 Ingest (daemon)

Raw `MediaRecorder` files have no duration or seek index. Ingest runs `ffmpeg -c copy` to remux each file (fast, lossless), probes dimensions, extracts the voice track to 48 kHz mono WAV (`audio.wav`, from the camera file when it carries audio, otherwise from the microphone file), rewrites `events.jsonl` keeping only lines that match the event schema, and writes `take.json` with a default `edit`. `source.durationMs` is the recorder's own clock, not the container's, because a static page produces no frames near the end. Tab capture has a variable frame rate by nature (it emits frames only when the page repaints); the compositor looks frames up by time, so no re-encode is needed.

---

## 9. Take compositor (`compositor`, `core/autozoom`, `core/cursor`)

`drawTake(ctx, width, height, take, frame)` draws one frame and is a pure function of its arguments. `createTakeRenderer` wraps it with media and derived data, and exposes `renderAt(clipMs)` for the preview and `encode(job, write, progress)` for export; both draw through the same function. Clip time starts at zero at the trim start.

### 9.1 Frame sources

`mediabunny` demuxes and decodes the screen and camera files with WebCodecs. Because recordings have a variable frame rate, "the frame at time t" is the latest frame whose timestamp is not after `t`. Playback and export ask for increasing times, served by one forward decode; a request that goes backwards or jumps more than 1.5 seconds ahead restarts decoding from the nearest keyframe. A real `MediaRecorder` take (remuxed, variable frame rate) is decoded, composited and exported in the recorder test suite.

### 9.2 Layers, bottom to top

1. Canvas background (`edit.canvas.background`).
2. The screen frame over `source.background`, inset by `padding`, with rounded corners and a shadow, moved by the zoom at that time.
3. Click ripples, in screen space.
4. The synthetic cursor, in screen space, so it grows with the zoom. Arrow, hand and text-beam shapes are vector paths.
5. The camera bubble, in canvas space: a circle or rounded square in a chosen corner, cover-cropped and optionally mirrored.

Pixel-valued settings (corner radius, cursor size, margins) are authored against the edit's canvas size and scaled for any other output size, so a half-size export looks the same.

### 9.3 Auto-zoom

`generateZoomTracks(events, source, params)` in `core/autozoom.ts` is pure and deterministic:

1. **Activity.** Clicks and keystrokes, each with its element's box. A click whose box is nearly the whole page (the background) aims at the pointer instead. Hovering and scrolling are not activity.
2. **Segments.** Activity closer together than `mergeGapMs` (default 2500) forms one zoom segment.
3. **Scale.** One magnification per segment: half of what would make its largest target fill the frame, clamped to `minScale` and `maxScale` (defaults 1.25 and 2.2).
4. **Follow.** Inside a segment the view stays put while the action remains in the inner 62% of the view, and pans when it leaves.
5. **Timing.** Ease in over `easeMs` (default 700), arriving `leadMs` (default 300) before the first activity. Hold `holdMs` (default 1500) after the last, then ease out. A segment that starts before the previous one has finished easing out pans straight to it.

The view is clamped so it never shows anything outside the recording; a property test checks this at every 50 ms. The output is three ordinary tracks (`x`, `y`, `scale`) on `{ kind: "zoom" }`. With `edit.zoom.mode = "auto"` they are regenerated from `params`; `flick zoom <take> --write` stores them as `manual` tracks in `take.json` for hand editing.

### 9.4 Cursor

`prepareCursor(events, smoothing)` in `core/cursor.ts` resamples the pointer path at 120 Hz and smooths it with a forward-then-backward exponential filter, so the smoothed cursor does not lag the real pointer. The path is then pulled back toward each click within 140 ms either side, so it passes through the click position exactly, and it is held past the last event so it settles on the true final position. Cursor shape follows the logged `cursor` events; `pressed` shrinks it slightly between `down` and `up`. The cursor is not drawn before the pointer first moves.

### 9.5 Audio

The preview plays the extracted voice track alongside the clock. Export never handles audio in the page: FFmpeg receives the voice file with its offset, the trim, the gain and the loudness flag, and writes AAC into the final MP4.

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

- Without `?flick` in the URL the wrapper returns `children`, so the app is unaffected. In development the generated module also calls `bootRecorder()` from `@flickjs/record/recorder`, which remembers a daemon link in the URL and registers the recorder shortcut; nothing is shown until it is used.
- `?flick=1` renders the studio instead of the app. `&flick-scene=<id>` opens a scene (`&flick-take=<id>` will open a take). Navigation is by plain links, so back, forward and reload resolve the same URL.
- The wrapper lazy-loads `FlickStudio` from `@flickjs/record/studio` behind the bundler's compile-time development condition (`import.meta.env.DEV` or `process.env.NODE_ENV`), so a production build contains no Flick code. The installed-package check greps the production output to prove it.
- `FlickStudio` receives `scenes`: a map from module path to lazy loader for every recipe and component. It loads the recipes to build the library and loads a component only when its scene is opened.
- In Next.js the studio is a development-only route (`/flick`) instead of a wrapper.

### 10.2 Views

| View | What it does |
|---|---|
| **Library** | Grid of scenes (cached snapshot thumbnails) and takes. Shows validation issues per item. |
| **Scene player** | The authored frame fitted inside the viewport and clipped to its edges, so the preview shows exactly what export renders. Play, scrub, replay and export. Shows diagnostics and hot-reload status. |
| **Take editor** | The composited preview on a canvas; play and scrub; a timeline showing the kept range, zoom segments and playhead; trim from the playhead; controls for zoom, cursor, camera, frame and voice. Edits apply to the preview at once and are saved to `take.json` through the daemon half a second later, against a revision hash. |
| **Recorder HUD** | Record, stop, camera and microphone toggles, elapsed time, viewport size, a stand-in cursor and a live camera preview. A plain-DOM custom element on `<html>`; opened by `Alt+Shift+R` or `?flick-record=1` on any app route. There is no pause. |
| **Sequence builder** | Create a sequence by name, add scenes and takes, reorder and remove them, choose a cut or a fade and its length, and set the shape and frame rate. Saved to the sequence file through the daemon. There is no live preview of a whole sequence; it is seen by exporting. |
| **Export panel** | Resolution (the clip's own size, 720p, 1080p, 1440p or 4K, always in the clip's own shape and never over 3840 pixels a side) and frame rate where the clip allows a choice; runs a daemon job and shows progress. Without a daemon it shows the equivalent CLI command, including the chosen size. A sequence's resolution is set in its builder, because it is stored in the sequence file. |

### 10.3 Playback session

One hook, `useClipSession`, owns the cursor: `timeMs`, `playing`, `seek`, `toggle`. It drives the clock store by `requestAnimationFrame` during playback, pauses when the tab is hidden or reduced motion is requested, clamps time when the duration changes and keeps the last valid definition while source is invalid. The capture bridge calls the same `seek`.

---

## 11. Daemon (`daemon`)

Started by `flick dev`. It binds `127.0.0.1` only and writes `.flick/daemon.json`.

### 11.1 Security

- Every request must carry the session token (`Authorization: Bearer …`). The token is random per start and reaches the studio in the URL fragment of the link `flick dev` prints, then lives in `localStorage` for that origin so every tab of the app can reach the daemon. A restarted daemon has a new token; the stale one fails the status check and the HUD asks for the new link.
- `GET` requests may pass the token as `?token=` instead, because media elements and `EventSource` cannot set headers. Writes never accept it.
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
| `PUT /v1/takes/:id/log` | Append a recorder breadcrumb to `recorder.log` |
| `POST /v1/takes/:id/finalize` | Start ingest |
| `PATCH /v1/takes/:id` | Save `edit`; requires the revision hash it was read at |
| `DELETE /v1/takes/:id` | Delete a take and its media |
| `GET /v1/takes/:id/files/:name` | Serve media with range requests |
| `GET /v1/scenes` | List validated scenes |
| `PUT /v1/scenes/:id/music` | Set or clear a scene's generated music in its recipe |
| `PUT /v1/scenes/:id/narration?offset=ms` | Store a narration recording and point the scene's recipe at it |
| `DELETE /v1/scenes/:id/narration` | Remove a scene's narration and its file |
| `GET /v1/audio/:file` | Serve a sound from `.flick/audio`, for the preview |
| `GET /v1/sequences`, `GET /v1/sequences/:id` | List and read sequences |
| `PUT /v1/sequences/:id`, `DELETE /v1/sequences/:id` | Save (only when every clip exists) or delete a sequence |
| `POST /v1/exports` | Start an export job for `{ sceneId }`, `{ takeId }` or `{ sequenceId }` |
| `GET /v1/jobs/:id/events` | Server-sent progress events |
| `DELETE /v1/jobs/:id` | Cancel a job |

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

Headless Chromium rasterises SVG filters on the CPU where no GPU is available. On a two-core cloud VM the six-band depth filter took about 4.6 seconds per 1280x896 frame, while scenes that only need uniform blur rendered at roughly ten frames per second. On an Apple M5 with the default four workers, the same depth-filter scene exported at 4K (3086x2160, 30 fps, 210 frames) in 18.3 seconds, about 87 ms per frame, and a uniform-blur scene at 3600x2160 in 5.6 seconds for 45 frames. Scene export at 4K is therefore practical on a workstation; the slow figures above are specific to machines without a GPU.

Host CSS animations and timers run on wall-clock time and are frozen during capture. Host components that should animate with the scene read `useSceneTime()`.

### 12.2 Takes (canvas)

1. Start a private daemon for the export (it serves the take and its media) and launch headless Chromium.
2. Open the studio's take editor on the dev server, with the private daemon's address in the URL fragment. There is no separate render page: export runs the same editor code as the preview.
3. Call `bridge.encode({ fps, width, height })`. The page decodes, draws and encodes every frame with `VideoEncoder`, muxes with `mediabunny`, and passes file bytes to Node through a page binding.
4. FFmpeg adds the voice track and moves the index to the front. The picture is copied untouched when the browser encoded H.264; otherwise (VP9 or AV1) FFmpeg re-encodes it.

Size defaults to the edit's canvas; giving a width or height scales the other to match. Frame rate is 30 or 60.

### 12.3 Sequences

1. Read the sequence and check that every clip it names exists.
2. Render each distinct clip once, at the sequence's size and frame rate, with the ordinary scene and take exporters. A clip whose shape differs from the sequence's is fitted inside the frame.
3. Join the results in one FFmpeg filter graph: `xfade` and `acrossfade` for a fade, `concat` for a cut. A clip without sound contributes silence so every join is uniform.
4. Mix the sequence's own audio over the result and write H.264 and AAC.

Intermediate files live in a temporary directory under `.flick/exports` and are removed whether the export succeeds or not.

### 12.3a Sound on scenes

A scene's `audio` clips are mixed into its export after the picture is encoded (the picture is copied, not re-encoded). A file that has gone missing does not fail the export; the result carries a warning naming it.

**Narration.** In the scene player, Narrate plays the scene from the start while recording the microphone, and stops when the scene ends. The daemon stores the recording as 48 kHz mono WAV in `.flick/audio`, named `<scene>-narration-<timestamp>.wav`, and rewrites the recipe's `audio` to point at it with the measured offset between the microphone starting and playback starting. A new narration replaces the previous one and deletes its file; other sounds on the scene are kept.

### 12.3b Generated music

Background music is synthesized by `renderMusic` in `core/music.ts`: a pure TypeScript function from `{ style, seed, durationMs, accentsMs }` to stereo samples. It uses no recordings, samples or third-party tracks, so the result carries nobody else's rights; that is the reason it exists, and the reason no music is bundled.

- **How it is made.** A seeded random generator picks a key and one of a few chord progressions for the style. Voices are computed sample by sample: detuned chord pads through a low-pass, a bass line, a pitch-swept kick, noise-based snare and hats, and a plucked melody drawn from the chord with echoes. Lo-fi adds swing, tape hiss and crackle.
- **Stable by construction.** The mix goes through a fixed gain per style and a soft clipper, never a gain measured from the audio. So a longer clip starts with exactly the same music as a shorter one, and adding an accent cannot change how loud the rest is. Each style is set to a similar loudness (about 0.15 RMS, peaks under 0.8).
- **Fitted to the clip.** It is rendered to the clip's exact length with a fade in and a fade out, so there is no looping. A sequence passes the time of each join as an accent: a short swell into a low thump.
- **Same in preview and export.** The studio renders the same function into an `AudioBuffer` and starts it at the clock's position; the exporter writes it to a WAV for FFmpeg. Ducking under a voice (`sidechaincompress`) happens at export only, so the preview plays the music at its full level.

`flick music <style>` writes a sample WAV for listening to a style.

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
| Next.js App or Pages Router | Adds a development-only `/flick` route that loads the studio with SSR disabled. Does not touch layouts or config. Generates `src/flick/Recorder.tsx` and prints the one line that adds `<FlickRecorder />` to the root layout; `init` reports the recorder as connected once that line is present. |
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
| `flick dev [--port]` | Start the daemon and print the link that connects the browser to it |
| `flick guide [--json]` | Print the agent authoring guide |
| `flick scenes [--json]` | List validated scenes |
| `flick takes [--json]` | List takes |
| `flick sync` | Regenerate the static scene catalog |
| `flick open [--scene id \| --take id] --url <origin>` | Open the studio in the browser |
| `flick snapshot --scene id --url <origin> [--time ms]` | Save a thumbnail into the recipe |
| `flick zoom <take> [--write]` | List a take's zoom segments, or store them as manual keyframes |
| `flick sequences [--json]` | List sequences and their validation issues |
| `flick music <style> [--seed] [--seconds] [--output]` | Write a WAV sample of the generated music |
| `flick export --scene id \| --take id \| --sequence id [--fps] [--size] [--output] [--draft] [--workers]` | Render an MP4. A sequence takes its size and frame rate from its file. |
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
| Recorder | Headed Chromium with `--auto-accept-this-tab-capture` | HUD excluded, cursor-free capture, event log shape, video-to-event sync, keyboard stop, reload recovery, chunk upload and ingest, and a real take edited and exported |
| Takes | Playwright + FFmpeg on a synthetic take with known pixels | Layout, zoom, cursor and camera pixels; editor controls and saving; trim; exported MP4 frames, size and voice track |
| Sequences and narration | Playwright + FFmpeg on the example app | Narration stored, replaced, removed and recorded through the studio; a scene and a take joined by fade and by cut, checked for length, frames, sound and the mixed picture mid-fade; the sequence builder saving a valid file |
| Generated music | Vitest for the synthesizer; Playwright + FFmpeg for its use | Exact length, no clipping, determinism, fades, accents and WAV encoding; music audible in scene, take and sequence exports; controls saving to scene, take and sequence files. Nothing tests how it sounds. |
| Installed package | Packed tarball in a temporary Vite, Next and plain React host | `init` idempotency, studio loads, production build contains no Flick code |
| Boundaries | `scripts/check-boundaries.mjs` | Import rules in section 3 |

`examples/vite-app` is the development host. It is not published.

---

## 16. Build and release

- TypeScript strict, ES modules only.
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
| 2. Flute parity | `init` and adapters, scene discovery and library, guide and `FLICK.md`, capture bridge, scene export, snapshots | **Complete.** `scripts/check-installed.mjs` goes from `init` to an exported MP4 in a fresh Vite app and a fresh Next.js app. |
| 3. Daemon and recorder | Daemon, take storage, HUD, capture, event log, ingest | **Complete.** `tests/recorder` records the example app in headed Chromium and validates the take on disk. |
| 4. Take compositor | Frame sources, zoom, cursor, camera bubble, take editor, take export with audio | **Complete.** `tests/take` checks the composite pixel by pixel on a synthetic take and exports it; `tests/recorder` edits and exports a real recording. |
| 5. Sequences and voiceover | Sequence schema and export, narration over scenes | **Complete.** `tests/sequence` narrates a scene through the studio, and exports a scene plus a take as one file with a fade, with a cut, and with music over the whole. |
| 6. Release | Installed-package tests, docs, publish | `@flickjs/record` installs and works from the registry |

---

## 18. Known limits and open questions

- **Chromium only for recording and export.** Scenes preview in any modern browser.
- **Own tab only.** No desktop capture, no other windows, no system audio. Tab audio can be added later through the same capture call.
- **Depth of field is an approximation.** Gaussian kernels in the DOM; no aperture-shaped bokeh and no occlusion between surfaces.
- **Not yet verified:** recording on macOS end to end (the recorder is tested on Linux under a virtual display, where the latency measurement returns a value but no real cursor exists); playback smoothness of a retina-resolution take in the editor on a real machine (decoding is verified, speed is not); how voice and picture line up by ear in a real export; `restrictTo` on `body` in macOS Chrome (verified on Linux only); H.264 `VideoEncoder` availability in Playwright's Chromium on macOS (12.2 has the VP9 fallback). Each is checked at the start of its phase.
- **Deferred:** a virtual-time export mode that advances host CSS animations and timers frame by frame; a visual keyframe editor for scenes; background blur for the camera.
- **Out of scope:** hosted rendering, accounts, a drag-and-drop builder, React Native.
