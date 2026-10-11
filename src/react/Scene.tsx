import {
  type CSSProperties,
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import {
  type CameraInput,
  CameraSchema,
  cameraToCss,
  compileMotion,
  DEFAULT_CAMERA,
  DEFAULT_FOCUS,
  DEFAULT_TRANSFORM,
  evaluateFrame,
  evaluateMotion,
  type FocusInput,
  FocusSchema,
  FULL_FOCUS_BANDS,
  type Issue,
  type Measurement,
  motionTime,
  NO_MOTION,
  nodeTreeIssues,
  PREVIEW_FOCUS_BANDS,
  planFocus,
  resolveFrame,
  SCENE_BACKGROUND,
  type Transform,
  type TransformInput,
  TransformSchema,
  transformToCss,
  zodIssues,
} from "../core";
import { type Clock, createClock } from "./clock";
import { createFocusFilters } from "./focus-filter";
import { createRegistry, type Registry } from "./registry";

/** Scene and Surface: bind live React subtrees to the core spatial maths.
 * Frames do not go through React. The clock notifies `apply`, which evaluates one
 * frame and writes transforms, opacity and filters straight onto the registered
 * elements. React renders only when structure or props change.
 */
type SceneContextValue = { registry: Registry; clock: Clock; authoredTime: () => number };
const SceneContext = createContext<SceneContextValue | null>(null);
const ParentContext = createContext<symbol | undefined>(undefined);
const useLayout = typeof window === "undefined" ? useEffect : useLayoutEffect;

export type SceneQuality = "full" | "preview";
export type SceneProps = {
  camera?: CameraInput;
  focus?: FocusInput;
  /** The recipe's nodes: resting transforms by id. When given, rendered Surfaces must match them. */
  nodes?: readonly { id: string; parentId?: string; transform?: TransformInput }[];
  motion?: unknown;
  /** Drive the scene from an external clock (the studio does). Otherwise use `timeMs`. */
  clock?: Clock;
  timeMs?: number;
  /** `preview` uses fewer blur bands for live playback; export always uses `full`. */
  quality?: SceneQuality;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
  onDiagnostics?: (issues: Issue[]) => void;
};

export function Scene({
  camera,
  focus,
  nodes: declared,
  motion,
  clock: externalClock,
  timeMs,
  quality = "full",
  children,
  className,
  style,
  onDiagnostics,
}: SceneProps) {
  const [registry] = useState(createRegistry);
  const [ownClock] = useState(() => createClock(timeMs));
  const clock = externalClock ?? ownClock;
  const root = useRef<HTMLDivElement>(null);
  const stage = useRef<HTMLDivElement>(null);
  const defs = useRef<SVGDefsElement>(null);
  const [filters] = useState(() => createFocusFilters(() => defs.current));

  const cameraKey = JSON.stringify(camera ?? {});
  const focusKey = JSON.stringify(focus ?? {});
  const nodesKey = JSON.stringify(declared ?? null);
  const settings = useMemo(() => {
    const issues: Issue[] = [];
    const nodeList = JSON.parse(nodesKey) as SceneProps["nodes"] | null;
    const nodes = nodeList ? new Map(nodeList.map((node) => [node.id, node])) : undefined;
    const parsedCamera = CameraSchema.safeParse(JSON.parse(cameraKey));
    const parsedFocus = FocusSchema.safeParse(JSON.parse(focusKey));
    if (!parsedCamera.success)
      issues.push(
        ...zodIssues(parsedCamera.error, "invalid-scene").map((issue) => ({ ...issue, path: `camera.${issue.path}` })),
      );
    if (!parsedFocus.success)
      issues.push(
        ...zodIssues(parsedFocus.error, "invalid-scene").map((issue) => ({ ...issue, path: `focus.${issue.path}` })),
      );
    const compiled = motion === undefined ? undefined : compileMotion(motion);
    if (compiled && !compiled.ok)
      issues.push(...compiled.issues.map((issue) => ({ ...issue, path: `motion.${issue.path}` })));
    return {
      camera: parsedCamera.success ? parsedCamera.data : DEFAULT_CAMERA,
      focus: parsedFocus.success ? parsedFocus.data : DEFAULT_FOCUS,
      motion: compiled?.ok ? compiled.data : undefined,
      nodes,
      issues,
    };
  }, [cameraKey, focusKey, nodesKey, motion]);

  // `apply` is stable and always reads the latest props through this ref.
  const latest = useRef({ settings, quality, onDiagnostics });
  latest.current = { settings, quality, onDiagnostics };
  const reported = useRef<string | undefined>(undefined);

  const apply = useCallback(() => {
    const rootElement = root.current,
      stageElement = stage.current;
    if (!rootElement || !stageElement) return;
    const { settings, quality, onDiagnostics } = latest.current;
    const issues: Issue[] = [...settings.issues];
    const state = settings.motion ? evaluateMotion(settings.motion, clock.get()) : NO_MOTION;
    const bindings = [...registry.entries.values()];
    const nodes = bindings.map((binding) => ({
      id: binding.id,
      parentId: binding.parent ? registry.entries.get(binding.parent)?.id : undefined,
      // The recipe owns the resting transform; a Surface prop overrides individual fields.
      transform: { ...DEFAULT_TRANSFORM, ...settings.nodes?.get(binding.id)?.transform, ...binding.transform },
    }));
    if (settings.nodes) {
      const rendered = new Map(nodes.map((node) => [node.id, node]));
      for (const node of nodes)
        if (!settings.nodes.has(node.id))
          issues.push({
            code: "undeclared-surface",
            path: node.id,
            message: `Surface "${node.id}" is rendered but not listed in the recipe's nodes.`,
          });
      for (const [id, node] of settings.nodes) {
        const live = rendered.get(id);
        if (!live)
          issues.push({
            code: "missing-surface",
            path: id,
            message: `The recipe lists node "${id}" but the component does not render a Surface with that id.`,
          });
        else if (live.parentId !== node.parentId)
          issues.push({
            code: "parent-mismatch",
            path: id,
            message: `Node "${id}" has parentId ${JSON.stringify(node.parentId ?? null)} in the recipe but is rendered inside ${JSON.stringify(live.parentId ?? null)}.`,
          });
      }
    }
    for (const binding of bindings)
      if (binding.transformIssue)
        issues.push({ code: "invalid-scene", path: binding.id, message: binding.transformIssue });
    const tree = nodeTreeIssues(nodes);
    for (const issue of tree)
      issues.push({ code: "invalid-scene", path: nodes[issue.index]!.id, message: issue.message });
    const ids = new Set(nodes.map((node) => node.id));
    for (const id of state.surfaces.keys())
      if (!ids.has(id))
        issues.push({
          code: "unknown-target",
          path: `motion.${id}`,
          message: `Motion targets a surface that is not rendered: ${id}`,
        });

    const frame = resolveFrame(settings.camera, settings.focus, nodes, state);
    const measurements = new Map<string, Measurement>();
    for (const binding of bindings) {
      const measurement = registry.measurements.get(binding.token);
      if (measurement) measurements.set(binding.id, measurement);
    }
    const evaluation = tree.length ? { nodes: [], issues: [] } : evaluateFrame(frame, measurements);
    issues.push(...evaluation.issues);
    if (frame.focus.maxBlur > 0) issues.push(...registry.coverageIssues);

    rootElement.style.perspective = `${frame.camera.perspective}px`;
    stageElement.style.transform = cameraToCss(frame.camera);
    const evaluated = new Map(evaluation.nodes.map((node) => [node.id, node]));
    const bands = quality === "full" ? FULL_FOCUS_BANDS : PREVIEW_FOCUS_BANDS;
    const filtered = new Set<symbol>();
    bindings.forEach((binding, index) => {
      binding.element.style.transform = transformToCss(frame.nodes[index]!.transform);
      const node = evaluated.get(binding.id);
      const plan = node ? planFocus(node.focus, node.width, node.height, bands) : ({ kind: "none" } as const);
      let filter = "none";
      if (plan.kind === "uniform") filter = `blur(${+plan.blurPx.toFixed(2)}px)`;
      else if (plan.kind === "varying") {
        const id = filters.use(binding.token, plan.mask, node!.width, node!.height);
        if (id) {
          filter = `url(#${id})`;
          filtered.add(binding.token);
        }
      }
      const opacity = state.surfaces.get(binding.id)?.opacity;
      const group = registry.isGroup(binding.token);
      // A group keeps its 3D context and is never filtered; only visual leaves are.
      for (const leaf of [binding.content, group ? null : binding.children]) {
        if (!leaf) continue;
        leaf.style.filter = filter;
        leaf.style.opacity = opacity === undefined ? "" : String(opacity);
        leaf.style.pointerEvents = "auto";
        leaf.style.transformStyle = "";
        leaf.setAttribute("data-clipmunk-leaf", "");
      }
      if (group) {
        binding.children.style.filter = "none";
        binding.children.style.opacity = "";
        binding.children.style.pointerEvents = "none";
        binding.children.style.transformStyle = "preserve-3d";
        binding.children.removeAttribute("data-clipmunk-leaf");
      }
    });
    filters.keepOnly(filtered);

    rootElement.setAttribute("data-clipmunk-valid", issues.length ? "false" : "true");
    const key = JSON.stringify(issues);
    if (reported.current !== key) {
      reported.current = key;
      onDiagnostics?.(issues);
    }
  }, [registry, clock, filters]);

  useLayout(() => registry.mount(stage.current!), [registry]);
  useLayout(() => {
    if (!externalClock && timeMs !== undefined) ownClock.set(timeMs);
  }, [externalClock, ownClock, timeMs]);
  useLayout(() => {
    const offClock = clock.subscribe(apply);
    const offRegistry = registry.subscribe(() => {
      registry.refresh();
      apply();
    });
    return () => {
      offClock();
      offRegistry();
    };
  }, [clock, registry, apply]);
  // After every commit of this component: Surfaces have registered, so measure and paint.
  useLayout(() => {
    registry.refresh();
    apply();
  });

  const context = useMemo<SceneContextValue>(
    () => ({
      registry,
      clock,
      authoredTime: () => {
        const current = latest.current.settings.motion;
        return current ? motionTime(current, clock.get()) : clock.get();
      },
    }),
    [registry, clock],
  );

  return (
    <SceneContext.Provider value={context}>
      <ParentContext.Provider value={undefined}>
        <div
          ref={root}
          className={className}
          data-clipmunk-scene=""
          style={{
            ...style,
            position: style?.position ?? "relative",
            background: SCENE_BACKGROUND,
            perspectiveOrigin: "50% 50%",
            pointerEvents: "none",
          }}
        >
          <svg aria-hidden="true" width="0" height="0" style={{ position: "absolute", pointerEvents: "none" }}>
            <defs ref={defs} />
          </svg>
          <div
            ref={stage}
            data-clipmunk-stage=""
            style={{
              position: "relative",
              width: "100%",
              height: "100%",
              transformStyle: "preserve-3d",
              transformOrigin: "50% 50%",
              pointerEvents: "none",
            }}
          >
            {children}
          </div>
        </div>
      </ParentContext.Provider>
    </SceneContext.Provider>
  );
}

export type SurfaceProps = {
  /** Unique within the Scene; matches a node id in the recipe and motion targets. */
  id: string;
  transform?: TransformInput;
  /** Paint that belongs to a group itself (its background, for example). Always a visual leaf. */
  content?: ReactNode;
  children?: ReactNode;
  className?: string;
  style?: CSSProperties;
};

export function Surface({ id, transform, content, children, className, style }: SurfaceProps) {
  const scene = useContext(SceneContext);
  if (!scene) throw new Error("Surface must be rendered inside a Scene.");
  const parent = useContext(ParentContext);
  const [token] = useState(() => Symbol("clipmunk-surface"));
  const element = useRef<HTMLDivElement>(null);
  const contentElement = useRef<HTMLDivElement>(null);
  const childrenElement = useRef<HTMLDivElement>(null);
  const transformKey = JSON.stringify(transform ?? {});
  const parsed = useMemo(() => TransformSchema.safeParse(JSON.parse(transformKey)), [transformKey]);
  const { registry } = scene;

  useLayout(() => {
    registry.upsert({
      token,
      id,
      parent,
      element: element.current!,
      content: contentElement.current,
      children: childrenElement.current!,
      transform: parsed.success ? (JSON.parse(transformKey) as Partial<Transform>) : undefined,
      transformIssue: parsed.success
        ? undefined
        : `Invalid transform on ${id}: ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
    });
  });
  useLayout(() => () => registry.remove(token), [registry, token]);

  return (
    <ParentContext.Provider value={token}>
      <div
        ref={element}
        className={className}
        data-clipmunk-id={id}
        style={{
          ...style,
          position: style?.position ?? "relative",
          transformOrigin: "50% 50%",
          transformStyle: "preserve-3d",
          pointerEvents: "none",
        }}
      >
        {content !== undefined && (
          <div ref={contentElement} data-clipmunk-leaf="">
            {content}
          </div>
        )}
        <div ref={childrenElement} style={content === undefined ? { width: "100%", height: "100%" } : undefined}>
          {children}
        </div>
      </div>
    </ParentContext.Provider>
  );
}

/** Authored scene time in milliseconds, for host components that animate with the scene. */
export function useSceneTime(): number {
  const scene = useContext(SceneContext);
  if (!scene) throw new Error("useSceneTime must be used inside a Scene.");
  return useSyncExternalStore(scene.clock.subscribe, scene.authoredTime, scene.authoredTime);
}
