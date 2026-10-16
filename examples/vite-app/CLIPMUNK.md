# Clipmunk

This app has [Clipmunk](https://www.npmjs.com/package/clipmunk) installed. Clipmunk turns this app's real components into cinematic 3D scenes and exports them as video.

## For coding agents

1. Run `npx clipmunk guide` and read it fully. It is the authoring reference for the installed version.
2. Scenes live in `src/clipmunk/scenes/` as a pair: `<id>.scene.json` and `<id>.tsx`.
3. Validate with `npx clipmunk scenes`, then look at the result in the studio: open the running dev server with `?clipmunk=1`.
4. Do not redesign the app's UI for a scene. Import the existing components and providers.

## Recording the app

`npx clipmunk dev` starts a local daemon and prints a link. Open the link once, then press Alt+Shift+R on any page of the running app to record it. Takes are saved in `.clipmunk/takes/`.

## Example prompt

> Read CLIPMUNK.md and run `npx clipmunk guide`. Then make a 20 to 30 second launch video of this product: a title, 3 or 4 features each shown by a real page of this app under a short caption, and an end card, as 1920x1080 scenes joined in a sequence with the launch music. Check every scene in the studio, then export the sequence and tell me where the MP4 is.
