import { useEffect, useMemo, useState } from "react";
import { type CatalogScene, type Issue, motionDuration, RATIOS, type Sequence, type TakeSummary } from "../core";
import type { DaemonClient } from "../recorder";
import { Chrome } from "../studio/Chrome";
import type { DaemonConnection } from "../studio/daemon";
import { onStudioEvent } from "../studio/events";
import { IssueList } from "../studio/IssueList";
import { NewSequence } from "../studio/Library";
import { studioHref } from "../studio/links";
import { ExportQueue } from "./ExportQueue";

/** The Studio's home: every clip in the project as a card, filtered by kind and searched by name,
 * with what is rendering right now, an export panel for several files at once, and a way to start
 * a new scene by asking the coding agent. All of it comes from the daemon.
 */
export type Clip =
  | { kind: "scene"; id: string; title: string; durationMs: number; width: number; height: number; scene: CatalogScene }
  | { kind: "take"; id: string; title: string; durationMs: number; width: number; height: number; take: TakeSummary }
  | {
      kind: "sequence";
      id: string;
      title: string;
      durationMs?: number;
      width: number;
      height: number;
      sequence: Sequence;
    };
type Kind = "all" | Clip["kind"];
const KINDS: { value: Kind; label: string }[] = [
  { value: "all", label: "All" },
  { value: "take", label: "Takes" },
  { value: "scene", label: "Scenes" },
  { value: "sequence", label: "Sequences" },
];

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);
/** "16:9" for a size that has a usual ratio, otherwise the reduced one. */
export function ratioOf(width: number, height: number): string {
  const known = RATIOS.find((ratio) => {
    const [w, h] = ratio.split(":").map(Number) as [number, number];
    return Math.abs(width / height - w / h) < 0.01;
  });
  if (known) return known;
  const divisor = gcd(Math.round(width), Math.round(height)) || 1;
  return `${Math.round(width) / divisor}:${Math.round(height) / divisor}`;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(1)} s`;

/** Progress of the export jobs rendering each clip, from the daemon's event stream. */
function useRendering(client: DaemonClient) {
  const [rendering, setRendering] = useState<Record<string, { done: number; total: number }>>({});
  useEffect(() => {
    return onStudioEvent(client, (raw) => {
      const event = raw as {
        type: string;
        clip?: { kind: string; id: string };
        event?: { type: string; done?: number; total?: number };
      };
      if (event.type !== "job" || !event.clip || !event.event) return;
      const key = `${event.clip.kind}:${event.clip.id}`;
      const job = event.event;
      setRendering((current) => {
        const next = { ...current };
        if (job.type === "progress") next[key] = { done: job.done ?? 0, total: job.total ?? 0 };
        else delete next[key];
        return next;
      });
    });
  }, [client]);
  return rendering;
}

export function ClipLibrary({
  daemon,
  scenes,
  sceneIssues,
}: {
  daemon: DaemonConnection;
  scenes: CatalogScene[];
  sceneIssues: Issue[];
}) {
  const { client } = daemon;
  const [takes, setTakes] = useState<TakeSummary[]>([]);
  const [sequences, setSequences] = useState<Sequence[]>([]);
  const [issues, setIssues] = useState<Issue[]>([]);
  const [themes, setThemes] = useState<string[]>([]);
  const [kind, setKind] = useState<Kind>("all");
  const [query, setQuery] = useState("");
  const [exporting, setExporting] = useState<Clip>();
  const [newScene, setNewScene] = useState(false);
  const rendering = useRendering(client);

  useEffect(() => {
    const load = () => {
      void client.get<{ takes: TakeSummary[] }>("/v1/takes").then((result) => result.ok && setTakes(result.data.takes));
      void client.get<{ sequences: Sequence[]; issues: Issue[] }>("/v1/sequences").then((result) => {
        if (!result.ok) return;
        setSequences(result.data.sequences);
        setIssues(result.data.issues);
      });
      void client
        .get<{ config: { variants?: { themes?: string[] } } }>("/v1/config")
        .then((result) => setThemes(result.ok ? (result.data.config.variants?.themes ?? []) : []));
    };
    load();
    // A take recorded or a sequence saved elsewhere shows up without a reload.
    return onStudioEvent(client, (event) => {
      if (event.type === "take" || event.type === "edit" || event.type === "config") load();
    });
  }, [client]);

  const clips = useMemo<Clip[]>(
    () => [
      ...takes.map((take) => ({
        kind: "take" as const,
        id: take.id,
        title: take.title,
        durationMs: take.durationMs,
        width: take.width,
        height: take.height,
        take,
      })),
      ...scenes.map((scene) => ({
        kind: "scene" as const,
        id: scene.id,
        title: scene.title,
        durationMs: scene.definition.motion ? motionDuration(scene.definition.motion) : 0,
        width: scene.definition.width,
        height: scene.definition.height,
        scene,
      })),
      ...sequences.map((sequence) => ({
        kind: "sequence" as const,
        id: sequence.id,
        title: sequence.title,
        width: sequence.width,
        height: sequence.height,
        sequence,
      })),
    ],
    [takes, scenes, sequences],
  );
  const shown = clips.filter(
    (clip) =>
      (kind === "all" || clip.kind === kind) &&
      (!query.trim() || `${clip.title} ${clip.id}`.toLowerCase().includes(query.trim().toLowerCase())),
  );
  const first = scenes[0]
    ? ({ kind: "scene", id: scenes[0].id } as const)
    : takes[0]
      ? ({ kind: "take", id: takes[0].id } as const)
      : undefined;

  return (
    <Chrome style={{ position: "fixed", inset: 0, overflow: "auto", background: "#000" }}>
      <style>{STYLES}</style>
      <div className="library clips">
        <header className="top">
          <h1>{daemon.status.project}</h1>
          <span className="spacer" />
          <button type="button" onClick={() => setNewScene(true)}>
            New scene
          </button>
        </header>
        <div className="filters">
          <div className="kinds" role="tablist" aria-label="Kind">
            {KINDS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="tab"
                aria-selected={kind === option.value}
                className={kind === option.value ? "on" : ""}
                onClick={() => setKind(option.value)}
              >
                {option.label}
                <span>
                  {option.value === "all" ? clips.length : clips.filter((clip) => clip.kind === option.value).length}
                </span>
              </button>
            ))}
          </div>
          <input
            type="search"
            aria-label="Search clips"
            placeholder="Search by name"
            value={query}
            onChange={(event) => setQuery(event.currentTarget.value)}
          />
        </div>
        {[...sceneIssues, ...issues].length > 0 && (
          <IssueList
            issues={[...sceneIssues, ...issues]}
            title="Some files need a correction."
            style={{ marginBottom: 16 }}
          />
        )}
        {!clips.length && (
          <p className="note">
            Nothing here yet. Press Alt+Shift+R in your app to record a take, or ask your coding agent for a scene.
          </p>
        )}
        <div className="cards">
          {shown.map((clip) => (
            <ClipCard
              key={`${clip.kind}:${clip.id}`}
              clip={clip}
              client={client}
              themes={clip.kind === "scene" ? themes : []}
              rendering={rendering[`${clip.kind}:${clip.id}`]}
              onExport={() => setExporting(clip)}
            />
          ))}
        </div>
        {clips.length > 0 && !shown.length && <p className="note">No clip matches.</p>}
        <NewSequence client={client} first={first} existing={sequences} onProblem={setIssues} />
      </div>
      {exporting && (
        <ExportQueue
          key={`${exporting.kind}:${exporting.id}`}
          clip={exporting}
          client={client}
          themes={exporting.kind === "scene" ? themes : []}
          devUrl={daemon.status.devUrl}
          onClose={() => setExporting(undefined)}
        />
      )}
      {newScene && <NewSceneDialog onClose={() => setNewScene(false)} />}
    </Chrome>
  );
}

function ClipCard(props: {
  clip: Clip;
  client: DaemonClient;
  themes: string[];
  rendering?: { done: number; total: number };
  onExport: () => void;
}) {
  const { clip, rendering } = props;
  const href =
    clip.kind === "scene"
      ? studioHref({ scene: clip.id })
      : clip.kind === "take"
        ? studioHref({ take: clip.id })
        : studioHref({ sequence: clip.id });
  const details = [
    clip.kind === "sequence" ? `${clip.sequence.items.length} clips` : seconds(clip.durationMs),
    `${Math.round(clip.width)}×${Math.round(clip.height)}`,
    ratioOf(clip.width, clip.height),
    ...(props.themes.length ? [`${props.themes.length} themes`] : []),
    ...(clip.kind === "take"
      ? [[clip.take.hasCam && "camera", clip.take.hasAudio && "voice"].filter(Boolean).join(" + ") || "screen only"]
      : []),
  ];
  return (
    <article className="card" data-kind={clip.kind}>
      <a href={href} className="thumb">
        <Thumb clip={clip} client={props.client} />
        <span className="kind">{clip.kind}</span>
        {rendering && (
          <span className="badge rendering">
            Rendering {rendering.total ? `${Math.round((rendering.done / rendering.total) * 100)}%` : "…"}
          </span>
        )}
      </a>
      <div className="meta">
        <a href={href}>
          <b>{clip.title}</b>
        </a>
        <span>{details.join(" · ")}</span>
      </div>
      <button type="button" onClick={props.onExport}>
        Export
      </button>
    </article>
  );
}

function Thumb({ clip, client }: { clip: Clip; client: DaemonClient }) {
  if (clip.kind === "scene" && clip.scene.snapshot) return <img src={clip.scene.snapshot.image} alt="" />;
  if (clip.kind === "take") return <img src={client.url(`/v1/takes/${clip.id}/poster`)} alt="" loading="lazy" />;
  return <span className="none">{clip.kind === "scene" ? "No snapshot yet" : "Sequence"}</span>;
}

/** Clipmunk never writes scenes itself: the developer's coding agent does, from this prompt. */
function NewSceneDialog({ onClose }: { onClose: () => void }) {
  const prompt =
    "Read CLIPMUNK.md and run npx clipmunk guide. Then make a scene of <the page or feature> using this app's real components, check it in the Clipmunk Studio, and save a snapshot.";
  return (
    <div className="dialog" role="dialog" aria-label="New scene">
      <h2>New scene</h2>
      <p>Scenes are written by your coding agent from your app's real components. Paste this to it:</p>
      <textarea readOnly value={prompt} rows={4} />
      <div className="row">
        <button type="button" onClick={() => void navigator.clipboard?.writeText(prompt)}>
          Copy prompt
        </button>
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
}

export const STYLES = `
.clips .top { display: flex; align-items: center; gap: 12px; margin-bottom: 18px; } .clips .spacer { flex: 1; }
.clips button { font: inherit; color: #f4f4f5; background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
.clips button.on { background: #f4f4f5; color: #09090b; }
.filters { display: flex; gap: 12px; align-items: center; margin-bottom: 18px; flex-wrap: wrap; }
.kinds { display: flex; gap: 6px; } .kinds span { margin-left: 6px; opacity: .6; }
.filters input { font: inherit; color: inherit; background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 6px 10px; min-width: 220px; }
.cards { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
.card { background: #0f0f12; border: 1px solid #1f1f23; border-radius: 12px; overflow: hidden; display: flex; flex-direction: column; }
.card .thumb { position: relative; aspect-ratio: 16 / 9; background: #18181b; display: grid; place-items: center; overflow: hidden; }
.card .thumb img { width: 100%; height: 100%; object-fit: cover; } .card .none { color: #52525b; font-size: 13px; }
.card .kind { position: absolute; left: 8px; top: 8px; font-size: 11px; text-transform: uppercase; letter-spacing: .06em; background: rgba(0,0,0,.6); padding: 2px 6px; border-radius: 4px; }
.badge { position: absolute; right: 8px; top: 8px; font-size: 11px; padding: 2px 8px; border-radius: 999px; }
.badge.rendering { background: #4f46e5; color: #fff; }
.card .meta { padding: 10px 12px 4px; display: grid; gap: 2px; } .card .meta a { color: inherit; text-decoration: none; }
.card .meta span { color: #a1a1aa; font-size: 13px; } .card > button { margin: 8px 12px 12px; align-self: flex-start; }
.dialog, .queue { position: fixed; right: 24px; bottom: 24px; width: 380px; background: #111114; border: 1px solid #27272a; border-radius: 14px; padding: 16px 18px; font: 14px/1.45 system-ui, sans-serif; color: #e4e4e7; box-shadow: 0 20px 60px rgba(0,0,0,.6); }
.dialog h2, .queue h2 { margin: 0 0 8px; font-size: 16px; } .dialog textarea { width: 100%; box-sizing: border-box; font: 13px ui-monospace, monospace; background: #09090b; color: #e4e4e7; border: 1px solid #27272a; border-radius: 8px; padding: 8px; }
.dialog .row, .queue .row { display: flex; gap: 8px; margin-top: 10px; flex-wrap: wrap; align-items: center; }
.queue .toggles { display: flex; gap: 6px; flex-wrap: wrap; margin: 6px 0; }
.queue .toggles button { font: inherit; color: #f4f4f5; background: #18181b; border: 1px solid #27272a; border-radius: 999px; padding: 3px 10px; cursor: pointer; }
.queue .toggles button[aria-pressed="true"] { background: #f4f4f5; color: #09090b; }
.queue label { display: inline-flex; gap: 6px; align-items: center; margin-right: 12px; }
.queue ul { list-style: none; padding: 0; margin: 10px 0 0; display: grid; gap: 6px; } .queue li { display: grid; grid-template-columns: 1fr 90px; gap: 8px; align-items: center; font-size: 13px; }
.queue progress { width: 100%; } .queue .count { color: #a1a1aa; } .queue .fine { color: #71717a; font-size: 12px; margin-top: 10px; }
.queue button { font: inherit; color: #f4f4f5; background: #18181b; border: 1px solid #27272a; border-radius: 8px; padding: 6px 12px; cursor: pointer; }
`;
