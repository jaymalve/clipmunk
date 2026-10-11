import type { ReactNode } from "react";

/** The labelled controls the editors are built from. */
export const percent = (value: number) => `${Math.round(value * 100)}%`;
export const times = (value: number) => `${value.toFixed(1)}×`;

export function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

export function Slider(props: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  format: (value: number) => string;
  onChange: (value: number) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <input
        type="range"
        min={props.min}
        max={props.max}
        step={props.step}
        value={props.value}
        onChange={(event) => props.onChange(Number(event.currentTarget.value))}
      />
      <output>{props.format(props.value)}</output>
    </label>
  );
}

export function Check({
  label,
  value,
  onChange,
}: {
  label: string;
  value: boolean;
  onChange: (value: boolean) => void;
}) {
  return (
    <label className="field check">
      <input type="checkbox" checked={value} onChange={(event) => onChange(event.currentTarget.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** A dropdown. `names` gives display text for values; otherwise the value is shown capitalised. */
export function Select<T extends string>(props: {
  label: string;
  value: T;
  options: readonly T[];
  names?: Partial<Record<T, string>>;
  onChange: (value: T) => void;
}) {
  return (
    <label className="field">
      <span>{props.label}</span>
      <select value={props.value} onChange={(event) => props.onChange(event.currentTarget.value as T)}>
        {props.options.map((option) => (
          <option key={option} value={option}>
            {props.names?.[option] ?? option[0]!.toUpperCase() + option.slice(1)}
          </option>
        ))}
      </select>
    </label>
  );
}
