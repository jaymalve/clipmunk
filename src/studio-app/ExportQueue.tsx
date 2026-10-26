import { useEffect, useRef, useState } from "react";
import { type ExportFormat, type ExportOutput, type Issue, RATIOS, type Ratio } from "../core";
import type { DaemonClient } from "../recorder";
import { type Clip, ratioOf } from "./Library";

/** The export panel: the shapes and themes to render as toggles, the formats as checkboxes, how
 * many files that makes, and a queue with each file's progress once it runs. One daemon job makes
 * them all (an export job with several outputs).
 */
const FORMATS: { value: ExportFormat; label: string }[] = [
  { value: "mp4", label: "MP4" },
  { value: "gif", label: "GIF" },
  { value: "poster", label: "Poster" },
];
type Planned = { name: string; format: ExportFormat };
type State =
  | { phase: "idle" }
  | { phase: "running"; job: string; done: number; total: number }
  | { phase: "done"; outputs: ExportOutput[] }
  | { phase: "failed"; issues: Issue[] };

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

export function ExportQueue(props: {
  clip: Clip;
  client: DaemonClient;
  themes: string[];
  devUrl?: string;
  onClose: () => void;
}) {
  const { clip, client, themes } = props;
  // Ratios reframe takes and are scene variants; a sequence has its own shape.
  const shapes: Ratio[] = clip.kind === "sequence" ? [] : [...RATIOS];
  const own = ratioOf(clip.width, clip.height);
  const [ratios, setRatios] = useState<Ratio[]>(() =>
    (RATIOS as readonly string[]).includes(own) ? [own as Ratio] : [],
  );
  const [looks, setLooks] = useState<string[]>([]);
  const [formats, setFormats] = useState<ExportFormat[]>(["mp4"]);
  const [state, setState] = useState<State>({ phase: "idle" });
  const events = useRef<EventSource | undefined>(undefined);
  useEffect(() => () => events.current?.close(), []);

  const toggle = <T,>(list: T[], value: T) =>
    list.includes(value) ? list.filter((item) => item !== value) : [...list, value];
  const ratioCount = Math.max(1, ratios.length),
    lookCount = Math.max(1, looks.length);
  const files = ratioCount * lookCount * formats.length;
  const parts = [
    ratios.length > 1 ? plural(ratios.length, "ratio") : undefined,
    looks.length > 1 ? plural(looks.length, "theme") : undefined,
    formats.length > 1 ? plural(formats.length, "format") : undefined,
  ].filter(Boolean);
  const summary = parts.length > 1 ? `${parts.join(" × ")} = ${plural(files, "file")}` : plural(files, "file");

  // The files the job will write, in the order it makes them, for the queue.
  const planned: Planned[] = [];
  for (const ratio of ratios.length ? ratios : [undefined])
    for (const look of looks.length ? looks : [undefined])
      for (const format of formats)
        planned.push({
          name:
            [clip.id, ratio?.replace(":", "x"), look].filter(Boolean).join(".") +
            (format === "poster" ? ".png" : `.${format}`),
          format,
        });
  // Each ratio and theme is one render (most of the work), then its GIF and poster; the job counts
  // 100 for every step, so a file's share of the progress follows from its place in that order.
  const extras = formats.filter((format) => format !== "mp4");
  const steps = extras.length + 1;
  const progressOf = (index: number, done: number) => {
    const combo = Math.floor(index / formats.length);
    const format = planned[index]!.format;
    const step = combo * steps + (format === "mp4" ? 0 : 1 + extras.indexOf(format));
    return Math.max(0, Math.min(1, done / 100 - step));
  };

  const start = async () => {
    const started = await client.post<{ job: string }>("/v1/exports", {
      clip: { kind: clip.kind, id: clip.id },
      formats,
      ...(ratios.length && clip.kind !== "sequence" ? { ratios } : {}),
      ...(looks.length ? { variants: looks } : {}),
      ...(props.devUrl ? { url: props.devUrl } : {}),
    });
    if (!started.ok) return setState({ phase: "failed", issues: started.issues });
    const job = started.data.job;
    setState({ phase: "running", job, done: 0, total: 0 });
    const source = new EventSource(client.url(`/v1/jobs/${job}/events`));
    events.current = source;
    source.onmessage = (message) => {
      const event = JSON.parse(message.data as string) as
        | { type: "progress"; done: number; total: number }
        | { type: "done"; data: { outputs: ExportOutput[] } }
        | { type: "failed"; issues: Issue[] };
      if (event.type === "progress") setState({ phase: "running", job, done: event.done, total: event.total });
      else {
        source.close();
        setState(
          event.type === "done"
            ? { phase: "done", outputs: event.data.outputs }
            : { phase: "failed", issues: event.issues },
        );
      }
    };
  };

  const running = state.phase === "running";
  return (
    <section className="queue" aria-label="Export">
      <h2>Export {clip.title}</h2>
      {shapes.length > 0 && (
        <>
          <div>Ratios</div>
          <div className="toggles">
            {shapes.map((ratio) => (
              <button
                key={ratio}
                type="button"
                aria-pressed={ratios.includes(ratio)}
                disabled={running}
                onClick={() => setRatios((current) => toggle(current, ratio))}
              >
                {ratio}
              </button>
            ))}
          </div>
        </>
      )}
      {themes.length > 0 && (
        <>
          <div>Themes</div>
          <div className="toggles">
            {themes.map((theme) => (
              <button
                key={theme}
                type="button"
                aria-pressed={looks.includes(theme)}
                disabled={running}
                onClick={() => setLooks((current) => toggle(current, theme))}
              >
                {theme}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="row">
        {FORMATS.map((format) => (
          <label key={format.value}>
            <input
              type="checkbox"
              checked={formats.includes(format.value)}
              disabled={running}
              onChange={() =>
                setFormats((current) => {
                  const next = toggle(current, format.value);
                  return FORMATS.map((item) => item.value).filter((value) => next.includes(value));
                })
              }
            />
            {format.label}
          </label>
        ))}
      </div>
      <div className="row">
        <span className="count">{summary}</span>
        <span style={{ flex: 1 }} />
        {running ? (
          <button type="button" onClick={() => void client.remove(`/v1/jobs/${state.job}`)}>
            Cancel
          </button>
        ) : (
          <button type="button" disabled={!formats.length} onClick={() => void start()}>
            Export {plural(files, "file")}
          </button>
        )}
        <button type="button" onClick={props.onClose}>
          Close
        </button>
      </div>
      {(running || state.phase === "done") && (
        <ul>
          {(state.phase === "done"
            ? state.outputs.map((output) => ({ name: output.output, value: 1 }))
            : planned.map((file, index) => ({ name: file.name, value: progressOf(index, state.done) }))
          ).map((file) => (
            <li key={file.name}>
              <span>{file.name.split("/").pop()}</span>
              <progress max={1} value={file.value} aria-label={`${file.name} progress`} />
            </li>
          ))}
        </ul>
      )}
      {state.phase === "failed" && (
        <p className="issues" role="alert">
          {state.issues.map((issue) => issue.message).join(" ")}
        </p>
      )}
      <p className="fine">Files land in .clipmunk/exports. Nothing is uploaded.</p>
    </section>
  );
}
