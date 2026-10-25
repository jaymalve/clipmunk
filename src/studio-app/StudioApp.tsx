import { useEffect, useMemo, useState } from "react";
import { type CatalogScene, type Issue, SCENE_PARAM, SEQUENCE_PARAM, TAKE_PARAM } from "../core";
import { Chrome } from "../studio/Chrome";
import { type DaemonConnection, useDaemon } from "../studio/daemon";
import { studioHref } from "../studio/links";
import { SequenceEditor } from "../studio/SequenceEditor";
import { TakeEditor } from "../studio/TakeEditor";
import { onStudioEvent } from "./events";
import { FramedScene } from "./FramedScene";
import { ClipLibrary } from "./Library";

/** The standalone Studio, served by the daemon. It needs nothing from the host app except for
 * scene previews, which it shows in an iframe of the host's frame page. Takes, sequences and
 * export work while the host is not running. It routes by query string, like the in-app studio.
 */
export function StudioApp() {
  const daemon = useDaemon();
  const params = useMemo(() => new URLSearchParams(location.search), []);
  const sceneId = params.get(SCENE_PARAM) ?? undefined;
  const takeId = params.get(TAKE_PARAM) ?? undefined;
  const sequenceId = params.get(SEQUENCE_PARAM) ?? undefined;
  const scenes = useScenes(daemon?.client ? daemon : undefined);

  if (!daemon) return null;
  if (!daemon.client)
    return (
      <Chrome style={{ position: "fixed", inset: 0, overflow: "auto" }}>
        <div className="library">
          <h1>Clipmunk Studio</h1>
          <p className="note">{daemon.problem.message}</p>
        </div>
      </Chrome>
    );
  if (takeId) return <TakeEditor id={takeId} daemon={daemon} backHref={studioHref()} />;
  if (!scenes) return null;
  if (sequenceId)
    return <SequenceEditor id={sequenceId} daemon={daemon} scenes={scenes.scenes} backHref={studioHref()} />;
  const selected = sceneId ? scenes.scenes.find((scene) => scene.id === sceneId) : undefined;
  if (selected) return <FramedScene key={selected.id} scene={selected} daemon={daemon} />;
  return <ClipLibrary daemon={daemon} scenes={scenes.scenes} sceneIssues={scenes.issues} />;
}

/** Scene recipes as the daemon reads them from disk, refreshed when one changes. */
function useScenes(daemon: DaemonConnection | undefined) {
  const [catalog, setCatalog] = useState<{ scenes: CatalogScene[]; issues: Issue[] }>();
  const client = daemon?.client;
  useEffect(() => {
    if (!client) return;
    let current = true;
    const load = () =>
      void client.get<{ scenes: CatalogScene[]; issues: Issue[] }>("/v1/scenes?detail=1").then((result) => {
        if (current) setCatalog(result.ok ? result.data : { scenes: [], issues: result.issues });
      });
    load();
    const stop = onStudioEvent(client, (event) => {
      if (event.type === "edit" && event.kind === "scene") load();
    });
    return () => {
      current = false;
      stop();
    };
  }, [client]);
  return catalog;
}
