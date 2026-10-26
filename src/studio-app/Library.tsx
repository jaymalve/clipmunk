import { useEffect, useMemo, useState } from "react";
import {
  type CatalogScene,
  type ClipFreshness,
  DAEMON_HASH,
  exportFormatsOf,
  type Issue,
  motionDuration,
  RATIOS,
  type Sequence,
  sourceLabel,
  type TakeSummary,
} from "../core";
import { type DaemonClient, RECORD_PARAM } from "../recorder";
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

/** Which exported clips are out of date with their sources, kept current by the daemon's events. */
function useStale(client: DaemonClient) {
  const [stale, setStale] = useState<{ clips: ClipFreshness[]; summary: string | null }>({ clips: [], summary: null });
  useEffect(() => {
    const load = () =>
      void client
        .get<{ clips: ClipFreshness[]; summary: string | null }>("/v1/stale")
        .then((result) => result.ok && setStale(result.data));
    load();
    return onStudioEvent(client, (event) => {
      const job = event as { type: string; event?: { type: string } };
      if (event.type === "stale" || (job.type === "job" && job.event?.type === "done")) load();
    });
  }, [client]);
  return stale;
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
  const [posting, setPosting] = useState(false);
  const rendering = useRendering(client);
  const stale = useStale(client);
  const freshnessOf = (clip: Clip) =>
    stale.clips.find((item) => item.stale && item.clip.kind === clip.kind && item.clip.id === clip.id);
  const reexport = (clip: Clip, freshness: ClipFreshness) =>
    void client.post("/v1/exports", {
      clip: { kind: clip.kind, id: clip.id },
      formats: exportFormatsOf(freshness.outputs),
      ...(clip.kind === "scene" && daemon.status.devUrl ? { url: daemon.status.devUrl } : {}),
    });
  // A stale take is a recording of the old UI: it is recorded again in the app, with the recorder open.
  const recordAgain = daemon.status.devUrl
    ? `${new URL(`/?${RECORD_PARAM}=1`, daemon.status.devUrl)}#${DAEMON_HASH}=${client.link.port}.${client.link.token}`
    : undefined;

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
          <button type="button" onClick={() => setPosting(true)}>
            Post to PR
          </button>
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
        {stale.summary && (
          <div className="stale-banner" role="status">
            {stale.summary}
          </div>
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
              freshness={freshnessOf(clip)}
              onExport={() => setExporting(clip)}
              onReexport={(freshness) => reexport(clip, freshness)}
              recordAgain={recordAgain}
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
      {posting && <PostToPr client={client} onClose={() => setPosting(false)} />}
    </Chrome>
  );
}

function ClipCard(props: {
  clip: Clip;
  client: DaemonClient;
  themes: string[];
  rendering?: { done: number; total: number };
  /** Set when the clip was exported and a source file changed since. */
  freshness?: ClipFreshness;
  onExport: () => void;
  onReexport: (freshness: ClipFreshness) => void;
  recordAgain?: string;
}) {
  const { clip, rendering, freshness } = props;
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
    <article className="card" data-kind={clip.kind} data-clip={clip.id}>
      <a href={href} className="thumb">
        <Thumb clip={clip} client={props.client} />
        <span className="kind">{clip.kind}</span>
        {rendering && (
          <span className="badge rendering">
            Rendering {rendering.total ? `${Math.round((rendering.done / rendering.total) * 100)}%` : "…"}
          </span>
        )}
        {freshness && !rendering && (
          <span
            className="badge stale"
            title={freshness.changes.map((change) => `${change.file} ${change.change}`).join("\n")}
          >
            Out of date
          </span>
        )}
      </a>
      <div className="meta">
        <a href={href}>
          <b>{clip.title}</b>
        </a>
        <span>{details.join(" · ")}</span>
        {freshness && (
          <span className="changed">
            {[...new Set(freshness.changes.map((change) => sourceLabel(change.file)))].join(", ")} changed
          </span>
        )}
      </div>
      <div className="actions">
        <button type="button" onClick={props.onExport}>
          Export
        </button>
        {freshness && clip.kind !== "take" && (
          <button type="button" className="primary" onClick={() => props.onReexport(freshness)} disabled={!!rendering}>
            Re-export
          </button>
        )}
        {freshness && clip.kind === "take" && props.recordAgain && (
          <a className="button primary" href={props.recordAgain} target="_blank" rel="noreferrer">
            Record again
          </a>
        )}
      </div>
    </article>
  );
}

function Thumb({ clip, client }: { clip: Clip; client: DaemonClient }) {
  if (clip.kind === "scene" && clip.scene.snapshot) return <img src={clip.scene.snapshot.image} alt="" />;
  if (clip.kind === "take") return <img src={client.url(`/v1/takes/${clip.id}/poster`)} alt="" loading="lazy" />;
  return <span className="none">{clip.kind === "scene" ? "No snapshot yet" : "Sequence"}</span>;
}

/** The PR comment the GitHub Action would write, shown first and posted only on the button,
 * through the developer's own `gh`: nothing else in Clipmunk leaves the machine. */
function PostToPr({ client, onClose }: { client: DaemonClient; onClose: () => void }) {
  const [preview, setPreview] = useState<{ number: number; url: string; comment: string }>();
  const [problem, setProblem] = useState<string>();
  const [posted, setPosted] = useState<{ url: string; updated: boolean }>();
  const [sending, setSending] = useState(false);
  useEffect(() => {
    void client.get<{ number: number; url: string; comment: string }>("/v1/pr").then((result) => {
      if (result.ok) setPreview(result.data);
      else setProblem(result.issues[0]?.message);
    });
  }, [client]);
  const post = async () => {
    setSending(true);
    const result = await client.post<{ url: string; updated: boolean }>("/v1/pr/comment", {});
    setSending(false);
    if (result.ok) setPosted(result.data);
    else setProblem(result.issues[0]?.message);
  };
  return (
    <div className="dialog" role="dialog" aria-label="Post to PR">
      <h2>Post to PR{preview ? ` #${preview.number}` : ""}</h2>
      {!preview && !problem && <p className="note">Looking for this branch's pull request…</p>}
      {problem && <p className="bad">{problem}</p>}
      {preview && !posted && (
        <>
          <p>This comment goes to the pull request, posted with your gh CLI. Nothing is sent until you press Post.</p>
          <textarea readOnly value={preview.comment} rows={10} aria-label="Comment" />
        </>
      )}
      {posted && (
        <p role="status">
          {posted.updated ? "Updated the comment" : "Posted the comment"}:{" "}
          <a href={posted.url} target="_blank" rel="noreferrer">
            {posted.url}
          </a>
        </p>
      )}
      <div className="row">
        {preview && !posted && (
          <button type="button" className="primary" disabled={sending} onClick={() => void post()}>
            {sending ? "Posting…" : `Post to #${preview.number}`}
          </button>
        )}
        <button type="button" onClick={onClose}>
          Close
        </button>
      </div>
    </div>
  );
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
.card .meta span { color: #a1a1aa; font-size: 13px; } .card .meta .changed { color: #fcd34d; }
.card .actions { display: flex; gap: 8px; margin: 8px 12px 12px; align-items: center; }
.clips .primary { background: #f4f4f5; color: #09090b; border-color: #f4f4f5; }
.clips a.button { font: inherit; border: 1px solid #27272a; border-radius: 8px; padding: 6px 12px; text-decoration: none; }
.badge.stale { background: #f59e0b; color: #1c1917; } .dialog .bad { color: #fca5a5; } .dialog a { color: #a5b4fc; word-break: break-all; }
.stale-banner { background: #1c1917; border: 1px solid #78350f; color: #fde68a; border-radius: 10px; padding: 10px 14px; margin-bottom: 16px; }
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
