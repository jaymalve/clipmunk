import { type ComponentType, useEffect, useMemo, useState } from "react";
import { type CatalogScene, DAEMON_HASH, type Issue, loadSceneCatalog, SCENE_PARAM, type SceneCatalog } from "../core";
import { adoptDaemonLink, createDaemonClient, storedLink } from "../recorder";
import { Chrome } from "./Chrome";
import { type DaemonState, useDaemon } from "./daemon";
import { IssueList } from "./IssueList";
import { ScenePreview } from "./ScenePreview";

/** The studio entry the generated host adapter mounts in development.
 * `scenes` maps module paths to lazy loaders for every `<id>.scene.json` and its
 * component. Recipes are loaded to build the library; a component is loaded only
 * when its scene is opened, and only the host's bundler ever executes it.
 */
export type SceneModules = Record<string, () => Promise<unknown>>;
export type ClipmunkStudioProps = { scenes: SceneModules };

const unwrap = (module: unknown) =>
  module && typeof module === "object" && "default" in module ? (module as { default: unknown }).default : module;
export function ClipmunkStudio(_props: ClipmunkStudioProps) {
  const [moved, setMoved] = useState<{ studio?: string; checked: boolean }>({ checked: false });
  useEffect(() => {
    let current = true;
    // With a running daemon this page forwards to its Studio, keeping the clip in the address.
    const link = adoptDaemonLink() ?? storedLink();
    if (!link) return setMoved({ checked: true });
    void createDaemonClient(link)
      .get("/v1/status")
      .then((status) => {
        if (!current) return;
        const studio = `http://127.0.0.1:${link.port}/${location.search}`;
        if (status.ok) location.replace(`${studio}#${DAEMON_HASH}=${link.port}.${link.token}`);
        setMoved({ studio: status.ok ? studio : undefined, checked: true });
      });
    return () => {
      current = false;
    };
  }, []);
  if (!moved.checked) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto" }}>
      <div className="library">
        <h1>Clipmunk Studio</h1>
        <p>
          The Studio runs on its own now, beside your app. Run <code>npx clipmunk dev</code> in your project and open
          the Studio link it prints{moved.studio ? "" : " (it starts with http://127.0.0.1:4747/)"}.
        </p>
        {moved.studio && <a href={moved.studio}>Open the Studio</a>}
      </div>
    </Chrome>
  );
}

/** The frame page the generated adapter renders for `?clipmunk-frame&clipmunk-scene=<id>`: only the
 * scene, fitted to the window, with the capture bridge and the Studio's message protocol. Export
 * opens this page too, so the Studio's preview and the export cannot disagree.
 */
export function ClipmunkFrame({ scenes }: ClipmunkStudioProps) {
  const sceneId = useMemo(() => new URLSearchParams(location.search).get(SCENE_PARAM) ?? undefined, []);
  const daemon = useDaemon();
  const catalog = useSceneCatalog(scenes, sceneId);
  if (!catalog) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  if (!catalog.selected)
    return (
      <FrameProblem
        title={sceneId ? `No valid scene named "${sceneId}".` : "The address names no scene (clipmunk-scene)."}
        issues={catalog.issues}
      />
    );
  return (
    <OpenScene
      key={catalog.selected.id}
      scene={catalog.selected}
      load={scenes[catalog.selected.binding]!}
      daemon={daemon}
      bare
    />
  );
}

/** Recipes for the library and the selected scene; components load only when a scene opens. */
function useSceneCatalog(scenes: SceneModules, sceneId: string | undefined) {
  const [catalog, setCatalog] = useState<SceneCatalog | null>(null);
  useEffect(() => {
    let current = true;
    const paths = Object.keys(scenes);
    const sources = paths.filter((path) => path.endsWith(".scene.json"));
    void Promise.all(
      sources.map(async (path) => {
        try {
          return { path, document: unwrap(await scenes[path]!()) };
        } catch (error) {
          return { path, document: undefined, error: error instanceof Error ? error.message : String(error) };
        }
      }),
    ).then((loaded) => {
      if (!current) return;
      const result = loadSceneCatalog({
        sources: loaded.filter((source) => !("error" in source)),
        bindings: paths,
        sceneId,
      });
      for (const source of loaded)
        if ("error" in source)
          result.issues.push({
            code: "unreadable-scene",
            path: source.path,
            message: `Could not load this recipe: ${source.error}`,
          });
      setCatalog(result);
    });
    return () => {
      current = false;
    };
  }, [scenes, sceneId]);
  return catalog;
}

function OpenScene({
  scene,
  load,
  daemon,
  bare = false,
}: {
  scene: CatalogScene;
  load: () => Promise<unknown>;
  daemon: DaemonState;
  bare?: boolean;
}) {
  const [state, setState] = useState<{ Component?: ComponentType; error?: string }>({});
  useEffect(() => {
    let current = true;
    load().then(
      (module) => {
        const Component = unwrap(module);
        if (!current) return;
        setState(
          typeof Component === "function"
            ? { Component: Component as ComponentType }
            : { error: `${scene.binding} must default-export a React component.` },
        );
      },
      (error: unknown) => current && setState({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
  }, [load, scene.binding]);

  if (state.error)
    return (
      <FrameProblem
        title="A scene component failed to load."
        issues={[{ code: "component-failed", path: scene.binding, message: state.error }]}
      />
    );
  if (!state.Component) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  return (
    <ScenePreview
      definition={scene.definition}
      title={scene.title}
      sceneId={scene.id}
      daemon={daemon}
      audio={scene.audio}
      music={scene.music}
      sounds={scene.sounds}
      bare={bare}
    >
      <state.Component />
    </ScenePreview>
  );
}

/** What the frame page shows instead of a scene it cannot render. */
function FrameProblem({ title, issues }: { title: string; issues: Issue[] }) {
  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto", background: "#000", padding: 24 }}>
      <IssueList issues={issues} title={title} />
    </Chrome>
  );
}
