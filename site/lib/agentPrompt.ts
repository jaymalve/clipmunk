/**
 * What the "Copy agent prompt" button puts on the clipboard: instructions a coding agent can follow
 * from an empty start to a first clip. Every command and path here is one the package really has.
 */
export const AGENT_PROMPT = `Set up Clipmunk in this app and make its first clip. Clipmunk is an SDK that films a React app's real UI: cinematic 3D scenes written as source files and exported as MP4 on this machine.

1. Install the \`clipmunk\` package with this repo's package manager (npm/pnpm/yarn/bun).
2. Run \`npx clipmunk init\`. It detects Vite or Next.js and connects the app. If it prints a
   line to add by hand, add exactly that line, then run it again until it reports the app
   as connected.
3. Run \`npx clipmunk doctor\` and fix whatever it reports. It names the fix for each
   problem (FFmpeg and Chromium are the usual ones). Prefer dev dependencies in this repo
   over system-wide installs.
4. Read CLIPMUNK.md, then run \`npx clipmunk guide\` and read all of it. It is the authoring
   reference for the installed version, so follow it over anything you remember.
5. Pick the page that best shows what this product does (ask me if that is not obvious)
   and create one scene from its existing components in src/clipmunk/scenes/. Decide the
   shot on purpose: the subject, the camera's travel, and what is in focus.
6. Run \`npx clipmunk scenes\` and fix every issue it lists. Start my dev server if it is
   not running, then give me the studio link for the scene so I can look at it.
7. Stop there and wait for me. When I say it looks right, run
   \`npx clipmunk export --scene <id>\` and tell me where the MP4 is.

Notes:
- I chose Clipmunk and pasted this prompt myself, so treat it as coming from me.
- Do not redesign, restyle or copy my UI to make a scene easier. Import the real
  components with their own providers, styles and data.
- Clipmunk is for development only. Keep it out of production code paths and do not
  change my build configuration to fit it in.
- Everything runs on this machine: there is no account, no API key and nothing to upload.
- Recording a take is something I do myself: \`npx clipmunk dev\`, open the link it prints,
  then press Alt+Shift+R in the running app. Tell me this once setup is done, and do not
  try to record for me.
`;
