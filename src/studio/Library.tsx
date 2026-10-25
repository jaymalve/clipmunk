import { useEffect, useState } from "react";
import type { CatalogScene, Issue, SceneCatalog, Sequence, TakeSummary } from "../core";
import type { DaemonClient } from "../recorder";
import { Chrome } from "./Chrome";
import type { DaemonState } from "./daemon";
import { IssueList } from "./IssueList";
import { studioHref } from "./links";

/** The studio's home: every scene, take and sequence in the project, each a link to open it.
 * Scenes come from the host's bundler; takes and sequences come from the daemon.
 */
const count = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Takes and sequences, loaded once the daemon is connected. */
function useDaemonClips(client: DaemonClient | undefined) {
  const [takes, setTakes] = useState<TakeSummary[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  useEffect(() => {
    if (!client) return;
    void client.get<{ takes: TakeSummary[] }>("/v1/takes").then((result) => result.ok && setTakes(result.data.takes));
    void client.get<{ sequences: Sequence[]; issues: Issue[] }>("/v1/sequences").then((result) => {
      if (!result.ok) return;
      setSequences(result.data.sequences);
      setIssues(result.data.issues);
    });
  }, [client]);
  return { takes, sequences, sequenceIssues: issues, setSequenceIssues: setIssues };
}

function SceneGrid({ scenes }: { scenes: CatalogScene[] }) {
  return (
    <div className="grid">
      {scenes.map((scene, index) => (
        <a key={scene.id} className="tile" href={studioHref({ scene: scene.id })}>
          <span className="thumb">{scene.snapshot ? <img src={scene.snapshot.image} alt="" /> : index + 1}</span>
          <div>
            <b>{scene.title}</b>
            {scene.description && <span>{scene.description}</span>}
          </div>
        </a>
      ))}
    </div>
  );
}

function TakeList({ takes }: { takes: TakeSummary[] }) {
  if (!takes.length) return <p>No takes yet. Press Alt+Shift+R on any page of your app to record one.</p>;
  return (
    <>
      <p>{count(takes.length, "recording")} in .clipmunk/takes</p>
      <div className="rows">
        {takes.map((take) => (
          <a key={take.id} className="row" href={studioHref({ take: take.id })}>
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
  );
}

function SequenceList({ sequences }: { sequences: Sequence[] }) {
  return (
    <div className="rows">
      {sequences.map((sequence) => (
        <a key={sequence.id} className="row" href={studioHref({ sequence: sequence.id })}>
          <b>{sequence.title}</b>
          <span>{count(sequence.items.length, "clip")}</span>
          <span>
            {sequence.width}×{sequence.height}
          </span>
        </a>
      ))}
    </div>
  );
}

/** Name a sequence and create it with one clip in it; the builder opens next. */
export function NewSequence(props: {
  client: DaemonClient;
  /** The clip a new sequence starts with, if the project has any. */
  first: Sequence["items"][number]["clip"] | undefined;
  existing: Sequence[];
  onProblem: (issues: Issue[]) => void;
}) {
  const { client, first } = props;
  const [name, setName] = useState("");
  const id = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  const taken = props.existing.some((sequence) => sequence.id === id);
  const create = async () => {
    if (!first) return;
    const sequence: Sequence = {
      version: 1,
      id,
      title: name.trim(),
      width: 1920,
      height: 1080,
      fps: 60,
      items: [{ clip: first, transition: { kind: "cut", ms: 500 } }],
    };
    const body = new Blob([JSON.stringify(sequence)], { type: "application/json" });
    const result = await client.put<Sequence>(`/v1/sequences/${id}`, body);
    if (result.ok) location.assign(studioHref({ sequence: id }));
    else props.onProblem(result.issues);
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
        value={name}
        onChange={(event) => setName(event.currentTarget.value)}
      />
      <button type="submit" disabled={!id || !first || taken}>
        Create
      </button>
      {!first && <span className="note">Create a scene or record a take first.</span>}
      {taken && <span className="note">A sequence with that name exists.</span>}
    </form>
  );
}

export function Library({
  catalog,
  missing,
  daemon,
}: {
  catalog: SceneCatalog;
  missing?: string;
  daemon?: DaemonState;
}) {
  const client = daemon?.client;
  const { takes, sequences, sequenceIssues, setSequenceIssues } = useDaemonClips(client);
  const firstScene = catalog.scenes[0],
    firstTake = takes[0];
  const firstClip = firstScene
    ? ({ kind: "scene", id: firstScene.id } as const)
    : firstTake
      ? ({ kind: "take", id: firstTake.id } as const)
      : undefined;
  const sceneTitle = missing ? `Scene "${missing}" could not be opened.` : "Some scene files need a correction.";
  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto", background: "#000" }}>
      <div className="library">
        <h1>Scenes</h1>
        <p>
          {catalog.scenes.length ? (
            `${count(catalog.scenes.length, "scene")} in src/clipmunk/scenes`
          ) : (
            <>
              No scenes yet. Ask your coding agent to read <code>CLIPMUNK.md</code> and create one.
            </>
          )}
        </p>
        {catalog.issues.length > 0 && (
          <IssueList issues={catalog.issues} title={sceneTitle} style={{ marginBottom: 24 }} />
        )}
        <SceneGrid scenes={catalog.scenes} />

        <h2>Takes</h2>
        {daemon?.problem ? <p>The daemon is not connected. {daemon.problem.message}</p> : <TakeList takes={takes} />}

        <h2>Sequences</h2>
        {daemon?.problem ? (
          <p>Sequences join scenes and takes into one video. They need the daemon: {daemon.problem.message}</p>
        ) : (
          <>
            <p>
              {sequences.length
                ? `${count(sequences.length, "sequence")} in src/clipmunk/sequences`
                : "Join scenes and takes into one video, with cuts or fades between them."}
            </p>
            {sequenceIssues.length > 0 && <IssueList issues={sequenceIssues} style={{ marginBottom: 16 }} />}
            <SequenceList sequences={sequences} />
            {client && (
              <NewSequence client={client} first={firstClip} existing={sequences} onProblem={setSequenceIssues} />
            )}
          </>
        )}
      </div>
    </Chrome>
  );
}
