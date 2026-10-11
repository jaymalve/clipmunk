"use client";

import { useEffect, useState } from "react";

const WORDS = ["chip!", "chk-chk", "squeak", "rolling!", "cut!", "one more take"];

type Label = { id: number; x: number; y: number; word: string };

/** Page-wide effect: the word that floats up where Chip is poked. */
export default function FxLayer() {
  const [labels, setLabels] = useState<Label[]>([]);

  useEffect(() => {
    let next = 0;
    function onPoke(event: Event) {
      const { x, y } = (event as CustomEvent<{ x: number; y: number }>).detail;
      const id = ++next;
      const word = WORDS[id % WORDS.length] ?? "chip!";
      setLabels((list) => [...list, { id, x, y, word }]);
      window.setTimeout(() => setLabels((list) => list.filter((label) => label.id !== id)), 1100);
    }
    window.addEventListener("clipmunk:poke", onPoke);
    return () => window.removeEventListener("clipmunk:poke", onPoke);
  }, []);

  return (
    <div className="fx" aria-hidden>
      {labels.map((label) => (
        <span key={label.id} className="fx__label" style={{ left: label.x, top: label.y }}>
          {label.word}
        </span>
      ))}
    </div>
  );
}
