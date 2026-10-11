import { type ComponentType, useEffect, useMemo, useState } from "react";
import {
  type CatalogScene,
  type Issue,
  loadSceneCatalog,
  SCENE_PARAM,
  type SceneCatalog,
  SEQUENCE_PARAM,
  type Sequence,
  STUDIO_PARAM,
  TAKE_PARAM,
  type TakeSummary,
} from "../core";
import { Chrome } from "./Chrome";
import { type DaemonState, useDaemon } from "./daemon";
import { IssueList } from "./IssueList";
import { ScenePreview } from "./ScenePreview";
import { SequenceEditor } from "./SequenceEditor";
import { TakeEditor } from "./TakeEditor";

/** The studio entry the generated host adapter mounts in development.
 * `scenes` maps module paths to lazy loaders for every `<id>.scene.json` and its
 * component. Recipes are loaded to build the library; a component is loaded only
 * when its scene is opened, and only the host's bundler ever executes it.
 */
export type SceneModules = Record<string, () => Promise<unknown>>;
export type FlickStudioProps = { scenes: SceneModules };

const unwrap = (module: unknown) =>
  module && typeof module === "object" && "default" in module ? (module as { default: unknown }).default : module;
const href = (clip?: { scene?: string; take?: string; sequence?: string }) => {
  const params = new URLSearchParams(location.search);
  params.set(STUDIO_PARAM, "1");
  params.delete(SCENE_PARAM);
  params.delete(TAKE_PARAM);
  params.delete(SEQUENCE_PARAM);
  if (clip?.sequence) params.set(SEQUENCE_PARAM, clip.sequence);
  if (clip?.scene) params.set(SCENE_PARAM, clip.scene);
  if (clip?.take) params.set(TAKE_PARAM, clip.take);
  return `?${params}`;
};

export function FlickStudio({ scenes }: FlickStudioProps) {
  const sceneId = useMemo(() => new URLSearchParams(location.search).get(SCENE_PARAM) ?? undefined, []);
  const takeId = useMemo(() => new URLSearchParams(location.search).get(TAKE_PARAM) ?? undefined, []);
  const sequenceId = useMemo(() => new URLSearchParams(location.search).get(SEQUENCE_PARAM) ?? undefined, []);
  const daemon = useDaemon();
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

  if (!catalog) return <div style={{ position: "fixed", inset: 0, background: "#000" }} />;
  if (takeId) return <TakeEditor id={takeId} daemon={daemon} backHref={href()} />;
  if (sequenceId) return <SequenceEditor id={sequenceId} daemon={daemon} scenes={catalog.scenes} backHref={href()} />;
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

function OpenScene({
  scene,
  load,
  daemon,
}: {
  scene: CatalogScene;
  load: () => Promise<unknown>;
  daemon: DaemonState;
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
      backHref={href()}
      daemon={daemon}
      audio={scene.audio}
      music={scene.music}
    >
      <state.Component />
    </ScenePreview>
  );
}

function Library({ catalog, missing, daemon }: { catalog: SceneCatalog; missing?: string; daemon?: DaemonState }) {
  const issues: Issue[] = catalog.issues;
  const [takes, setTakes] = useState<TakeSummary[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [sequenceIssues, setSequenceIssues] = useState<Issue[]>([]);
  const [draft, setDraft] = useState("");
  useEffect(() => {
    if (daemon?.client)
      void daemon.client.get<{ sequences: Sequence[]; issues: Issue[] }>("/v1/sequences").then((result) => {
        if (!result.ok) return;
        setSequences(result.data.sequences);
        setSequenceIssues(result.data.issues);
      });
    if (daemon?.client)
      void daemon.client
        .get<{ takes: TakeSummary[] }>("/v1/takes")
        .then((result) => result.ok && setTakes(result.data.takes));
  }, [daemon]);
  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto", background: "#000" }}>
      <div className="library">
        <h1>Scenes</h1>
        <p>
          {catalog.scenes.length ? (
            `${catalog.scenes.length} scene${catalog.scenes.length === 1 ? "" : "s"} in src/flick/scenes`
          ) : (
            <>
              No scenes yet. Ask your coding agent to read <code>FLICK.md</code> and create one.
            </>
          )}
        </p>
        {issues.length > 0 && (
          <IssueList
            issues={issues}
            title={missing ? `Scene "${missing}" could not be opened.` : "Some scene files need a correction."}
            style={{ marginBottom: 24 }}
          />
        )}
        <div className="grid">
          {catalog.scenes.map((scene, index) => (
            <a key={scene.id} className="tile" href={href({ scene: scene.id })}>
              <span className="thumb">{scene.snapshot ? <img src={scene.snapshot.image} alt="" /> : index + 1}</span>
              <div>
                <b>{scene.title}</b>
                {scene.description && <span>{scene.description}</span>}
              </div>
            </a>
          ))}
        </div>
        <h2>Takes</h2>
        {daemon?.problem ? (
          <p>The daemon is not connected. {daemon.problem.message}</p>
        ) : takes.length === 0 ? (
          <p>No takes yet. Press Alt+Shift+R on any page of your app to record one.</p>
        ) : (
          <>
            <p>
              {takes.length} recording{takes.length === 1 ? "" : "s"} in .flick/takes
            </p>
            <div className="rows">
              {takes.map((take) => (
                <a key={take.id} className="row" href={href({ take: take.id })}>
                  <b>{take.title}</b>
                  <span>{(take.durationMs / 1000).toFixed(1)} s</span>
                  <span>
                    {take.width}×{take.height}
                  </span>
                  <span>
                    {[take.hasCam && "camera", take.hasAudio && "voice"].filter(Boolean).join(" + ") || "screen only"}
                  </span>
                </a>
              ))}
            </div>
          </>
        )}
        <h2>Sequences</h2>
        {daemon?.problem ? (
          <p>Sequences join scenes and takes into one video. They need the daemon: {daemon.problem.message}</p>
        ) : (
          <>
            <p>
              {sequences.length
                ? `${sequences.length} sequence${sequences.length === 1 ? "" : "s"} in src/flick/sequences`
                : "Join scenes and takes into one video, with cuts or fades between them."}
            </p>
            {sequenceIssues.length > 0 && <IssueList issues={sequenceIssues} style={{ marginBottom: 16 }} />}
            <div className="rows">
              {sequences.map((sequence) => (
                <a key={sequence.id} className="row" href={href({ sequence: sequence.id })}>
                  <b>{sequence.title}</b>
                  <span>
                    {sequence.items.length} clip{sequence.items.length === 1 ? "" : "s"}
                  </span>
                  <span>
                    {sequence.width}×{sequence.height}
                  </span>
                </a>
              ))}
            </div>
            {(() => {
              const first = catalog.scenes[0]
                ? ({ kind: "scene", id: catalog.scenes[0].id } as const)
                : takes[0]
                  ? ({ kind: "take", id: takes[0].id } as const)
                  : undefined;
              const id = draft
                .trim()
                .toLowerCase()
                .replace(/[^a-z0-9]+/g, "-")
                .replace(/^-+|-+$/g, "");
              const taken = sequences.some((sequence) => sequence.id === id);
              const create = async () => {
                const body: Sequence = {
                  version: 1,
                  id,
                  title: draft.trim(),
                  width: 1920,
                  height: 1080,
                  fps: 60,
                  items: [{ clip: first!, transition: { kind: "cut", ms: 500 } }],
                };
                const result = await daemon!.client!.put<Sequence>(
                  `/v1/sequences/${id}`,
                  new Blob([JSON.stringify(body)], { type: "application/json" }),
                );
                if (result.ok) location.assign(href({ sequence: id }));
                else setSequenceIssues(result.issues);
              };
              return (
                <form
                  className="new"
                  onSubmit={(event) => {
                    event.preventDefault();
                    if (id && first && !taken) void create();
                  }}
                >
                  <input
                    aria-label="New sequence name"
                    placeholder="New sequence name"
                    value={draft}
                    onChange={(event) => setDraft(event.currentTarget.value)}
                  />
                  <button type="submit" disabled={!id || !first || taken || !daemon?.client}>
                    Create
                  </button>
                  {!first && <span className="note">Create a scene or record a take first.</span>}
                  {taken && <span className="note">A sequence with that name exists.</span>}
                </form>
              );
            })()}
          </>
        )}
      </div>
    </Chrome>
  );
}
