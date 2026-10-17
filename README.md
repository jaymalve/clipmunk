# Clipmunk

A TypeScript SDK for product videos. Clipmunk lives inside your React or Next.js app and films its real UI, then exports an MP4 on your own machine. There is no account, no hosted service and nothing to upload.

The fastest start is a launch video of your own product: paste the agent prompt from [clipmunk.dev](https://clipmunk.dev) into Claude Code, Cursor or Codex. Your agent installs Clipmunk, plans a 20 to 30 second video from your real pages (a title, three or four features, an end card), writes the scenes, and exports it with generated music. The demo video on the site was made with Clipmunk too.

Clipmunk films your app two ways:

- **Scenes.** Your real components placed in 3D, with a camera, a lens and depth of field, written as source files. A coding agent can write them for you. Join several into a **sequence** to make one video.
- **Takes.** A recording of you using your app in a browser tab, finished with a smoothed cursor, automatic zooms, an optional camera bubble and generated music.

Site: [clipmunk.dev](https://clipmunk.dev)

## Requirements

- Node 22.12 or newer
- React DOM 18.2 or 19, with Vite or Next.js
- Chromium, for recording and export (the `playwright` package provides one for export)
- FFmpeg, on your `PATH` or from the `ffmpeg-static` package

`npx clipmunk doctor` checks all of these and names the fix for anything missing.

## Start

```sh
npm install clipmunk
npx clipmunk init
npx clipmunk doctor
```

`init` detects Vite or Next.js and connects the app. If it cannot edit your entry file safely, it prints the one line to add by hand. It also writes `CLIPMUNK.md`, a short pointer for coding agents.

## Make a scene

A scene is two files in `src/clipmunk/scenes/`: `<id>.scene.json` (camera, focus, motion) and `<id>.tsx` (your components wrapped in `Surface`).

```sh
npx clipmunk guide                 # the authoring reference; give this to your agent
npx clipmunk scenes                # validate what was written
npx clipmunk export --scene <id>   # render an MP4
```

To look at a scene before exporting, open your running dev server with `?clipmunk=1`.

## Make a launch video

A sequence joins scenes (and takes) into one video. It is a JSON file in `src/clipmunk/sequences/`:

```json
{
  "version": 1,
  "id": "launch",
  "title": "Launch video",
  "width": 1920,
  "height": 1080,
  "fps": 60,
  "items": [
    { "clip": { "kind": "scene", "id": "title" } },
    { "clip": { "kind": "scene", "id": "dashboard" }, "transition": { "kind": "cut" } },
    { "clip": { "kind": "scene", "id": "end-card" }, "transition": { "kind": "cut" } }
  ],
  "music": { "style": "launch" }
}
```

```sh
npx clipmunk sequences                 # validate it
npx clipmunk export --sequence launch  # render the MP4
```

The music is generated in code, timed to the cuts. Styles: `launch` (half-time drums and rolling hi-hats that drop on an early moment and land the ending on the beat), `upbeat` and `lofi`. A scene that types text can add key clicks in its recipe: `"sounds": [{ "kind": "typing", "atMs": 400, "chars": 52, "perSecond": 46, "enter": true }]`.

## Record a take

```sh
npx clipmunk dev
```

Open the link it prints once, then press `Alt+Shift+R` on any page of your running app. Press it again to stop. Takes are saved in `.clipmunk/takes/`.

```sh
npx clipmunk takes                 # list recordings
npx clipmunk export --take <id>    # render an MP4
```

## Commands

| Command | What it does |
|---|---|
| `init` | Connect this app to Clipmunk |
| `doctor` | Check Node, FFmpeg, Chromium and the project |
| `guide` | Print the scene authoring guide |
| `scenes`, `takes`, `sequences` | List what exists, with validation issues |
| `dev` | Start the local daemon for recording and studio exports |
| `open` | Open the studio in your browser |
| `snapshot --scene <id>` | Save a thumbnail into the scene's recipe |
| `zoom <take>` | Show a take's automatic zooms, or store them for hand editing |
| `music <launch\|upbeat\|lofi>` | Write a sample of the generated music |
| `export` | Render a scene, a take or a sequence to MP4 |

Every command accepts `--json`.

## Good to know

- Clipmunk is a development tool. A production build renders your app unchanged and contains no Clipmunk code.
- Recording covers your app's own tab, in Chromium. It does not capture the desktop.
- Depth of field is a Gaussian approximation in the DOM, not ray-traced bokeh.
- The music and sound effects are generated in code on your machine, so they are yours to use.

`ARCHITECTURE.md`, shipped in the package, is the full design.

## Licence

MIT
