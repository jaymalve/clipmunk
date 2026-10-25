import { createContext, type ReactNode, useContext } from "react";

// The example host's own theming. It knows nothing about Clipmunk; a scene hands it the variant.
export type Theme = "light" | "dark";
const PALETTES = {
  light: { page: "#f4f4f5", card: "#ffffff", text: "#18181b", accent: "#4f46e5" },
  dark: { page: "#18181b", card: "#27272a", text: "#fafafa", accent: "#a5b4fc" },
};
const ThemeContext = createContext<Theme>("light");

export function ThemeProvider({ theme, children }: { theme?: string; children?: ReactNode }) {
  return <ThemeContext.Provider value={theme === "dark" ? "dark" : "light"}>{children}</ThemeContext.Provider>;
}
export const usePalette = () => PALETTES[useContext(ThemeContext)];

export function PlanCard() {
  const palette = usePalette();
  return (
    <div style={{ background: palette.card, color: palette.text, borderRadius: 16, padding: 24, width: 240 }}>
      <div style={{ fontSize: 14, opacity: 0.7 }}>Monthly plan</div>
      <div style={{ fontSize: 36, fontWeight: 700, color: palette.accent }}>$29</div>
    </div>
  );
}
