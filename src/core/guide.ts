import { EXPORT_FPS } from "./export";
import { EASINGS, MotionSchema, SceneTrackSchema } from "./motion";
import { MUSIC_STYLES } from "./music";
import { HANDOFF_FILE, PACKAGE_NAME, SCENES_DIR, SCENE_PARAM, STUDIO_PARAM } from "./project";
import { SceneRecipeSchema, type SceneRecipe } from "./recipe";
import { SEQUENCES_DIR, SequenceSchema } from "./sequence";
import { DEFAULT_CAMERA, DEFAULT_FOCUS, DEFAULT_TRANSFORM, SCENE_BACKGROUND } from "./scene";

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
    avoid: "Do not recreate or restyle host UI to make it easier to animate. Do not copy fetch logic; reuse the host's providers and data. Do not duplicate a subtree to fake depth.",
    check: "Compare the scene with the normal page: same styling, same content, one live instance of each component.",
  },
  {
    id: "camera",
    title: "Compose the camera first",
    idea: "Perspective and viewpoint create the cinematic feel. A close, oblique view of a large surface, with one edge near and the opposite edge receding, reads as a camera move. A small centred panel sliding around does not.",
    how: "Units are pixels and degrees: +x right, +y down, +z toward the viewer. camera.x/y/z are subtracted from scene positions, so raising camera.z pushes everything away and lowering it moves in. camera.rotateX/Y/Z rotate the whole stage. camera.perspective is the distance to the projection plane and cannot be animated. Hold the angle steady and translate the camera along the surface for a survey; several camera tracks that share timing form one diagonal rail.",
    avoid: "Arbitrary spins, competing rotations and oscillation hide the product. Anything that reaches z >= perspective crosses the camera plane and is reported as an error.",
    check: "Scrub the start, middle and end. The subject stays readable, nothing flips or clips, and the move serves the reveal.",
  },
  {
    id: "focus",
    title: "Depth of field belongs to the camera",
    idea: "The camera focuses at one distance along its viewing axis. Everything at that depth is sharp wherever it is on screen; nearer and farther content softens progressively.",
    how: "A point's depth is perspective minus its camera-space z. Set focus.distance to the depth of the subject. Lower fStop for a shallower, more dramatic focus; raise it for gentler blur. maxBlur caps the blur radius in pixels. Animate focus.distance for a rack focus. A tilted surface gets a continuous sharp-to-soft gradient automatically.",
    avoid: "Blurring the whole subject. Reach for fStop before raising maxBlur. This is a Gaussian approximation in the DOM, not ray-traced bokeh.",
    check: "Open the scene and confirm the intended subject is the sharp part. If the whole surface is soft, focus.distance does not match its depth.",
  },
  {
    id: "depth",
    title: "Depth makes layers relate",
    idea: "Parallax is near and far content moving differently as the viewpoint changes. Separating meaningful sections in z and letting them settle into place shows how the page is built.",
    how: "Wrap meaningful existing subtrees in their own Surface, nested inside a parent Surface. Children inherit the parent's transform and start where CSS laid them out. Animate each child's z (and opacity if wanted) to its resting value of 0 with staggered keyframes. A Surface that contains other Surfaces is a group: put its own background in the `content` prop.",
    avoid: "Splitting every element, or separating layers so far that the page stops reading as one thing. Loose text or media directly inside a group cannot be blurred and is reported.",
    check: "At several times the layers visibly change their relative positions, then resolve into the original layout.",
  },
  {
    id: "timing",
    title: "Timing gives weight",
    idea: "Slow, eased movement that settles deliberately feels like a camera. Abrupt or linear movement feels like a UI transition.",
    how: `Each keyframe is { timeMs, value, easing }. easing applies to the segment that starts at that keyframe and defaults to "cinematic" (zero velocity and acceleration at both ends); the others are ${EASINGS.filter((easing) => easing !== "cinematic").join(" and ")}. A track holds its first and last value outside its keyframes, so a delayed entrance repeats the starting value at its start time. motion.speed scales authored time; durationMs / speed is the playback length.`,
    avoid: "Many keyframes on a camera track: every cinematic segment comes to rest, so a continuous move should be one segment. Host CSS animations run on wall-clock time and are frozen in export.",
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
    how: `Open the studio at ?${STUDIO_PARAM}=1 on the running dev server and select the scene (or add &${SCENE_PARAM}=<id>). Edit the two files; the dev server hot-reloads them and the studio lists any issue with a fix. Save a thumbnail with flick snapshot. Export only when asked.`,
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
        { target: { kind: "camera" }, property: "x", keyframes: [{ timeMs: 0, value: -360 }, { timeMs: 7000, value: 300 }] },
        { target: { kind: "camera" }, property: "y", keyframes: [{ timeMs: 0, value: -120 }, { timeMs: 7000, value: 90 }] },
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
    freedom: "Concepts describe effects and trade-offs. No camera angle, path, layer count or timing is mandatory, and the user's direction overrides every default here. Only the schemas are binding.",
    stage: { background: SCENE_BACKGROUND, note: "The stage is always black. Host UI keeps its own theme." },
    concepts,
    workflow: [
      `Read ${HANDOFF_FILE}, then this guide. Inspect the requested page: its components, providers, styles and data.`,
      "Decide the shot before writing: the subject, which edge is near, the camera's travel direction, what is in focus, and what gives depth.",
      `Create ${SCENES_DIR}/<id>.scene.json and ${SCENES_DIR}/<id>.tsx. The id is a lowercase slug and equals the file name.`,
      "Run flick scenes to validate. Fix every issue it lists.",
      `Open the studio (?${STUDIO_PARAM}=1&${SCENE_PARAM}=<id>) on the running dev server and look at the opening frame before tuning motion.`,
      "Scrub several times, adjust the source, repeat. Then run flick snapshot --scene <id> to save its thumbnail.",
      "Export with flick export --scene <id> only when the user asks for a video.",
    ],
    files: {
      directory: SCENES_DIR,
      recipe: "<id>.scene.json: { version: 1, id, title, description?, definition: { width?, height?, scene: { camera?, focus?, nodes: [{ id, parentId?, transform? }] }, motion?: { durationMs, speed?, tracks } } }. Unknown keys are rejected.",
      component: "<id>.tsx or <id>.jsx (one, not both): default-exports a component returning Surface elements. Surface props: id, transform?, content?, children, className?, style?. Give each Surface an explicit size through style when its content would otherwise stretch.",
      helpers: `Keep helper modules outside ${SCENES_DIR}; every .tsx there is treated as a scene component.`,
      sync: "Vite discovers new scene files automatically. In Next.js and other hosts run flick sync after adding or removing a scene.",
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
      "flick scenes [--json]": "List scenes and every validation issue.",
      "flick sync": "Regenerate the scene catalog (Next.js and generic React hosts).",
      "flick open [--scene <id>] [--url <origin>]": "Print and open the studio URL.",
      "flick snapshot --scene <id> [--url <origin>] [--time <ms>]": "Save a thumbnail into the recipe. The dev server must be running.",
      [`flick export --scene <id> [--url <origin>] [--fps ${EXPORT_FPS.join("|")}] [--size WxH] [--output file.mp4] [--draft] [--workers n]`]:
        "Render an MP4. Needs FFmpeg and Playwright's Chromium. Never overwrites a file.",
      "flick takes": "List recorded takes.",
      "flick zoom <take> [--write]": "Show a take's automatic zooms, or store them as editable keyframes in take.json.",
      "flick export --take <id> [--fps 30|60] [--size WxH] [--output file.mp4]": "Render a take with cursor, zoom, camera and voice.",
      "flick sequences": "List sequences and every validation issue.",
      "flick export --sequence <id> [--output file.mp4]": "Render every clip of a sequence and join them.",
      [`flick music <${MUSIC_STYLES.join("|")}> [--seed n] [--seconds n]`]: "Write a WAV sample of the generated music, to hear a style.",
      "flick doctor": "Check Node, FFmpeg, Chromium and the project connection.",
    },
    sequences: {
      what: "A sequence joins scenes and takes into one video. It is a JSON file a person, the studio or an agent can write.",
      path: `${SEQUENCES_DIR}/<id>.sequence.json`,
      shape: "{ version: 1, id, title, width?, height?, fps?: 30 | 60, items: [{ clip: { kind: \"scene\" | \"take\", id }, transition?: { kind: \"cut\" | \"fade\", ms? } }], audio?: [{ file, offsetMs?, gain? }] }. `transition` says how an item arrives from the one before it; a fade overlaps the two clips. `audio` files live in .flick/audio and play over the whole sequence.",
      example: SequenceSchema.parse({ version: 1, id: "launch", title: "Launch video", items: [{ clip: { kind: "scene", id: "page-survey" } }, { clip: { kind: "take", id: "take-20261005-142233" }, transition: { kind: "fade", ms: 600 } }] }),
      music: `Scenes (recipe.music), takes (edit.music) and sequences (music) accept { style: ${MUSIC_STYLES.map((style) => `"${style}"`).join(" | ")}, seed?, gain?, duck? }. The music is synthesized by Flick from code, so it carries no third-party rights. seed picks a different tune in the same style; duck lowers it under a voice. A sequence's music replaces its clips' own.`,
      narration: "A scene's recipe may carry `audio: [{ file, offsetMs?, gain? }]`. The studio's Narrate button records the microphone while the scene plays and fills this in.",
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
  const lines: string[] = [`# Flick authoring guide (${guide.package})`, "", guide.purpose, "", guide.freedom, "", "## Workflow"];
  guide.workflow.forEach((step, index) => lines.push(`${index + 1}. ${step}`));
  lines.push("", "## Concepts");
  for (const concept of guide.concepts)
    lines.push("", `### ${concept.title}`, concept.idea, `How: ${concept.how}`, `Avoid: ${concept.avoid}`, `Check: ${concept.check}`);
  lines.push("", "## Files");
  for (const [key, value] of Object.entries(guide.files)) lines.push(`- ${key}: ${value}`);
  lines.push("", "## Defaults", JSON.stringify(guide.defaults, null, 2), "", "## Tracks");
  for (const track of guide.tracks)
    lines.push(`- target { kind: "${track.target}"${track.needsId ? ", id" : ""} }: ${track.properties.join(", ")}`);
  lines.push("", "## Example", guide.example.note, "", guide.example.recipePath, JSON.stringify(guide.example.recipe, null, 2), "", guide.example.componentPath, guide.example.component, "## Commands");
  for (const [command, purpose] of Object.entries(guide.commands)) lines.push(`- ${command}: ${purpose}`);
  lines.push("", "## Sequences", guide.sequences.what, `Path: ${guide.sequences.path}`, guide.sequences.shape, JSON.stringify(guide.sequences.example, null, 2), guide.sequences.narration, guide.sequences.music);
  lines.push("", "## Limits", ...guide.limits.map((limit) => `- ${limit}`), "");
  return lines.join("\n");
}

/** The short project-root handoff that tells any coding agent where to start. */
export function handoffDocument(): string {
  return `# Flick

This app has [Flick](https://www.npmjs.com/package/${PACKAGE_NAME}) installed. Flick turns this app's real components into cinematic 3D scenes and exports them as video.

## For coding agents

1. Run \`npx flick guide\` and read it fully. It is the authoring reference for the installed version.
2. Scenes live in \`${SCENES_DIR}/\` as a pair: \`<id>.scene.json\` and \`<id>.tsx\`.
3. Validate with \`npx flick scenes\`, then look at the result in the studio: open the running dev server with \`?${STUDIO_PARAM}=1\`.
4. Do not redesign the app's UI for a scene. Import the existing components and providers.

## Recording the app

\`npx flick dev\` starts a local daemon and prints a link. Open the link once, then press Alt+Shift+R on any page of the running app to record it. Takes are saved in \`.flick/takes/\`.

## Example prompt

> Read FLICK.md and run \`npx flick guide\`. Inspect this app's dashboard page and create a cinematic Flick scene from its existing components. Choose a close perspective, camera travel and depth of field on purpose. Verify it in the studio, save a snapshot, and give me the scene URL.
`;
}
