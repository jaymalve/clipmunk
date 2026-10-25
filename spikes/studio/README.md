# Spike: standalone Studio (throwaway)

Question: can the Studio move out of the host app into its own page (an iframe of the app for
scenes) without breaking scene preview, takes, export, the picker or hot reload?

## Parts

- `host.config.ts` runs `examples/vite-app` on :5180 with `frame-agent.ts` injected. No product code changes.
- `frame-agent.ts` is active only when the page is framed with `clipmunk-frame`. It talks to the
  existing capture bridge (`window.__CLIPMUNK__`), the same one export uses: seek (latest wins),
  playback inside the frame, an element picker.
- `shell.config.ts` + `shell/` is the Studio on its own origin (:4800). Scenes go in iframes; takes
  mount the real `TakeEditor` from `src/studio` directly.
- `measure.mjs` compares the in-app page and the iframe, both at the scene's own size.

## Run

```
npm install && npm run build        # the runner starts the daemon from dist/
node spikes/studio/run.mjs          # the two open questions: page-survey, headed, DPR 2
```

`run.mjs` starts the host app (:5180), the shell (:4800) and a daemon on a free port, runs
`measure.mjs`, writes `results-<LABEL>-<SCENE>.json` and stops everything. Options as env vars:
`SCENE`, `ONLY` (scrub, play, pair, pixels, picker, take, hmr), `DPR`, `HEADED` (empty for headless),
`CHANNEL=chrome` (your installed Chrome instead of Playwright's Chromium), `PAIR=700x490`, `LABEL`.

## Results on the server (2 cores, no GPU, headless), 2026-10-25

| Check | rack-focus (1000x600) | page-survey (1400x980, depth blur) |
|---|---|---|
| Pixels, iframe vs in-app, 4 times | identical (0 px differ) | identical (0 px differ) |
| Scrub, mean per seek | 16.4 vs 16.5 ms (vsync bound) | 1698 vs 1859 ms (CPU rendering) |
| Fast drag, 60 seeks at 4 ms | final frame in 22 ms, 58 dropped | final frame in 3.7 s |
| Playback fps, in-app / iframe | 60 / 61 | 1.3 / 0.8 |
| Two iframes side by side, 700x490, both on screen | 60.7 + 60.7 (in-app 60.5) | not run |

- Picker across origins: works; returns selector, text and rect in scene pixels. Selectors are crude.
- Frame permissions with `allow="autoplay; microphone; camera"`: all allowed, so narration and music can run in the frame.
- Takes: the real TakeEditor runs on the shell's origin; video, zoom, cursor and camera draw; the take bridge (with `encode`) installs.
- Daemon: accepts the new origin with no change (loopback Origin + token).
- Hot reload: editing the recipe updated the frame (1500 → 3000 ms) and re-announced it; the Studio did not reload.
- Export through the agent-injected host: unchanged, 90 frames written.

The heavy-scene timings are not meaningful here (software rendering at ~1.7 s/frame); rerun on the Mac.
Open on the Mac: depth-scene scrub overhead, and whether a second live iframe starves. (An earlier run
stacked two 980 px frames with the second partly off screen and got 0.5 + 0 fps; the `pair` check now keeps
both fully on screen.)
