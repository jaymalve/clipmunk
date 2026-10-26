import { type ComponentType, useEffect, useMemo, useState } from "react";
import {
  type CatalogScene,
  loadSceneCatalog,
  SCENE_PARAM,
  type SceneCatalog,
  SEQUENCE_PARAM,
  TAKE_PARAM,
} from "../core";
import { type DaemonState, useDaemon } from "./daemon";
import { Library } from "./Library";
import { studioHref } from "./links";
import { ScenePreview } from "./ScenePreview";
import { SequenceEditor } from "./SequenceEditor";
import { TakeEditor } from "./TakeEditor";

/** The studio entry the generated host adapter mounts in development.
 * `scenes` maps module paths to lazy loaders for every `<id>.scene.json` and its
 * component. Recipes are loaded to build the library; a component is loaded only
 * when its scene is opened, and only the host's bundler ever executes it.
 */
export type SceneModules = Record<string, () => Promise<unknown>>;
export type ClipmunkStudioProps = { scenes: SceneModules };

const unwrap = (module: unknown) =>
  module && typeof module === "object" && "default" in module ? (module as { default: unknown }).default : module;
export function ClipmunkStudio({ scenes }: ClipmunkStudioProps) {
  const sceneId = useMemo(() => new URLSearchParams(location.search).get(SCENE_PARAM) ?? undefined, []);
  const takeId = useMemo(() => new URLSearchParams(location.search).get(TAKE_PARAM) ?? undefined, []);
  const sequenceId = useMemo(() => new URLSearchParams(location.search).get(SEQUENCE_PARAM) ?? undefined, []);
  const daemon = useDaemon();
  const catalog = useSceneCatalog(scenes, sceneId);

  if (!catalog) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  if (takeId) return <TakeEditor id={takeId} daemon={daemon} backHref={studioHref()} />;
  if (sequenceId)
    return <SequenceEditor id={sequenceId} daemon={daemon} scenes={catalog.scenes} backHref={studioHref()} />;
  if (catalog.selected)
    return (
      <OpenScene
        key={catalog.selected.id}
        scene={catalog.selected}
        load={scenes[catalog.selected.binding]!}
        daemon={daemon}
      />
    );
  return <Library catalog={catalog} missing={sceneId} daemon={daemon} />;
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
      <Library
        catalog={{ scenes: [], issues: catalog.issues }}
        missing={sceneId ?? "(no clipmunk-scene in the address)"}
        daemon={daemon}
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
      <Library
        catalog={{ scenes: [], issues: [{ code: "component-failed", path: scene.binding, message: state.error }] }}
      />
    );
  if (!state.Component) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  return (
    <ScenePreview
      definition={scene.definition}
      title={scene.title}
      sceneId={scene.id}
      backHref={studioHref()}
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
