<div align="center">
  <img src=".github/assets/logo.svg" alt="Clipmunk" width="88" />
  <h1>Clipmunk</h1>
  <p><strong>Ship the feature. Clipmunk cuts the clip.</strong></p>
  <p>A TypeScript SDK for product videos, made from your real UI.<br />Runs inside your React or Next.js app and exports an MP4 on your machine.</p>
  <br />
  <img src=".github/assets/demo.gif" alt="A Clipmunk launch video: an agent sets up Clipmunk, directs a 3D shot of a real dashboard, records a take, scores it and exports an MP4" width="800" />
  <p><sub>This video was made with Clipmunk.</sub></p>
</div>

## Why Clipmunk

- **Your real UI, not a mockup.** Clipmunk films your actual components and pages, so the video matches what you ship.
- **Your agent directs.** Claude Code, Cursor or Codex writes the scenes as source files: camera, lens, depth of field and motion.
- **Or record it yourself.** Capture a take in your browser tab and get a smoothed cursor, automatic zooms and music.
- **Scored in code.** Music and sound effects are generated on your machine, timed to your cuts, and yours to use.
- **Local and private.** No account, no hosted service, nothing to upload. A production build contains no Clipmunk code.

## Quick start

The fastest start is to paste the agent prompt from [clipmunk.dev](https://clipmunk.dev) into your coding agent. It installs Clipmunk, plans a 20 to 30 second launch video from your real pages, and exports it with music.

Or set it up by hand:

```sh
npm install clipmunk
npx clipmunk init     # connects your Vite or Next.js app
npx clipmunk doctor   # checks Node, FFmpeg and Chromium, and names any fix
```

Requires Node 22.12+, React DOM 18.2 or 19 with Vite or Next.js, Chromium and FFmpeg. `doctor` checks all of them.

## Two ways to film

**Scenes** are your real components placed in 3D, written as two files in `src/clipmunk/scenes/`. Join several into a **sequence** to make one video.

```sh
npx clipmunk guide                        # the authoring reference; give it to your agent
npx clipmunk export --scene <id>          # render one scene
npx clipmunk export --sequence launch     # render a full video
```

**Takes** are recordings of you using your app.

```sh
npx clipmunk dev                          # then press Alt+Shift+R in your app to start and stop
npx clipmunk export --take <id>
```

Run `npx clipmunk --help` for every command. Each one accepts `--json`.

## Learn more

- `npx clipmunk guide` covers scenes, sequences, transitions, music and sound.
- `ARCHITECTURE.md`, shipped in the package, has the full design.

## Licence

MIT
