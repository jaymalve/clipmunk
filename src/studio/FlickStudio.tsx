import { useEffect, useMemo, useState, type ComponentType } from "react";
import { SCENE_PARAM, STUDIO_PARAM, loadSceneCatalog, type CatalogScene, type Issue, type SceneCatalog } from "../core";
import { Chrome } from "./Chrome";
import { ScenePreview } from "./ScenePreview";

/** The studio entry the generated host adapter mounts in development.
 * `scenes` maps module paths to lazy loaders for every `<id>.scene.json` and its
 * component. Recipes are loaded to build the library; a component is loaded only
 * when its scene is opened, and only the host's bundler ever executes it.
 */
export type SceneModules = Record<string, () => Promise<unknown>>;
export type FlickStudioProps = { scenes: SceneModules };

const unwrap = (module: unknown) => (module && typeof module === "object" && "default" in module ? (module as { default: unknown }).default : module);
const href = (sceneId?: string) => {
  const params = new URLSearchParams(location.search);
  params.set(STUDIO_PARAM, "1");
  if (sceneId) params.set(SCENE_PARAM, sceneId);
  else params.delete(SCENE_PARAM);
  return `?${params}`;
};

export function FlickStudio({ scenes }: FlickStudioProps) {
  const sceneId = useMemo(() => new URLSearchParams(location.search).get(SCENE_PARAM) ?? undefined, []);
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
      const result = loadSceneCatalog({ sources: loaded.filter((source) => !("error" in source)), bindings: paths, sceneId });
      for (const source of loaded) if ("error" in source) result.issues.push({ code: "unreadable-scene", path: source.path, message: `Could not load this recipe: ${source.error}` });
      setCatalog(result);
    });
    return () => {
      current = false;
    };
  }, [scenes, sceneId]);

  if (!catalog) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  if (catalog.selected) return <OpenScene key={catalog.selected.id} scene={catalog.selected} load={scenes[catalog.selected.binding]!} />;
  return <Library catalog={catalog} missing={sceneId} />;
}

function OpenScene({ scene, load }: { scene: CatalogScene; load: () => Promise<unknown> }) {
  const [state, setState] = useState<{ Component?: ComponentType; error?: string }>({});
  useEffect(() => {
    let current = true;
    load().then(
      (module) => {
        const Component = unwrap(module);
        if (!current) return;
        setState(typeof Component === "function" ? { Component: Component as ComponentType } : { error: `${scene.binding} must default-export a React component.` });
      },
      (error: unknown) => current && setState({ error: error instanceof Error ? error.message : String(error) }),
    );
    return () => {
      current = false;
    };
  }, [load, scene.binding]);

  if (state.error) return <Library catalog={{ scenes: [], issues: [{ code: "component-failed", path: scene.binding, message: state.error }] }} />;
  if (!state.Component) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  return (
    <ScenePreview definition={scene.definition} title={scene.title} sceneId={scene.id} backHref={href()}>
      <state.Component />
    </ScenePreview>
  );
}

function Library({ catalog, missing }: { catalog: SceneCatalog; missing?: string }) {
  const issues: Issue[] = catalog.issues;
  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto", background: "#000" }}>
      <div className="library">
        <h1>Scenes</h1>
        <p>
          {catalog.scenes.length
            ? `${catalog.scenes.length} scene${catalog.scenes.length === 1 ? "" : "s"} in src/flick/scenes`
            : <>No scenes yet. Ask your coding agent to read <code>FLICK.md</code> and create one.</>}
        </p>
        {issues.length > 0 && (
          <div className="issues" role="alert" style={{ marginBottom: 24 }}>
            <strong>{missing ? `Scene "${missing}" could not be opened.` : "Some scene files need a correction."}</strong>
            <ul>
              {issues.map((issue, index) => (
                <li key={index}>
                  {issue.path && <code>{issue.path}: </code>}
                  {issue.message}
                </li>
              ))}
            </ul>
          </div>
        )}
        <div className="grid">
          {catalog.scenes.map((scene, index) => (
            <a key={scene.id} className="tile" href={href(scene.id)}>
              <span className="thumb">{scene.snapshot ? <img src={scene.snapshot.image} alt="" /> : index + 1}</span>
              <div>
                <b>{scene.title}</b>
                {scene.description && <span>{scene.description}</span>}
              </div>
            </a>
          ))}
        </div>
      </div>
    </Chrome>
  );
}
