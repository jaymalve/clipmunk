# Flick

This app has [Flick](https://www.npmjs.com/package/@flickjs/record) installed. Flick turns this app's real components into cinematic 3D scenes and exports them as video.

## For coding agents

1. Run `npx flick guide` and read it fully. It is the authoring reference for the installed version.
2. Scenes live in `src/flick/scenes/` as a pair: `<id>.scene.json` and `<id>.tsx`.
3. Validate with `npx flick scenes`, then look at the result in the studio: open the running dev server with `?flick=1`.
4. Do not redesign the app's UI for a scene. Import the existing components and providers.

## Recording the app

`npx flick dev` starts a local daemon and prints a link. Open the link once, then press Alt+Shift+R on any page of the running app to record it. Takes are saved in `.flick/takes/`.

## Example prompt

> Read FLICK.md and run `npx flick guide`. Inspect this app's dashboard page and create a cinematic Flick scene from its existing components. Choose a close perspective, camera travel and depth of field on purpose. Verify it in the studio, save a snapshot, and give me the scene URL.
