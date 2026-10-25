import { CONFIG_FILE, STARTER_CONFIG } from "./config";
import { EXPORT_FPS } from "./export";
import { EASINGS, MotionSchema, SceneTrackSchema } from "./motion";
import { MUSIC_STYLES } from "./music";
import { PRESET_FIELDS } from "./presets";
import { FRAME_PARAM, HANDOFF_FILE, PACKAGE_NAME, SCENE_PARAM, SCENES_DIR } from "./project";
import { type SceneRecipe, SceneRecipeSchema } from "./recipe";
import { DEFAULT_CAMERA, DEFAULT_FOCUS, DEFAULT_TRANSFORM, SCENE_BACKGROUND } from "./scene";
import { SEQUENCES_DIR, SequenceSchema } from "./sequence";

/** The authoring guide a coding agent reads before composing a scene.
 * Defaults, property lists and the example are derived from the schemas, so the
 * guide cannot drift from what the validator accepts. Concepts explain choices and
 * trade-offs; they never prescribe one shot.
 */
export type GuideConcept = { id: string; title: string; idea: string; how: string; avoid: string; check: string };

const concepts: GuideConcept[] = [
  {
    id: "material",
    title: "The real UI is the material",
    idea: "A scene shows the app's own components in 3D space on a black stage. It should read as a camera looking at the real product, not as a redesign or a slideshow of floating cards.",
    how: `Each scene is two files in ${SCENES_DIR}: <id>.scene.json (camera, focus, nodes, motion) and <id>.tsx (a default-exported component returning Surface elements whose ids match the nodes). Import the host's existing components and wrap them in the providers they need. The studio supplies Scene and playback; the component never renders Scene itself.`,
    avoid:
      "Do not recreate or restyle host UI to make it easier to animate. Do not copy fetch logic; reuse the host's providers and data. Do not duplicate a subtree to fake depth.",
    check: "Compare the scene with the normal page: same styling, same content, one live instance of each component.",
  },
  {
    id: "camera",
    title: "Compose the camera first",
    idea: "Perspective and viewpoint create the cinematic feel. A close, oblique view of a large surface, with one edge near and the opposite edge receding, reads as a camera move. A small centred panel sliding around does not.",
    how: "Units are pixels and degrees: +x right, +y down, +z toward the viewer. camera.x/y/z are subtracted from scene positions, so raising camera.z pushes everything away and lowering it moves in. camera.rotateX/Y/Z rotate the whole stage. camera.perspective is the distance to the projection plane and cannot be animated. Hold the angle steady and translate the camera along the surface for a survey; several camera tracks that share timing form one diagonal rail.",
    avoid:
      "Arbitrary spins, competing rotations and oscillation hide the product. Anything that reaches z >= perspective crosses the camera plane and is reported as an error.",
    check:
      "Scrub the start, middle and end. The subject stays readable, nothing flips or clips, and the move serves the reveal.",
  },
  {
    id: "focus",
    title: "Depth of field belongs to the camera",
    idea: "The camera focuses at one distance along its viewing axis. Everything at that depth is sharp wherever it is on screen; nearer and farther content softens progressively.",
    how: "A point's depth is perspective minus its camera-space z. Set focus.distance to the depth of the subject. Lower fStop for a shallower, more dramatic focus; raise it for gentler blur. maxBlur caps the blur radius in pixels. Animate focus.distance for a rack focus. A tilted surface gets a continuous sharp-to-soft gradient automatically.",
    avoid:
      "Blurring the whole subject. Reach for fStop before raising maxBlur. This is a Gaussian approximation in the DOM, not ray-traced bokeh.",
    check:
      "Open the scene and confirm the intended subject is the sharp part. If the whole surface is soft, focus.distance does not match its depth.",
  },
  {
    id: "depth",
    title: "Depth makes layers relate",
    idea: "Parallax is near and far content moving differently as the viewpoint changes. Separating meaningful sections in z and letting them settle into place shows how the page is built.",
    how: "Wrap meaningful existing subtrees in their own Surface, nested inside a parent Surface. Children inherit the parent's transform and start where CSS laid them out. Animate each child's z (and opacity if wanted) to its resting value of 0 with staggered keyframes. A Surface that contains other Surfaces is a group: put its own background in the `content` prop.",
    avoid:
      "Splitting every element, or separating layers so far that the page stops reading as one thing. Loose text or media directly inside a group cannot be blurred and is reported. A group's content (its background) is a plane at the group's own z: a child behind it, at negative z, is hidden by it, so start entrances in front (positive z) and settle back to 0. A child tilted by rotateX or rotateY swings half of itself behind that plane unless its z clears the tilt: at least half its width (or height) times the sine of the angle.",
    check:
      "At several times the layers visibly change their relative positions, then resolve into the original layout.",
  },
  {
    id: "timing",
    title: "Timing gives weight",
    idea: "Slow, eased movement that settles deliberately feels like a camera. Abrupt or linear movement feels like a UI transition.",
    how: `Each keyframe is { timeMs, value, easing }. easing applies to the segment that starts at that keyframe and defaults to "cinematic" (zero velocity and acceleration at both ends); the others are ${EASINGS.filter((easing) => easing !== "cinematic").join(" and ")}. A track holds its first and last value outside its keyframes, so a delayed entrance repeats the starting value at its start time. motion.speed scales authored time; durationMs / speed is the playback length.`,
    avoid:
      "Many keyframes on a camera track: every cinematic segment comes to rest, so a continuous move should be one segment. Host CSS animations run on wall-clock time and are frozen in export.",
    check: "Play at normal size. Look for sudden velocity changes and needless pauses.",
  },
  {
    id: "live",
    title: "Animating host components with the scene",
    idea: "A chart or counter can animate in step with the camera when it reads scene time instead of a timer.",
    how: `import { useSceneTime } from "${PACKAGE_NAME}" inside a component rendered within a Surface. It returns authored milliseconds; derive a progress value and pass it to an existing prop of the host component.`,
    avoid: "setTimeout, requestAnimationFrame or CSS animations for anything that must appear in the exported video.",
    check: "Scrubbing the timeline moves the host animation with it.",
  },
  {
    id: "delivery",
    title: "Look before exporting",
    idea: "A scene is finished when its rendered frames communicate the intended reveal, not when its JSON validates.",
    how: `Open the Studio (the link clipmunk dev prints, or clipmunk open --scene <id>) with the dev server running and select the scene. It shows the scene from the dev server's frame page (?${FRAME_PARAM}=1&${SCENE_PARAM}=<id>, which you can also open directly). Edit the two files; the dev server hot-reloads them and the frame lists any issue with a fix. Save a thumbnail with clipmunk snapshot. Export only when asked.`,
    avoid: "Reporting success from a typecheck alone. Validation cannot judge framing or readability.",
    check: "No issues listed in the studio, several frames inspected, snapshot saved.",
  },
];

const example: SceneRecipe = SceneRecipeSchema.parse({
  version: 1,
  id: "page-survey",
  title: "Page survey",
  description: "A close oblique pass across one page with a shallow focus plane.",
  definition: {
    width: 1400,
    height: 980,
    scene: {
      camera: { perspective: 1400, rotateY: -26, rotateX: 10, z: -150 },
      focus: { distance: 1150, fStop: 1.6, focalLength: 100, maxBlur: 7 },
      nodes: [{ id: "page" }],
    },
    motion: {
      durationMs: 7000,
      tracks: [
        {
          target: { kind: "camera" },
          property: "x",
          keyframes: [
            { timeMs: 0, value: -360 },
            { timeMs: 7000, value: 300 },
          ],
        },
        {
          target: { kind: "camera" },
          property: "y",
          keyframes: [
            { timeMs: 0, value: -120 },
            { timeMs: 7000, value: 90 },
          ],
        },
      ],
    },
  },
});

const exampleComponent = `import { Surface } from "${PACKAGE_NAME}";
// Replace with the host app's real page component and the providers it needs.
import { Dashboard } from "../../components/dashboard";

export default function PageSurvey() {
  return (
    <Surface id="page" style={{ width: 1400, height: 980 }}>
      <Dashboard />
    </Surface>
  );
}
`;

export function getGuide() {
  return {
    version: 1 as const,
    package: PACKAGE_NAME,
    purpose: "Compose cinematic 3D shots from an app's existing live UI, as source files, and export them as video.",
    freedom:
      "Concepts describe effects and trade-offs. No camera angle, path, layer count or timing is mandatory, and the user's direction overrides every default here. Only the schemas are binding.",
    stage: { background: SCENE_BACKGROUND, note: "The stage is always black. Host UI keeps its own theme." },
    concepts,
    workflow: [
      `Read ${HANDOFF_FILE}, then this guide. Inspect the requested page: its components, providers, styles and data.`,
      "Decide the shot before writing: the subject, which edge is near, the camera's travel direction, what is in focus, and what gives depth.",
      `Create ${SCENES_DIR}/<id>.scene.json and ${SCENES_DIR}/<id>.tsx. The id is a lowercase slug and equals the file name.`,
      "Run clipmunk scenes to validate. Fix every issue it lists.",
      `Open the scene in the Studio (clipmunk open --scene <id>), or its frame page (?${FRAME_PARAM}=1&${SCENE_PARAM}=<id>) on the running dev server, and look at the opening frame before tuning motion.`,
      "Scrub several times, adjust the source, repeat. Then run clipmunk snapshot --scene <id> to save its thumbnail.",
      "Export with clipmunk export --scene <id> only when the user asks for a video.",
    ],
    files: {
      directory: SCENES_DIR,
      recipe:
        "<id>.scene.json: { version: 1, id, title, description?, definition: { width?, height?, scene: { camera?, focus?, nodes: [{ id, parentId?, transform? }] }, motion?: { durationMs, speed?, tracks } } }. Unknown keys are rejected.",
      component:
        "<id>.tsx or <id>.jsx (one, not both): default-exports a component returning Surface elements. Surface props: id, transform?, content?, children, className?, style?. Give each Surface an explicit size through style when its content would otherwise stretch.",
      helpers: `Keep helper modules outside ${SCENES_DIR}; every .tsx there is treated as a scene component.`,
      sync: "Vite discovers new scene files automatically. In Next.js and other hosts run clipmunk sync after adding or removing a scene.",
    },
    config: {
      path: CONFIG_FILE,
      what: "Project-wide settings in one JSON file at the project root, shared through the repository. Every field is optional. Clipmunk reads it and never runs it.",
      shape:
        '{ version: 1, brand?: { backdrop?, padding?, radius?, logo?, outro? }, redact?: ["<css selector>"] | { selectors: [...], mode?: "blur" | "block", live?: boolean }, presets?: { <name>: {...} }, variants?: { themes?: ["light", "dark"], locales?: ["en", "de"] } }. Unknown keys are rejected.',
      brand:
        "backdrop is the colour behind a take's recording, padding the space around it in pixels on the frame's short side, radius its corner radius in pixels. A take gets the brand when it is recorded; changing the brand later leaves existing takes as they are. logo and outro are stored for a later version and not drawn yet.",
      redact:
        "Elements to hide in every exported frame, as CSS selectors. The recorder logs where they are while recording, and a new take gets one entry per selector in its edit's redact list (blur unless mode says block), which the take editor or edit.json can change to blur or block. A box that no selector covers can be added to edit.json as { rect: [x, y, width, height], fromMs, toMs, mode } in CSS pixels of the recording. live: true also blurs them in the page while recording, so they never reach the video; the developer then sees them blurred too.",
      presets: `presets: { <name>: { title?, description?, edit?: { canvas?, zoom?, cursor?, cam?, audio? }, music?: {...} | null, export?: { size?: "1920x1080", fps?, formats?: ["mp4" | "gif" | "poster"], ratios?: ["16:9" | "9:16" | "1:1" | "4:5"] } } }. A preset is a partial edit: applying it to a take merges each section field by field, replaces zoom and music whole, and leaves the trim alone; music: null removes music. Zoom must be auto or off, because manual keyframes are positions in one recording. A scene takes only a preset's music. export is stored now and used by later versions. Apply with clipmunk preset apply <name> --take <id>; save one from a take with clipmunk preset save <name> --take <id> --fields ${PRESET_FIELDS.join(",")}.`,
      example: STARTER_CONFIG,
    },
    defaults: {
      frame: { width: 1400, height: 980 },
      camera: DEFAULT_CAMERA,
      focus: DEFAULT_FOCUS,
      transform: DEFAULT_TRANSFORM,
      motion: { speed: MotionSchema.parse({ durationMs: 0, tracks: [] }).speed, easing: "cinematic" },
    },
    tracks: SceneTrackSchema.options.map((option) => ({
      target: option.shape.target.shape.kind.value,
      needsId: "id" in option.shape.target.shape,
      properties: [...option.shape.property.options],
    })),
    example: {
      note: "A tested file pair that shows the wiring. It is not a template to copy: choose framing, focus and motion for the actual page.",
      recipePath: `${SCENES_DIR}/${example.id}.scene.json`,
      recipe: example,
      componentPath: `${SCENES_DIR}/${example.id}.tsx`,
      component: exampleComponent,
    },
    commands: {
      "clipmunk scenes [--json]": "List scenes and every validation issue.",
      "clipmunk sync": "Regenerate the scene catalog (Next.js and generic React hosts).",
      "clipmunk open [--scene <id>] [--url <origin>]":
        "Print and open the Studio (the daemon must be running: clipmunk dev).",
      "clipmunk snapshot --scene <id> [--url <origin>] [--time <ms>]":
        "Save a thumbnail into the recipe. The dev server must be running.",
      [`clipmunk export --scene <id> [--url <origin>] [--fps ${EXPORT_FPS.join("|")}] [--size WxH] [--output file.mp4] [--draft] [--workers n]`]:
        "Render an MP4. Needs FFmpeg and Playwright's Chromium. Never overwrites a file.",
      "clipmunk takes": "List recorded takes.",
      "clipmunk preset list | apply <name> --take <id> | --scene <id> | save <name> --take <id> --fields <parts>":
        "List, apply or save the presets in clipmunk.config.json.",
      "clipmunk zoom <take> [--write]":
        "Show a take's automatic zooms, or store them as editable keyframes in the take's edit.json.",
      "clipmunk export --scene|--take|--sequence <id> --format mp4,gif,poster [--ratio 16:9,9:16,1:1,4:5] [--preset <name>] [--poster-at <ms>]":
        "One job, one file per format and ratio, named <clip>[.<ratio>].<ext> in .clipmunk/exports (never overwriting). A GIF is 720p at 15 fps and steps down until it is under 5 MB; a poster is a PNG at the first click or key moment. Ratios reframe takes. A preset's export options fill in what is not given.",
      "clipmunk export --take <id> [--fps 30|60] [--size WxH] [--output file.mp4]":
        "Render a take with cursor, zoom, camera, voice, redaction, captions and shortcut pills.",
      "clipmunk sequences": "List sequences and every validation issue.",
      "clipmunk export --sequence <id> [--output file.mp4]": "Render every clip of a sequence and join them.",
      [`clipmunk music <${MUSIC_STYLES.join("|")}> [--seed n] [--seconds n]`]:
        "Write a WAV sample of the generated music, to hear a style.",
      "clipmunk doctor": `Check Node, FFmpeg, Chromium, the project connection and ${CONFIG_FILE}.`,
    },
    sequences: {
      what: "A sequence joins scenes and takes into one video. It is a JSON file a person, the studio or an agent can write.",
      path: `${SEQUENCES_DIR}/<id>.sequence.json`,
      shape:
        '{ version: 1, id, title, width?, height?, fps?: 30 | 60, items: [{ clip: { kind: "scene" | "take", id }, transition?: { kind: "cut" | "fade", ms? } }], audio?: [{ file, offsetMs?, gain? }] }. `transition` says how an item arrives from the one before it; a fade overlaps the two clips. `audio` files live in .clipmunk/audio and play over the whole sequence.',
      example: SequenceSchema.parse({
        version: 1,
        id: "launch",
        title: "Launch video",
        items: [
          { clip: { kind: "scene", id: "page-survey" } },
          { clip: { kind: "take", id: "take-20261005-142233" }, transition: { kind: "fade", ms: 600 } },
        ],
      }),
      music: `Scenes (recipe.music), takes (edit.music) and sequences (music) accept { style: ${MUSIC_STYLES.map((style) => `"${style}"`).join(" | ")}, seed?, gain?, duck?, sync? }. The music is synthesized by Clipmunk from code, so it carries no third-party rights. Without a seed every clip gets its own tune, derived from its name; a seed picks a specific one. duck lowers it under a voice. sync (on by default) fits the tempo so beats land on the clip's key moments and marks each with an accent: in a scene, when a surface finishes arriving (the last keyframe of its tracks); in a take, the first click of each burst; in a sequence, each join. To make music hit a reveal, give that surface an entrance track that ends at the moment you want. A sequence's music replaces its clips' own. Styles: "upbeat" is bright and steady, "lofi" is soft and swung, "launch" is a fast launch-video sound (half-time drums, rolling hi-hats, short plucks) that drops on an early key moment, keeps one steady beat that marks every later moment with a whoosh and a crash, and ends with a short break and a hit on the last, its tempo nudged so that hit lands on the beat; it suits a sequence whose joins are its moments.`,
      captions:
        'A take\'s edit.json has captions: { auto: true, items: [{ atMs, durMs, text, source: "auto" | "manual" }] } and keys: { visible: true }. With auto on, every burst of clicks gets a caption phrased from the first named control clicked ("Click New invoice", "Open Settings", "Choose Monthly", "Type in Search"), regenerated from the event log each time; never for an element being redacted. To change one, add a manual item at its atMs: it replaces the automatic caption it overlaps, and empty text hides it. With auto off only the stored items show. keys shows keyboard shortcuts (a key pressed with Meta, Control or Alt) as pills; plain typing is never shown.',
      pace: "A take's edit.json has pace: { deadAir: { on, maxGapMs: 600, speed: 4 }, typing: { on, speed: 2 } }. Idle gaps longer than maxGapMs (keeping maxGapMs at normal speed) and runs of typing play faster; anything with speech in the voice track never does, and the voice is never sped up or pitch-shifted. New takes have both on; takes recorded before pacing existed have them off. Captions, zoom and redaction follow the same clock.",
      frame:
        'A take\'s edit.json may have frame: { ratio: "16:9" | "9:16" | "1:1" | "4:5" } to reframe it: the canvas takes that shape, and for a shape narrower than the recording a crop follows the clicked elements, always keeping the clicked element in view. Without frame the whole recording is fitted into the canvas.',
      variants: `A scene can render in the config's themes and locales (variants: { themes, locales } in clipmunk.config.json) and in other shapes. Read the variant with useSceneVariant() from "${PACKAGE_NAME}" and hand it to the app's own providers; Clipmunk never knows how the app themes or translates. Example (the example app's themed-card scene): export default function ThemedCard() { const { theme, locale, ratio } = useSceneVariant(); return <ThemeProvider theme={theme}><I18nProvider locale={locale ?? "en"}><Page tall={ratio === "9:16"} /></I18nProvider></ThemeProvider>; }. Use the app's real provider names. For a shape that needs its own layout, add definition.variants.ratios["9:16"] = { width, height, camera? } to the recipe and lay out for it when ratio is "9:16"; a ratio not listed is fitted into that shape. Export variants with clipmunk export --scene <id> --variant light,dark --ratio 16:9,9:16.`,
      sounds:
        "A scene's recipe may carry `sounds: [{ kind: \"typing\", atMs, chars, perSecond?, enter?, gain? }]`: key clicks while text types on screen, synthesized like the music. Copy `atMs` and `perSecond` from the component that types the text (they are on the same clock as useSceneTime), and set `chars` to the text's length. `enter: true` adds a Return key after the last character, for a command that runs. Fast on-screen typing is heard as real typing, not one click per character. Sound effects play over the music without lowering it, in the scene and in any sequence that uses it.",
      narration:
        "A scene's recipe may carry `audio: [{ file, offsetMs?, gain? }]`. The studio's Narrate button records the microphone while the scene plays and fills this in.",
    },
    limits: [
      "React DOM only. Scenes are client components: in Next.js do not import server-only modules into a scene.",
      "Depth of field is a Gaussian approximation; there is no aperture-shaped bokeh and no occlusion between surfaces.",
      "CSS transforms, filters, opacity or overflow clipping on elements between nested Surfaces flatten 3D. Put those on leaf content.",
      "Portalled UI (modals, tooltips) renders outside the scene.",
    ],
  };
}
export type Guide = ReturnType<typeof getGuide>;

/** Plain-text rendering of the guide for terminals and agents that prefer prose. */
export function formatGuide(guide: Guide = getGuide()): string {
  const lines: string[] = [
    `# Clipmunk authoring guide (${guide.package})`,
    "",
    guide.purpose,
    "",
    guide.freedom,
    "",
    "## Workflow",
  ];
  for (const [index, step] of guide.workflow.entries()) lines.push(`${index + 1}. ${step}`);
  lines.push("", "## Concepts");
  for (const concept of guide.concepts)
    lines.push(
      "",
      `### ${concept.title}`,
      concept.idea,
      `How: ${concept.how}`,
      `Avoid: ${concept.avoid}`,
      `Check: ${concept.check}`,
    );
  lines.push("", "## Files");
  for (const [key, value] of Object.entries(guide.files)) lines.push(`- ${key}: ${value}`);
  lines.push(
    "",
    "## Config",
    `Path: ${guide.config.path}`,
    guide.config.what,
    guide.config.shape,
    guide.config.brand,
    guide.config.presets,
    JSON.stringify(guide.config.example, null, 2),
  );
  lines.push("", "## Defaults", JSON.stringify(guide.defaults, null, 2), "", "## Tracks");
  for (const track of guide.tracks)
    lines.push(`- target { kind: "${track.target}"${track.needsId ? ", id" : ""} }: ${track.properties.join(", ")}`);
  lines.push(
    "",
    "## Example",
    guide.example.note,
    "",
    guide.example.recipePath,
    JSON.stringify(guide.example.recipe, null, 2),
    "",
    guide.example.componentPath,
    guide.example.component,
    "## Commands",
  );
  for (const [command, purpose] of Object.entries(guide.commands)) lines.push(`- ${command}: ${purpose}`);
  lines.push(
    "",
    "## Sequences",
    guide.sequences.what,
    `Path: ${guide.sequences.path}`,
    guide.sequences.shape,
    JSON.stringify(guide.sequences.example, null, 2),
    guide.sequences.narration,
    guide.sequences.music,
    guide.sequences.sounds,
  );
  lines.push("", "## Limits", ...guide.limits.map((limit) => `- ${limit}`), "");
  return lines.join("\n");
}

/** The short project-root handoff that tells any coding agent where to start. */
export function handoffDocument(): string {
  return `# Clipmunk

This app has [Clipmunk](https://www.npmjs.com/package/${PACKAGE_NAME}) installed. Clipmunk turns this app's real components into cinematic 3D scenes and exports them as video.

## For coding agents

1. Run \`npx clipmunk guide\` and read it fully. It is the authoring reference for the installed version.
2. Scenes live in \`${SCENES_DIR}/\` as a pair: \`<id>.scene.json\` and \`<id>.tsx\`.
3. Validate with \`npx clipmunk scenes\`, then look at the result in the Studio: with the dev server running, \`npx clipmunk dev\` prints the Studio link (\`npx clipmunk open --scene <id>\` opens a scene in it).
4. Do not redesign the app's UI for a scene. Import the existing components and providers.

## Recording the app

\`npx clipmunk dev\` starts a local daemon and prints two links: the Studio, served by the daemon, and a link to open once in the app so it can record. Then press Alt+Shift+R on any page of the running app. Takes are saved in \`.clipmunk/takes/\` and open in the Studio.

## Example prompt

> Read CLIPMUNK.md and run \`npx clipmunk guide\`. Then make a 20 to 30 second launch video of this product: a title, 3 or 4 features each shown by a real page of this app under a short caption, and an end card, as 1920x1080 scenes joined in a sequence with the launch music. Check every scene in the studio, then export the sequence and tell me where the MP4 is.
`;
}
