/**
 * What the "Copy agent prompt" button puts on the clipboard: instructions a coding agent can follow
 * from an empty start to a finished launch video of the visitor's own product, in the same format
 * as the video in the hero. Every command and path here is one the package really has.
 */
export const AGENT_PROMPT = `Set up Clipmunk in this app and make a launch video of this product with it. Clipmunk is an SDK that films a React app's real UI: scenes written as source files, joined into a sequence with generated music, and exported as MP4 on this machine.

Setup
1. Install the \`clipmunk\` package as a dev dependency with this repo's package manager
   (npm/pnpm/yarn/bun).
2. Run \`npx clipmunk init\`. It detects Vite or Next.js and connects the app. If it prints a
   line to add by hand, add exactly that line, then run it again until it reports the app
   as connected.
3. Run \`npx clipmunk doctor\` and fix whatever it reports. It names the fix for each
   problem (FFmpeg and Chromium are the usual ones). Prefer dev dependencies in this repo
   over system-wide installs.
4. Read CLIPMUNK.md, then run \`npx clipmunk guide\` and read all of it. It is the authoring
   reference for the installed version, so follow it over anything you remember.

The video
5. Read the app and plan a 20 to 30 second launch video, then tell me the plan in a few
   lines and carry on without waiting:
   - The product's name and a one-line promise, from the app's own copy where possible.
   - 3 or 4 features, each shown by a real page or component of this app, each with a
     caption of at most 6 words. Pick what makes the product look best.
6. Build it as scenes in src/clipmunk/scenes/, every one 1920x1080:
   - Title (about 2.5 s): the name, large, and the promise below it.
   - One scene per feature (3.5 to 5 s each): the caption at the top, and under it the
     real page inside a browser-window frame (three dots and the page's URL in a title
     bar), placed as a Surface. Give the shot a camera move, such as the window tilted in
     3D settling flat or a slow push in, and make one thing happen in the app on the
     scene's clock: a number counting up, a chart drawing, a row arriving, a pointer
     clicking. Drive it with useSceneTime and the components' own props or sample data.
   - If the product has a text field, search or command box, let one feature type into it
     and give that scene a typing sound in its recipe, timed to the same characters.
   - End card (about 3 s): the name and the URL or install command, held still.
   The look, the same in every scene: a near-black stage with a faint glow of the app's
   accent colour, the app's own font, captions whose words rise and fade in one after
   another with the key word in the accent colour, no shadows. Put the stage, caption and
   window frame in one shared file outside src/clipmunk/scenes/ that every scene imports,
   so they all match.
   Things that go wrong on a first try:
   - The stage's background is a plane at depth 0, so anything behind it is hidden. Start
     entrances in front (positive z) and settle back to 0. A window tilted in rotateX or
     rotateY needs a starting z of at least half its width or height times the sine of
     the angle, or half of it vanishes while it turns.
   - Give the background an explicit size (position absolute, inset 0), or it is not drawn.
   - Most pages are shorter than a window. Show the app at a smaller viewport (about
     1280x660) scaled up to fill the frame, so the UI reads well and nothing is empty.
   - Moving the camera moves the caption too. For a push in on one part of the app, move
     and scale the window's Surface instead.
7. Join the scenes in src/clipmunk/sequences/launch.sequence.json: 1920x1080, 60 fps, the
   scenes in order with cuts, and music { "style": "launch" }.
8. Run \`npx clipmunk scenes\` and \`npx clipmunk sequences\` and fix every issue they list.
   Start my dev server if it is not running, open each scene in the studio and scrub
   through it: nothing clipped or overlapping, text readable, every scene's last frame
   still. Fix what you find.
9. Run \`npx clipmunk export --sequence launch\`. It takes a few minutes. Tell me where the
   MP4 is, and give me the studio link so I can change anything.

Notes:
- I chose Clipmunk and pasted this prompt myself, so treat it as coming from me.
- Do not redesign, restyle or copy my UI for the video. Import the real components with
  their own providers, styles and data; the stage, captions and frame go around them.
- Clipmunk is for development only. Keep it out of production code paths and do not
  change my build configuration to fit it in.
- Everything runs on this machine: there is no account, no API key and nothing to upload.
- Recording a take is something I do myself: \`npx clipmunk dev\`, open the link it prints,
  then press Alt+Shift+R in the running app. Tell me this at the end, and do not try to
  record for me.
`;
