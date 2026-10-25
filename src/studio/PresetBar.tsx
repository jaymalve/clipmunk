import { useCallback, useEffect, useState } from "react";
import { PRESET_FIELDS, type Preset, type PresetField } from "../core";
import type { DaemonClient } from "../recorder";
import { onStudioEvent } from "./events";

/** The preset bar above the take editor's preview: the config's presets, each with its one-line
 * summary. Choosing one previews it at once; Apply makes it the edit. "Save current as preset"
 * writes the chosen parts of the edit to clipmunk.config.json. A change to the config on disk
 * (an editor, git, an agent) shows up here without a reload.
 */
type Summary = { name: string; summary: string; preset: Preset };
const FIELD_NAMES: Record<PresetField, string> = {
  canvas: "Frame",
  zoom: "Zoom",
  cursor: "Cursor",
  cam: "Camera",
  audio: "Voice",
  music: "Music",
};

export function PresetBar(props: {
  client: DaemonClient;
  takeId: string;
  /** The preset being previewed, if any. */
  previewing?: string;
  onPreview: (preset: Preset | undefined, name?: string) => void;
  onApply: () => void;
  /** Saves pending edits, so a preset made from the take sees them. */
  beforeSave: () => Promise<void>;
}) {
  const { client } = props;
  const [presets, setPresets] = useState<Summary[]>([]);
  const [saving, setSaving] = useState(false);
  const load = useCallback(
    () =>
      void client
        .get<{ presets: Summary[] }>("/v1/presets")
        .then((result) => result.ok && setPresets(result.data.presets)),
    [client],
  );
  useEffect(() => {
    load();
    return onStudioEvent(client, (event) => {
      if (event.type === "config") load();
    });
  }, [client, load]);

  return (
    <div className="presets" role="toolbar" aria-label="Presets">
      <span className="hint">Presets</span>
      {presets.map((item) => (
        <button
          key={item.name}
          type="button"
          aria-pressed={props.previewing === item.name}
          title={item.summary}
          onClick={() =>
            props.previewing === item.name ? props.onPreview(undefined) : props.onPreview(item.preset, item.name)
          }
        >
          <b>{item.preset.title ?? item.name}</b>
          <span>{item.summary}</span>
        </button>
      ))}
      {!presets.length && <span className="hint">None yet.</span>}
      {props.previewing && (
        <>
          <button type="button" className="apply" onClick={props.onApply}>
            Apply {props.previewing}
          </button>
          <button type="button" onClick={() => props.onPreview(undefined)}>
            Cancel
          </button>
        </>
      )}
      <span className="spacer" />
      <button type="button" onClick={() => setSaving((value) => !value)}>
        Save current as preset
      </button>
      {saving && (
        <SavePreset
          client={client}
          takeId={props.takeId}
          beforeSave={props.beforeSave}
          existing={presets.map((item) => item.name)}
          onSaved={() => {
            setSaving(false);
            load();
          }}
        />
      )}
    </div>
  );
}

function SavePreset(props: {
  client: DaemonClient;
  takeId: string;
  existing: string[];
  beforeSave: () => Promise<void>;
  onSaved: () => void;
}) {
  const [name, setName] = useState("");
  const [fields, setFields] = useState<PresetField[]>(["canvas", "zoom", "cursor"]);
  const [problem, setProblem] = useState<string>();
  const slug = name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
  const replacing = props.existing.includes(slug);
  const save = async () => {
    await props.beforeSave();
    const result = await props.client.post("/v1/presets", {
      name: slug,
      fromTake: props.takeId,
      fields,
      title: name.trim(),
      replace: replacing,
    });
    if (result.ok) props.onSaved();
    else setProblem(result.issues[0]?.message);
  };
  return (
    <div className="save-preset" role="dialog" aria-label="Save current as preset">
      <label className="field">
        <span>Name</span>
        <input
          type="text"
          aria-label="Preset name"
          value={name}
          placeholder="PR walkthrough"
          onChange={(event) => setName(event.currentTarget.value)}
        />
      </label>
      <fieldset className="parts" aria-label="Parts to include">
        {PRESET_FIELDS.map((field) => (
          <label key={field}>
            <input
              type="checkbox"
              checked={fields.includes(field)}
              onChange={() =>
                setFields((current) =>
                  current.includes(field) ? current.filter((item) => item !== field) : [...current, field],
                )
              }
            />
            {FIELD_NAMES[field]}
          </label>
        ))}
      </fieldset>
      <div className="row">
        <button type="button" disabled={!slug || !fields.length} onClick={() => void save()}>
          {replacing ? `Replace ${slug}` : "Save to clipmunk.config.json"}
        </button>
        {problem && <span className="bad">{problem}</span>}
      </div>
    </div>
  );
}
