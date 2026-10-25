import { useEffect, useState } from "react";
import type { Sequence, TakeSummary } from "../core";
import type { DaemonClient } from "../recorder";
import { studioHref } from "./links";

/** The editor's left rail: every take, scene and sequence, so another clip is one click away. */
type Entry = { kind: "take" | "scene" | "sequence"; id: string; title: string };

export function Rail({ client, current }: { client: DaemonClient; current: { kind: Entry["kind"]; id: string } }) {
  const [entries, setEntries] = useState<Entry[]>([]);
  useEffect(() => {
    let live = true;
    void Promise.all([
      client.get<{ takes: TakeSummary[] }>("/v1/takes"),
      client.get<{ scenes: { id: string; title: string }[] }>("/v1/scenes"),
      client.get<{ sequences: Sequence[] }>("/v1/sequences"),
    ]).then(([takes, scenes, sequences]) => {
      if (!live) return;
      setEntries([
        ...(takes.ok
          ? takes.data.takes.map((take) => ({ kind: "take" as const, id: take.id, title: take.title }))
          : []),
        ...(scenes.ok
          ? scenes.data.scenes.map((scene) => ({ kind: "scene" as const, id: scene.id, title: scene.title }))
          : []),
        ...(sequences.ok
          ? sequences.data.sequences.map((sequence) => ({
              kind: "sequence" as const,
              id: sequence.id,
              title: sequence.title,
            }))
          : []),
      ]);
    });
    return () => {
      live = false;
    };
  }, [client]);
  const groups: { kind: Entry["kind"]; label: string }[] = [
    { kind: "take", label: "Takes" },
    { kind: "scene", label: "Scenes" },
    { kind: "sequence", label: "Sequences" },
  ];
  return (
    <nav className="rail" aria-label="Clips">
      <a href={studioHref()} className="home">
        ← Library
      </a>
      {groups.map((group) => {
        const items = entries.filter((entry) => entry.kind === group.kind);
        if (!items.length) return null;
        return (
          <div key={group.kind}>
            <h3>{group.label}</h3>
            {items.map((entry) => (
              <a
                key={entry.id}
                href={studioHref({ [entry.kind]: entry.id })}
                aria-current={entry.kind === current.kind && entry.id === current.id ? "page" : undefined}
              >
                {entry.title}
              </a>
            ))}
          </div>
        );
      })}
    </nav>
  );
}
