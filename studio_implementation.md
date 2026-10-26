# Studio implementation plan and log

This file is the working plan for phase 7 of `ARCHITECTURE.md` (the Studio and the next feature set) and the log of how far it has got. The decisions behind it are in `ARCHITECTURE.md` section 19; read that first. Anyone, person or coding agent, should be able to pick the work up from here.

## How to work from this file

1. **Find the next PR.** It is the first entry below whose status is not ✅. If it is 🟡 or 🔵, its branch already exists: `git fetch && git branch -r | grep studio/`.
2. **One entry, one PR.** Each entry is one pull request with one purpose. The PRs are stacked: each branch starts from the branch of the entry before it (`studio/NN-slug`, based on `studio/(NN-1)-…`), so review can run ahead of merging. When a lower PR merges, rebase the next branch onto `main` and retarget its PR.
3. **Keep the scope.** Do what the entry says. Work you discover that belongs elsewhere goes into that entry's notes, or a new entry, not into the current PR.
4. **Keep the architecture honest.** `ARCHITECTURE.md` describes the code as it is. A PR that changes behaviour rewrites the sections it touches; section 19 shrinks as its decisions become real.
5. **Prove it.** Every PR passes `npm run verify`, plus the suites its entry lists. A PR that touches the browser or export runs the matching Playwright suite (`npm run test:take`, `test:export`, `test:sequence`, `test:recorder`, `test:installed`).
6. **Log it.** When a PR is opened, set its status to 🔵 with the PR link. When it merges, set ✅ and add a line to the log at the bottom: date, PR, what landed, anything the next PR must know. Use the entry's **Notes** for surprises and changes of plan.
7. **Stop on a wrong decision.** If a decision in section 19 turns out to be wrong, stop and ask the project owner before working around it, then record the outcome under Decisions.

Status: ⬜ to do · 🟡 in progress · 🔵 in review · ✅ merged

## Overview

| # | PR | Part | Status |
|---|---|---|---|
| 0 | Plan: architecture direction and this file | Plan | ✅ [#17](https://github.com/jaymalve/clipmunk/pull/17) |
| 1 | Take edits in a sidecar file | Engine | 🔵 [#18](https://github.com/jaymalve/clipmunk/pull/18) |
| 2 | `clipmunk.config.json` and brand defaults | Engine | 🔵 [#19](https://github.com/jaymalve/clipmunk/pull/19) |
| 3 | Presets: apply and save | Engine | 🔵 [#20](https://github.com/jaymalve/clipmunk/pull/20) |
| 4 | Event log v2: what was touched | Engine | 🔵 [#21](https://github.com/jaymalve/clipmunk/pull/21) |
| 5 | Redaction | Engine | 🔵 [#22](https://github.com/jaymalve/clipmunk/pull/22) |
| 6 | Captions and the keystroke overlay | Engine | 🔵 [#23](https://github.com/jaymalve/clipmunk/pull/23) |
| 7 | Dead air and steady typing | Engine | 🔵 [#24](https://github.com/jaymalve/clipmunk/pull/24) |
| 8 | Reframing takes to other aspect ratios | Engine | 🔵 [#25](https://github.com/jaymalve/clipmunk/pull/25) |
| 9 | Export jobs with several outputs: GIF, poster, ratios | Engine | 🔵 [#26](https://github.com/jaymalve/clipmunk/pull/26) |
| 10 | Scene variants: theme, locale, ratio | Engine | 🔵 [#27](https://github.com/jaymalve/clipmunk/pull/27) |
| 11 | The frame page in the host | Studio | 🔵 [#28](https://github.com/jaymalve/clipmunk/pull/28) |
| 12 | The daemon serves the Studio (parity) | Studio | 🔵 [#29](https://github.com/jaymalve/clipmunk/pull/29) |
| 13 | Switch over to the standalone Studio | Studio | 🔵 [#30](https://github.com/jaymalve/clipmunk/pull/30) |
| 14 | Library screen | Studio | ⬜ |
| 15 | Editor screen: timeline, inspector, undo | Studio | ⬜ |
| 16 | Presets in the Studio | Studio | ⬜ |
| 17 | `clipmunk mcp` | Agent | ⬜ |
| 18 | Agent chat | Agent | ⬜ |
| 19 | Take to scene | Agent | ⬜ |
| 20 | Source map and export manifest | Freshness | ⬜ |
| 21 | Stale detection | Freshness | ⬜ |
| 22 | GitHub Action and posting to a PR | Freshness | ⬜ |

Why this order: the engine pieces come first and need no new UI, so the CLI and agents can use them at once and the new Studio is built once, with them already in place. The Studio comes before the agent work because chat lives in it. Freshness comes last because it builds on exports, variants and the manifest.

While the engine PRs land, the current in-app Studio keeps working. New features get at most a minimal control there (a checkbox or a select), never a new screen; screens are built once, in the standalone Studio.

---

## Part 0: Plan

### PR 0 · Plan: architecture direction and this file
**Status:** ✅ [#17](https://github.com/jaymalve/clipmunk/pull/17) · **Branch:** `studio/00-plan` · **Base:** `main`

- `ARCHITECTURE.md`: new section 19 with the agreed direction, a phase 7 row in section 17, replay listed as not planned in section 18.
- This file.

**Done when:** the owner agrees the plan.

---

## Part 1: Engine

### PR 1 · Take edits in a sidecar file
**Status:** 🔵 [#18](https://github.com/jaymalve/clipmunk/pull/18) · **Branch:** `studio/01-edit-sidecar` · **Base:** `main` (PR 0 merged first)

**Goal:** a raw take is never rewritten; every change lives in `edit.json` beside it (section 19.4).

- `core/take.ts`: `TakeFileSchema` (`take.json`: `version`, `id`, `title`, `createdAt`, `source`, and an optional legacy `edit`) and `TakeEditFileSchema` (`edit.json`: `version`, optional `title`, `edit`). `composeTake` merges them into `Take`, the view everything else consumes, so the compositor and exporters do not change.
- `project/takes.ts` (new): `loadTake` and `saveTakeEdit`, used by the daemon, the CLI and the exporter, which had its own reader before. Reading prefers `edit.json`, then the old `edit` inside `take.json`, then the defaults. Saving writes only `edit.json`. The revision is a hash of both files.
- Ingest writes `edit.json` with the default edit, then `take.json`. Writing the edit at ingest means later changes to the defaults (PR 2's brand) never change a take recorded earlier.
- Title: `title` sits at the top of `edit.json`, written only when the take has been renamed.
- `.clipmunk/.gitignore` template keeps `edit.json`. Older projects would otherwise ignore it, so `clipmunk dev` now refreshes Clipmunk's state files (`refreshStateFiles`) when they are unedited, and prints what to add by hand when they were edited.
- `ARCHITECTURE.md` sections 4, 5.3, 8.5, 9.3, 10.2 and 11.2 updated.

**Tests:** unit tests for the three read paths and for a save never touching `take.json` (compare bytes before and after); `test:take` and `test:recorder` still pass.
**Done when:** editing a take in the Studio or with `clipmunk zoom --write` leaves `take.json` byte-identical, and an old-format take opens and saves correctly.
**Notes:** `clipmunk zoom --write` goes through the same `saveTakeEdit`, so it is covered by the same guarantee; the take suite checks its output in `edit.json`.

### PR 2 · `clipmunk.config.json` and brand defaults
**Status:** 🔵 [#19](https://github.com/jaymalve/clipmunk/pull/19) · **Branch:** `studio/02-config` · **Base:** `studio/01-edit-sidecar`

**Goal:** one project-wide settings file (section 19.3), read without executing code.

- `core/config.ts`: Zod schema, every field optional.
  ```json
  {
    "version": 1,
    "brand": { "backdrop": "#2B2117", "padding": 64, "radius": 14, "logo": "./brand/logo.svg", "outro": true },
    "redact": [".client-email", "[data-secret]"],
    "presets": {},
    "variants": { "themes": ["light", "dark"], "locales": [] }
  }
  ```
  `presets` is filled in by PR 3 and `variants` is used by PR 10; both are only validated here.
- `project/config.ts`: `readConfig(root)` returns the validated config or issues with paths into the file; a missing file is the empty config.
- Brand defaults: a new take's edit starts from the brand (backdrop, padding, radius). An existing edit is never changed by editing the config. `brand.padding` is pixels on the frame's short side, the unit people and the Studio mockup use, and `applyBrand` converts it to the edit's fraction. A config that does not validate is ignored at ingest, so it can never lose a recording.
- `logo` and `outro` are validated and stored. Rendering them is out of scope until a PR picks them up; record that in this entry's notes if it is still open after PR 9.
- `clipmunk init` writes a starter config only when none exists, and never records it as a generated file. `clipmunk doctor` reports config issues and a missing logo file. `GET /v1/config` returns it. The guide documents it.
- `ARCHITECTURE.md` sections 4, 5.5b (new), 8.5, 11.2, 13, 14 and 19.3 updated. The example app gets the starter config.

**Tests:** schema tests (good file, unknown key, bad colour, bad selector); daemon route test; init idempotency.
**Done when:** a new take in a project with a brand starts with that backdrop, padding and radius, and a bad config is reported with the field's path.

### PR 3 · Presets: apply and save
**Status:** 🔵 [#20](https://github.com/jaymalve/clipmunk/pull/20) · **Branch:** `studio/03-presets` · **Base:** `studio/02-config`

**Goal:** named partial edits shared through the repo.

- Preset shape: `{ title?, description?, edit?: { canvas?, zoom?, cursor?, cam?, audio? }, music?: Music | null, export?: { size?, fps?, formats?, ratios? } }`. Each section is partial with its defaults stripped, so a preset holds only what it sets. The trim is never part of a preset, and a preset's zoom must be auto or off. Export options are validated now and used from PR 9. The edit's sections became named schemas in `core/take.ts` (`CanvasSchema`, `ZoomSchema`, …) so presets derive from them.
- `core/presets.ts`: `applyPreset(edit, preset)`, a pure merge in which sections merge field by field, zoom and music replace whole, and `music: null` removes. `presetFromEdit(edit, fields)` picks the chosen sections out of an edit, leaving out the music seed so each clip keeps its own tune. `describePreset` gives the one-line summary the Studio's preset bar will show.
- Operations, shared by the CLI and the daemon (`project/presets.ts`): `applyPresetToTake(id, name)` writes `edit.json`. `savePreset` writes `clipmunk.config.json` with the other keys left in their order and the file's own indentation kept, refusing to overwrite an existing preset unless asked; a replaced preset keeps its place. It never writes a config that does not validate.
- Applying a preset to a scene sets the scene's music only; scenes carry no take edit.
- CLI: `clipmunk preset list`, `clipmunk preset apply <name> --take <id>`, `clipmunk preset save <name> --take <id> --fields zoom,cursor,canvas`. Daemon: `GET /v1/presets`, `POST /v1/presets`, `POST /v1/takes/:id/preset`.

**Tests:** merge semantics, round trip (save from an edit, then apply to a default edit gives the same fields), config rewrite keeping other keys.
**Done when:** a preset saved from one take and applied to another changes only the preset's fields, and `git diff` of the config shows only the new preset.

### PR 4 · Event log v2: what was touched
**Status:** 🔵 [#21](https://github.com/jaymalve/clipmunk/pull/21) · **Branch:** `studio/04-event-log-v2` · **Base:** `studio/03-presets`

**Goal:** the log knows which element was used (section 19.5), which captions, redaction, take to scene and stale detection all need.

- On `down` and `focus`, add `el: { sel, role?, name?, testId? }`. (`up` follows its `down`, and `type` follows its `focus`, so repeating `el` on every keystroke would only bloat the log.) `sel` is a short stable selector: id, `data-testid`, or role and name, before falling back to a class path. `name` is the accessible name, truncated to 80 characters, and only for controls, so clicking a table cell records no cell text. `recorder/identity.ts` holds this and is unit-tested in jsdom. The spike's picker selectors (`spikes/studio/frame-agent.ts`) were too crude to reuse.
- New kinds: `route` (`path`, on load, `pushState`, `replaceState` and `popstate`), `combo` (`keys`, e.g. `["Meta","K"]`, only when a modifier other than Shift is held, never in password fields), and `redact` (`sel` plus `rects: [x,y,w,h][]`, one event per selector, for elements matching the config's redaction selectors, logged on the first frame and whenever a box changes; checked once per animation frame). `route` logs the path only: no query or fragment, which can carry tokens.
- Privacy rules, enforced in the recorder and covered by tests: no typed text, no attribute values, no `name` for an element that matches a redaction selector or sits inside one, and nothing but `type` with `rect` inside password fields.
- The recorder fetches the redaction selectors from `GET /v1/config` when a take starts.
- `core/take.ts` event schema extended. Old logs stay valid, because every new field is optional.
- `ARCHITECTURE.md` section 5.4 rewritten, including the changed promise.

**Tests:** `test:recorder` records the example app and asserts the new events, the selectors and the privacy rules (a password field, a redacted element, a combo).
**Done when:** a recording of "click New report, type, press ⌘K" yields events naming the button and the combo, and nothing typed.

### PR 5 · Redaction
**Status:** 🔵 [#22](https://github.com/jaymalve/clipmunk/pull/22) · **Branch:** `studio/05-redaction` · **Base:** `studio/04-event-log-v2`

**Goal:** sensitive elements are hidden in every exported frame.

- Edit: `redact: [{ sel, mode: "blur" | "block" } | { rect: [x,y,w,h], fromMs, toMs, mode }]`, default `[]`. Ingest adds one selector entry per selector in the config and per selector the log has boxes for, so a take recorded with redaction keeps it even when the config cannot be read at ingest. Box entries are for anything not covered by a selector, drawn by hand in the Studio later.
- `core/redact.ts`: from the log's `redact` events, the boxes of each selector at any time, holding the last boxes between events. Around every change the old and new boxes are both covered for 150 ms either side, and logged boxes grow by 4 px, so a frame that lags or leads the log stays hidden. Pure and unit-tested.
- Compositor: draws blur or block on the screen frame, under the cursor, so a box follows scrolling and zooms with the picture. Blur redraws only the part of the recording it reaches. Every export path inherits it: MP4 now, GIF and poster in PR 9.
- Optional live masking: `redact.live: true` in the config makes the recorder also blur matching elements in the page while recording, so the secret never reaches `screen.webm`. It is off by default, because the developer then sees their own app blurred.
- Minimal control in the current take editor: one list of redaction entries with blur or block.

**Tests:** on a synthetic take with a striped box that scrolls, the stripe is hidden in the composite and in the exported MP4 before, during and after the scroll, with blur and with block; the same take without redaction shows the stripe. Unit tests for the track and the config; the daemon suite checks the entries ingest writes; `test:recorder` checks live masking turns on and off with the recording.
**Done when:** the spec's check passes: a moving or scrolled redacted element stays covered in every frame.

**Notes:** `redact.live` needed an object in the config, so `redact` is now either the list of selectors (as before) or `{ selectors, mode?, live? }`; `redactionOf` reads both. Presets do not carry redaction: it belongs to what a recording shows, not to a look. `source.screen.latencyMs` is not used for the guard window, because sync does not depend on it (`ARCHITECTURE.md` 8.2). The recorder test that required a take longer than 1500 ms failed on a fast machine (its own steps take about 1.4 s); it now requires the take to be at least as long as the steps took.

### PR 6 · Captions and the keystroke overlay
**Status:** 🔵 [#23](https://github.com/jaymalve/clipmunk/pull/23) · **Branch:** `studio/06-captions-keys` · **Base:** `studio/05-redaction`

- Edit: `captions: { auto: boolean, items: { atMs, durMs, text, source: "auto" | "manual" }[] }` and `keys: { visible: boolean }`, both on by default.
- `core/captions.ts`: auto captions from `down` events with an `el.name`, phrased by role ("Click New invoice", "Open Settings", "Choose Monthly", "Toggle Dark mode", "Type in Search"), one per burst of activity (2.5 s gap), never for a redacted element: unnamed by the recorder, and a click inside a redacted box is skipped too. It is a pure generator emitting ordinary data, like auto-zoom. A user edit to an item stores it as `manual`, regeneration keeps manual items, and a manual item with empty text hides the caption at its time.
- `core/keys.ts`: combo pills from `combo` events ("⌘ K"), shown for 900 ms, at most three at once.
- Compositor: a caption strip and key pills along the bottom of the recording, in the edit's backdrop colour (which the brand sets) with black or white text, drawn after zoom so they stay readable.
- Minimal controls in the current take editor: two checkboxes and editable caption text.

**Tests:** generator unit tests (phrasing, bursts, manual items kept, cleared items, redacted elements skipped, pills); composite pixels and the editor controls on the synthetic take, and the caption and pill in its exported MP4; in `test:recorder` a real take gets "Click New report", and the ⌘K recording gets one pill and no pill for typing in a password field.
**Done when:** a take with no manual edits exports with sensible captions, and ⌘K appears as a pill while plain typing never does.

**Notes:** presets do not carry `captions` or `keys` yet; add them to `PRESET_FIELDS` if a preset should switch them. Caption styling has no settings of its own beyond the backdrop colour.

### PR 7 · Dead air and steady typing
**Status:** 🔵 [#24](https://github.com/jaymalve/clipmunk/pull/24) · **Branch:** `studio/07-dead-air` · **Base:** `studio/06-captions-keys`

**Goal:** idle gaps and slow typing play faster without manual cuts.

- Edit: `pace: { deadAir: { on, maxGapMs: 600, speed: 4 }, typing: { on, speed: 2 } }`, off in the schema; ingest turns both on for new takes, so older takes play as before.
- `core/timemap.ts`: a piecewise-linear map between presentation time and take time, built from the trim, from gaps longer than `maxGapMs` with no input and no voice (keeping half of `maxGapMs` at normal speed at each end), and from typing runs (three or more keystrokes at most a second apart). This is the one place that maps between the two clocks. Trim is its simplest case (`trimMap`).
- Voice: a stretch with speech in `audio.wav` is not sped up. `detectSpeech` is a simple energy detector; ingest runs it and `project/speech.ts` caches the spans in `speech.json` next to the take (rebuilt when missing), not in `take.json`. The daemon serves them with the take.
- Everything that reads take time goes through the map: compositor frames, zoom, cursor, captions, keys and redaction (all on take time inside the renderer), music moments, the timeline, the trim buttons, export duration and audio. Sped-up spans become silence in the audio, which is never pitch-shifted; the preview's voice is muted there and kept in step.
- Minimal control in the current take editor: two checkboxes, and the timeline stripes the fast parts.

**Tests:** time map unit tests (trim equivalence, gaps, edges, typing, speech, monotonic and inverse) and speech detection; an export of a take with known gaps has the expected duration and frames, a take whose voice never stops keeps its length and writes `speech.json`, and the editor checkbox turns pacing off; the existing take, recorder and sequence suites pass, with the synthetic takes unpaced.
**Done when:** pacing is on by default for new takes, can be switched off per take, and a take with 2.4 s of idle time exports about that much shorter.

**Notes:** a gap at 4x shortens by three quarters of its fast part, so 2.4 s of idle time beyond the kept 600 ms exports 1.8 s shorter; raise `speed` for more. Pacing is not part of presets yet.

### PR 8 · Reframing takes to other aspect ratios
**Status:** 🔵 [#25](https://github.com/jaymalve/clipmunk/pull/25) · **Branch:** `studio/08-reframe` · **Base:** `studio/07-dead-air`

- Edit: `frame: { ratio: "16:9" | "9:16" | "1:1" | "4:5" }`. It replaces the free canvas size for the shape (`ratioCanvas`: 1080 on the short side), and the size then comes from the export. Without it the whole recording is fitted, as before.
- `core/reframe.ts`: for a ratio narrower than the source, a crop window that follows the clicked elements with the same easing and lead as zoom, starting on the first click and leaving only after the previous press is released. It is constrained to keep the clicked element's box inside the window from press to release. Pure and unit-tested, including the guarantee.
- Compositor: lays out the window in place of the recording, before padding and backdrop, and keeps the zoom's view inside it.
- Minimal control: the take editor's Shape select now sets the ratio (and 4:3 fits the whole recording).

**Tests:** a randomized guarantee test, and the same check over a real take's events in `test:recorder` (no clicked box is ever outside the window while pressed); 9:16 composite pixels on the synthetic take.
**Done when:** the clicked element is never cropped out of the frame.

**Notes:** the window follows clicked elements rather than the zoom's own target, because the zoom's follow logic can keep a click inside a view wider than a narrow crop and still crop it out; the zoom then magnifies inside the window. `RATIOS` moved from `core/presets.ts` to `core/take.ts`.

### PR 9 · Export jobs with several outputs: GIF, poster, ratios
**Status:** 🔵 [#26](https://github.com/jaymalve/clipmunk/pull/26) · **Branch:** `studio/09-outputs` · **Base:** `studio/08-reframe`

- An export job takes `{ clip, ratios?, variants?, formats: ("mp4" | "gif" | "poster")[], size?, fps?, preset?, posterAtMs? }` and produces one file per combination (`export/job.ts`). The names are `<clip>[.<ratio>][.<variant>].<ext>` in `.clipmunk/exports/` (ratios written `9x16`), with no overwriting (section 12.4). The MP4 of each ratio is rendered once; GIF and poster come from it. Everything is published at the end, so a failed or cancelled job writes nothing.
- GIF: FFmpeg palettegen and paletteuse, 720p, 15 fps by default. When a GIF would exceed 5 MB (`gifMaxBytes`), step down the frame rate and then the size until it fits, and report what was chosen.
- Poster: a PNG at the first click (takes, after pacing), the first key moment (scenes), the start (sequences), or a chosen time.
- Ratios reframe takes through the page bridge (`encode({ ratio })` renders a reframed copy). Scenes and sequences refuse ratios until variants (PR 10); `variants` is accepted by the schema and refused for now.
- Job progress counts every step of every output; cancelling stops the browser and FFmpeg. `POST /v1/exports` accepts the new shape (a body with `clip`), and the old shape still works. CLI: `--format mp4,gif,poster --ratio 16:9,9:16 --preset name --poster-at ms`.
- Presets' `export` options (PR 3) now apply, through `preset`.

**Tests:** `test:export` (names and no overwriting, GIF header and size cap with what it chose, poster PNG size and time, cancellation of a multi-output job publishing nothing, refused ratios and presets); in `test:take` a take in two ratios with matching frame counts, and a 10 s take as MP4, GIF and poster in one job through the daemon.
**Done when:** a 10 s take exports as MP4, a GIF under 5 MB and a poster in one job.

**Notes:** `EXPORT_FORMATS` moved from `core/presets.ts` to `core/export.ts`. The studio's export panel still makes one MP4; choosing formats there belongs to the Studio PRs.

### PR 10 · Scene variants: theme, locale, ratio
**Status:** 🔵 [#27](https://github.com/jaymalve/clipmunk/pull/27) · **Branch:** `studio/10-scene-variants` · **Base:** `studio/09-outputs`

**Goal:** one scene, many files (section 19.2).

- `useSceneVariant()` from `clipmunk` returns `{ theme?, locale?, ratio? }` (`ratio` absent for the authored shape). The scene component passes it to the host's own providers (`<ThemeProvider theme={variant.theme}>`). Clipmunk never knows how the host does theming.
- The recipe gains optional `variants: { ratios?: { "9:16": { width, height, camera? } } }`. A ratio variant renders at its own frame size, and may move the camera (only the fields given); the component can read `ratio` to lay out differently. A ratio with no entry is fitted, not reflowed (`variantFrame`).
- Variant values come from the config's `variants` and reach the page in the scene URL (`clipmunk-variant=theme:dark,locale:de,ratio:9x16`). Export renders each combination with the existing scene exporter (`exportScene({ variant })`, and `variants` and `ratios` in export jobs, named `<scene>.<ratio>.<variant>.mp4`). CLI: `--variant light,dark`.
- The guide teaches agents to wire `useSceneVariant` into the host's providers, with the example app's `themed-card` scene as the tested example.
- Minimal control in the current scene player: a variant select (themes and locales from the config, times the ratios), kept in the page address.

**Tests:** the example app gets a theme provider and a `themed-card` scene; `test:export` renders light and dark in 16:9 and 9:16 and checks the backgrounds differ, the sizes and the frame counts match; `test:browser` checks the URL's variant reaches the scene and the select switches it; unit tests for parsing, frames and the recipe.
**Done when:** `themes: ["light","dark"]` with `ratios: ["16:9","9:16"]` yields four files with matching timing.

**Notes:** `CameraSchema.partial()` would have filled every camera field with its default, so a ratio's camera overrode the scene's perspective; `partialOf` (moved to `core/partial.ts`) keeps only what is given. `RATIOS` moved to `core/ratio.ts` to break an import cycle (`take` → `recipe` → `variants` → `take`). The `test:browser` library test expected exactly three scenes and failed on the base branch since the launch scenes were added; it now checks for the ones it opens.

---

## Part 2: Studio

### PR 11 · The frame page in the host
**Status:** 🔵 [#28](https://github.com/jaymalve/clipmunk/pull/28) · **Branch:** `studio/11-frame-page` · **Base:** `studio/10-scene-variants`

**Goal:** the host renders a bare, drivable scene for the Studio's iframe and for export (section 19.1).

- `clipmunk/studio` gains `ClipmunkFrame`: with `?clipmunk-frame&clipmunk-scene=<id>`, it renders only the scene (the scene player's new bare mode), fitted to the window, with no chrome, installs the bridge, and runs the message protocol (`studio/frame-agent.ts`, after the spike's): `seek` (latest wins, with a reply once the frame is drawn), `play` and `pause` (the frame owns the clock and reports `tick`, then `stopped`), `pick` (hover outline, click replies with `el` as in PR 4 plus a rect in scene pixels), `variant`, `narrate`, and `ready`, re-sent after hot reloads and variant changes. Messages are accepted only from loopback origins on the daemon's port, and replies go only there.
- Generated adapters (`Studio.tsx` for Vite and React, the Next route) render `ClipmunkFrame` for `?clipmunk-frame`. `init` and now `sync` upgrade unedited generated files through the existing hash ownership record; edited ones get a repair message.
- Scene export and snapshots open the frame page instead of `?clipmunk=1`.
- Narration and music preview run in the frame (the bare player keeps those hooks). The Studio's iframe will need `allow="autoplay; microphone"` (PR 12).

**Tests:** a Playwright test drives the frame through `postMessage` from a parent on the daemon's origin (ready, seek replies and the latest-wins burst, playback ticks and pause, pick, variant, and silence towards any other origin); the export suites pass on the frame page; `test:installed` for Vite and Next; `sync` upgrades an old adapter and leaves an edited one alone.
**Done when:** every existing scene exports identically from the frame page (byte-identical PNG frames at sampled times compared with today's page).

**Notes:** Chrome's local network access checks block a Playwright-fulfilled parent page from framing a loopback page, so the frame test launches Chromium with that check off; the daemon-served Studio is itself on loopback. The example app's `Studio.tsx` is Biome-formatted, so it differs from the template and `sync` reports it as edited there.

### PR 12 · The daemon serves the Studio (parity)
**Status:** 🔵 [#29](https://github.com/jaymalve/clipmunk/pull/29) · **Branch:** `studio/12-studio-app` · **Base:** `studio/11-frame-page`

**Goal:** a standalone Studio at `http://127.0.0.1:4747/` that does everything today's does. No new design yet.

- A new browser build, `dist/studio-app/`, a static single-page app (`src/studio-app`) built by `scripts/studio-app.mjs`, which `scripts/build.mjs` calls. It reuses `src/studio` components. Import boundaries: the app may import `studio`, `core`, `compositor`, `bridge`, `react` and `recorder` (where the daemon client lives).
- Daemon: unauthenticated `GET` for the app's static files only (`daemon/studio.ts`), with `Content-Security-Policy: frame-ancestors 'none'`, and everything under `/v1` still needs the token. `GET /v1/status` adds the host's `devUrl` and `studioPath` from `project.json`. A new `GET /v1/events` is one server-sent-events stream (`daemon/events.ts`): take recorded, edit changed (takes, scenes, sequences), config changed (a file watcher), job progress. `GET /v1/scenes?detail=1` gives the recipes. An export started from the Studio renders from the project's `devUrl`.
- `clipmunk dev` prints the Studio link `http://127.0.0.1:4747/#clipmunk-daemon=<port>.<token>`, and the in-app link once for recording.
- Screens at parity: library, the scene player (an iframe of the frame page, with play, scrub, variant, narration, music and export in the Studio), the take editor (in the Studio itself), the sequence builder, and the export panel.
- When the host dev server is not answering, scene previews say so with the command to start it; takes, sequences and export keep working.

**Tests:** a new `tests/studio` suite (`npm run test:studio`) builds the app, opens the daemon-served Studio and repeats today's studio checks (list, open a scene in its frame, scrub, export; edit a take and save; build a sequence; the host-down message); the guard tests (static files without a token, `/v1` refused without one, the wrong Host refused, framing refused, no files from outside the app) and the event stream.
**Done when:** every flow of the in-app Studio works in the standalone one, and the in-app Studio still works.

**Notes:** Vitest sets `NODE_ENV=test`, which made the React plugin emit development JSX into the production bundle; `buildStudioApp` forces production while it builds.

### PR 13 · Switch over to the standalone Studio
**Status:** 🔵 [#30](https://github.com/jaymalve/clipmunk/pull/30) · **Branch:** `studio/13-switch-over` · **Base:** `studio/12-studio-app`

- `?clipmunk=1` in the host shows a one-line page linking to the standalone Studio, or forwards to it (keeping the clip in the address) when a running daemon is known. The in-app screens are removed from the host bundle: `clipmunk/studio` no longer reaches the library, take editor or sequence builder; the adapter keeps only the frame page, the hand-off and the recorder boot.
- Take export opens the take editor in the private daemon's own Studio, not on the host's dev server (section 12.2), so takes export without the host running. The take request's `url`, and the job's, are optional now.
- The recorder HUD says "Open in Studio" after a take is saved, linking to the daemon's Studio; it also declines to record on the frame page. `clipmunk open` opens the daemon's Studio.
- `CLIPMUNK.md`, the guide, the README and `ARCHITECTURE.md` sections 10, 12.2, 13 and 14 describe the new arrangement.

**Tests:** `test:installed` (Vite and Next): `init`, scene export through the frame page, the production build still contains no Clipmunk code, and the Studio opens from `clipmunk dev`; take export with the host dev server stopped (`test:studio`). The take, sequence and recorder suites now drive the daemon-served Studio, and the browser suite the frame page; a Vitest global setup builds the Studio once (cached until a source changes) and points the daemon at it with `CLIPMUNK_STUDIO_DIR`.
**Done when:** a fresh install goes from `init` to an exported scene and an exported take using only the standalone Studio.

**Notes:** the plain-React host is covered by the project unit tests, not `test:installed`, which only has Vite and Next hosts. The PR 11 comparison against the in-app page cannot run once that page is gone; the export suite now checks that two separately opened frame pages capture identically.

### PR 14 · Library screen
**Status:** ⬜ · **Branch:** `studio/14-library` · **Base:** `studio/13-switch-over`

**Goal:** the "Library, clips and exports" artboard.

- Clip grid with kind filters (all, takes, scenes, sequences), duration, size, ratio and theme summary, live thumbnails for scenes (a small frame page) and posters for takes. Search by name.
- Status badges: rendering with progress (from `/v1/events`), and "stale" reserved for PR 21. The spec's "In PR #312" and "In changelog v2.4" have no data source and are left out unless one is designed.
- Export panel: ratios and themes as toggles, formats with checkboxes, the file count ("2 ratios × 2 themes = 4 files"), and a queue of outputs with per-file progress. "Files land in .clipmunk/exports. Nothing is uploaded." "Post to PR" is reserved for PR 22.
- "New scene" opens a short dialog that tells the developer to ask their agent, with a copyable prompt. Clipmunk does not write scenes itself.

**Tests:** `tests/studio`: filters, a multi-output export from the panel, the queue updating.
**Done when:** it matches the artboard apart from the reserved parts, with real data.

### PR 15 · Editor screen: timeline, inspector, undo
**Status:** ⬜ · **Branch:** `studio/15-editor` · **Base:** `studio/14-library`

**Goal:** the "Studio editing a take" artboard.

- A left rail of takes, scenes and sequences. A preview with "Preview as" ratio and theme. For takes the ratio comes from reframing; for scenes the frame page is resized, with a second live frame shown on request.
- Timeline tracks: take (kept, trimmed and sped-up spans), cursor clicks, zoom segments, captions, redaction, music with its accents. Drag to trim, select a segment to inspect it.
- Inspector for the selected thing: a zoom keyframe (target selector, scale, easing), redaction entries with "Pick an element to hide" (the frame picker for scenes, a drawn box for takes), frame (padding, corners, backdrop swatches from the brand), overlays (auto captions, keystrokes, face bubble).
- Undo and redo: the daemon keeps a history of each clip's edit revisions in `.clipmunk/history/` (ignored by git, capped). Undo restores the previous revision through the normal revision-checked save.
- The footer says which file every change is saved to.

**Tests:** `tests/studio`: editing each inspector field saves to `edit.json`; undo and redo; trim by drag; a pick in a scene frame fills a redaction selector.
**Done when:** it matches the artboard, and every control writes an edit file through the daemon.

### PR 16 · Presets in the Studio
**Status:** ⬜ · **Branch:** `studio/16-studio-presets` · **Base:** `studio/15-editor`

- A preset bar above the preview, with the config's presets and a one-line summary of each. Selecting one previews it at once and applies it to the edit on confirm.
- "Save current as preset": choose a name and the fields to include, then write to `clipmunk.config.json` (PR 3). A config change from disk updates the bar through `/v1/events`.

**Tests:** `tests/studio`: save, apply and preview; an external config edit appears without a reload.
**Done when:** the spec's check passes: "Save current as preset" writes back to the config with a minimal diff, and switching presets re-renders the preview within a second.

---

## Part 3: Agent

### PR 17 · `clipmunk mcp`
**Status:** ⬜ · **Branch:** `studio/17-mcp` · **Base:** `studio/16-studio-presets`

**Goal:** the developer's agent can see and change clips with tools (section 19.6).

- `clipmunk mcp` is a stdio MCP server. It reads `.clipmunk/daemon.json` to reach the running daemon, and says how to start it when none is running. Tools:
  - `list_clips()`: ids, kinds, durations, staleness once PR 21 lands.
  - `get_take(id)`: the edit, plus a readable event summary (time, route, action, element name, component once PR 20 lands).
  - `get_scene(id)`: the recipe and the component path.
  - `edit_take(id, patch, note)`: a JSON merge patch, validated, saved through the revision check; returns the diff.
  - `apply_preset(id, preset)`.
  - `preview(id, atMs, variant?)`: a PNG of the frame, rendered headless like `clipmunk snapshot`.
  - `export(id, options)`: a job id. `get_job(id)`: its progress.
- Every tool calls an existing daemon route. The MCP server has no logic of its own beyond formatting.
- `clipmunk init` prints the one-line command to add the server to Claude Code, Cursor and Codex. The guide describes the tools.

**Tests:** an MCP client in-process against a daemon on the example app: every tool, including a patch that fails validation and a stale revision.
**Done when:** an agent can trim, zoom and caption a take and check the result with `preview` without touching files by hand.

### PR 18 · Agent chat
**Status:** ⬜ · **Branch:** `studio/18-chat` · **Base:** `studio/17-mcp`

- Daemon: chat messages and proposals in `.clipmunk/chat/` (ignored by git), so a reload or a broken host loses nothing. Routes to post a message and list the history; events on `/v1/events`.
- MCP: `wait_for_chat(timeoutMs)` blocks until a message arrives (long poll) and returns it with its context. `reply_chat(text, proposal?)` answers; a proposal is an edit patch that is not yet applied.
- Studio panel: the connected agent's name, messages, context chips added by clicking the preview (a time, an element, a component), proposals shown as a diff with "Keep" and "Undo" (Undo goes through PR 15's history), suggested follow-ups, and a preview of the proposed edit.
- When no agent is waiting, the panel says so and shows the sentence to give the agent ("Watch the Clipmunk chat"). The guide tells agents to loop on `wait_for_chat`.

**Tests:** a scripted MCP client plays the agent: wait, receive, propose, Keep and Undo from the Studio; history survives a daemon restart.
**Done when:** the spec's check passes: with Claude Code waiting, a developer can trim, zoom and caption a take from the chat with no copy and paste.

### PR 19 · Take to scene
**Status:** ⬜ · **Branch:** `studio/19-take-to-scene` · **Base:** `studio/18-chat`

- MCP: `get_take_frames(id, times)` returns still PNGs from the take's video at given times (defaults: each key moment). `check_scene(id)` validates a new scene and returns preview frames at matching moments, for side-by-side comparison.
- Guide: a section on reproducing a take as a scene. Map the event summary to components. Derive each state from scene time. Copy the take's timing, zoom targets and pointer path into the recipe. Use fixture data. Compare against the take's frames, and say what could not be reproduced.
- Studio: "Make a scene from this take" posts a chat message with the take attached.

**Tests:** guide example validity (as for the existing guide); the MCP tools against a real take.
**Done when:** with an agent waiting, the example app's take of the dashboard becomes a scene that previews close to the take, and the take is kept.

---

## Part 4: Freshness

### PR 20 · Source map and export manifest
**Status:** ⬜ · **Branch:** `studio/20-manifest` · **Base:** `studio/19-take-to-scene`

- Scenes: `project/imports.ts` scans the import graph of a scene component (static `import` and `export … from`, resolved like the host's bundler for relative paths and `tsconfig` paths). It uses the same kind of dependency-free scanner as `project/entry.ts`, and never runs code.
- Takes: `clipmunk/vite` (a Vite plugin) and a Next equivalent add `data-clipmunk-src="<file>"` to host elements in development only, and the recorder logs `el.src`. The production build is checked to contain no attribute.
- On every export, `.clipmunk/manifest.json` (committed) records per clip `{ files: { path: hash }, exportedAt, outputs }`.

**Tests:** the import scanner against fixtures (aliases, re-exports, cycles); the plugin in `test:installed`, including the production-build check.
**Done when:** exporting a scene and a take writes manifest entries listing the right source files.

### PR 21 · Stale detection
**Status:** ⬜ · **Branch:** `studio/21-stale` · **Base:** `studio/20-manifest`

- `core` and `project`: a clip is stale when a manifest file's current hash differs, or the file is gone. `clipmunk stale [--base <git ref>] [--json]` lists stale clips and the changed files. With `--base`, it compares against that ref's files through `git show`, so CI can ask what a PR changed.
- Daemon: staleness in `GET /v1/scenes` and `GET /v1/takes`, and an event when it changes, by watching manifest-listed files.
- Studio: the banner ("2 clips are out of date. <PlanCards /> and <UsageChart /> changed in a3f9c1."), badges, "Re-export" for stale scenes, and "Record again" for stale takes.
- MCP: `list_clips` reports staleness.

**Tests:** editing `PlanCards` in the example app marks the plans scene stale and nothing else; re-export clears it.
**Done when:** the spec's check passes for scenes, and stale takes are flagged.

### PR 22 · GitHub Action and posting to a PR
**Status:** ⬜ · **Branch:** `studio/22-action` · **Base:** `studio/21-stale`

- `action.yml` at the repository root, a composite action used as `jaymalve/clipmunk@v<version>`. On `pull_request` it installs, starts the host dev server with a command from the action's input, runs `clipmunk stale --base` against the base branch, re-exports stale scenes, uploads the files as workflow artifacts, and posts or updates one comment listing each clip, what changed, and stale takes to record again.
- How media reaches the comment (artifact links, commits to a branch, or something else) is decided at the start of this PR with the owner, because GitHub's API cannot attach a video to a comment. Record the decision under Decisions.
- Studio: "Post to PR" uses the same comment format through the developer's own `gh` CLI. It is the only thing that leaves the machine, and only when asked.

**Tests:** the comment formatter and the stale step on a fixture repository; a run on a real PR in this repository.
**Done when:** the spec's check passes: a PR touching a filmed component gets a clip comment with no manual step.

---

## Decisions

Decisions made while working through this plan, with the date. The architecture-level ones are in `ARCHITECTURE.md` section 19.

- 2026-10-25: the standalone Studio is served by the daemon, with scenes in an iframe of the host's frame page. The spike on `spike/studio` found no cost and no starvation.
- 2026-10-25: takes stay pixel recordings, and replay is not built. Variants are a scene feature; takes get ratios by reframing.
- 2026-10-25: configuration is `clipmunk.config.json`, not TypeScript.
- 2026-10-25: REST and server-sent events, no WebSocket unless a feature needs one.
- 2026-10-25: `redact` in the config is a list of selectors or `{ selectors, mode?, live? }`, so live masking and a default mode fit without a second key.

## Log

- 2026-10-25 · PR 0 opened as #17: plan and architecture direction.
- 2026-10-25 · PR 0 merged (#17). PR 1 is based on `main`.
- 2026-10-25 · PR 1 opened as #18: take edits in `edit.json`. For PR 2: brand defaults belong in `defaultEdit` at ingest (`daemon/takes.ts`, `finalizeTake`), because ingest now writes the edit file. Tests that touch the example app restore `.clipmunk/project.json` themselves; re-check `git diff` on it after a run.
- 2026-10-25 · PR 2 opened as #19, stacked on #18: `clipmunk.config.json` and brand at ingest. For PR 3: `presets` is currently `z.record(slug, z.record(string, unknown))` in `core/config.ts`; give it the real preset schema there. Writing the config must keep the developer's other keys and their order.
- 2026-10-25 · PR 3 opened as #20, stacked on #19: presets. For PR 4: the recorder can fetch the redaction selectors from `GET /v1/config` (`config.redact`); the CLI has no `config` command, `clipmunk doctor` is where config problems show. For PR 9: presets' `export` options (`size`, `fps`, `formats`, `ratios`) are validated but no export reads them yet.
- 2026-10-25 · PR 4 opened as #21, stacked on #20: event log v2 (`el` on `down` and `focus`, `route`, `combo`, `redact`). For PR 5: `redact` events carry `sel` and `rects` in CSS pixels, one event per selector, logged only when a box changes, so hold each box until the next event for that selector; empty `rects` means nothing to hide. A config the recorder cannot read means a take without redaction, noted in `recorder.log`.
- 2026-10-25 · PR 5 opened as #22, stacked on #21: redaction. For PR 6: captions and the keystroke overlay are drawn in `drawTake`, which now takes `redact` boxes in `TakeFrame`; draw overlays above the redaction layer so captions and keys stay readable. For PR 9: GIF and poster must render through `drawTake` to inherit redaction.
- 2026-10-25 · PR 6 opened as #23, stacked on #22: captions and key pills. For PR 7: captions and pills are on the take clock (`atMs`), so cutting dead air must shift or drop them through the same time map as the picture; `resolveCaptions` and `keyPills` are the places to apply it.
- 2026-10-25 · PR 7 opened as #24, stacked on #23: pacing and the time map. For PR 8: reframing crops follow the action on take time; build the crop path from the log and look it up at `timeMap.toTake(clipMs)` like every other overlay. For PR 9: GIF and poster frame times are clip times; use the renderer's `timeMap`, never `trim.startMs + t`.
- 2026-10-25 · PR 8 opened as #25, stacked on #24: reframing. For PR 9: rendering a take "in a ratio" means setting `edit.frame.ratio` (and the canvas from `ratioCanvas`) on a copy of the take for that output; the renderer does the rest.
- 2026-10-25 · PR 9 opened as #26, stacked on #25: export jobs. For PR 10: `exportJob` refuses `variants` and refuses `ratios` for scenes (`variants-unsupported`, `ratios-unsupported` in `export/job.ts`); lift both there, add the variant to the stem (`<clip>.<ratio>.<variant>`), and pass it to the scene exporter.
- 2026-10-25 · PR 10 opened as #27, stacked on #26: scene variants. The engine part is done. For PR 11: the frame page must read `clipmunk-variant` from its own URL and wrap the scene in `SceneVariantProvider`, exactly as `ScenePreview` does, and size the frame with `variantFrame`.
- 2026-10-25 · PR 11 opened as #28, stacked on #27: the frame page. For PR 12: frame the host page at `frameUrl(devUrl, studioPath, id)` plus the daemon link hash (`#clipmunk-daemon=<port>.<token>`); the frame trusts only loopback origins on that port. Post `{ cm: 1, type, … }` messages; the frame answers with `ready`, `frame`, `tick`, `stopped`, `picked` and `narration`.
- 2026-10-25 · PR 12 opened as #29, stacked on #28: the standalone Studio. For PR 13: take export still opens the take editor on the host's dev server (`export/take.ts`); point it at the daemon-served Studio (`?clipmunk=1&clipmunk-take=<id>` on the daemon's origin, with `studioDir` found as in `daemon/server.ts`).
- 2026-10-25 · PR 13 opened as #30, stacked on #29: switch-over. For PR 14: the library is `studio/Library.tsx`, used now only by `studio-app/StudioApp.tsx`; job progress for badges comes from `GET /v1/events` (`job` events), and multi-output exports go through `POST /v1/exports` with `{ clip, formats, ratios, variants }`.

## Environment notes for whoever picks this up

- FFmpeg: tests set `CLIPMUNK_FFMPEG` themselves. By hand, use an absolute path, for example `CLIPMUNK_FFMPEG=$PWD/node_modules/ffmpeg-static/ffmpeg`.
- `npm run test:recorder` needs a display and wraps `xvfb-run`.
- `npm run test:studio` builds the Studio app into a temporary folder first, which takes a few seconds. Every other Vitest run builds it once into `node_modules/.cache/clipmunk/studio-app` (only when a source changed) for the daemon to serve; set `CLIPMUNK_STUDIO_DIR` to use another build.
- On a machine without a GPU, depth-blur scenes take seconds per frame. Run long suites in the background with a log file.
- `scripts/check-installed.mjs` uses ports 5311 and 3111; an interrupted run can leave a server there that fails the next run with a misleading "scene did not open".
- `clipmunk export --url` stores that URL in `.clipmunk/project.json`. Restore it after testing against another port.
