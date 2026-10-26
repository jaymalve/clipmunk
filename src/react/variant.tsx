import { createContext, type ReactNode, useContext } from "react";
import { parseVariant, type SceneVariant, VARIANT_PARAM } from "../core";

/** The variant a scene is being rendered in: `{ theme?, locale?, ratio? }`. A scene passes it to
 * the host's own providers, for example `<ThemeProvider theme={useSceneVariant().theme}>`, and may
 * read `ratio` to lay out differently; `ratio` is absent for the scene's authored shape.
 */
const SceneVariantContext = createContext<SceneVariant | undefined>(undefined);

export function SceneVariantProvider({ value, children }: { value: SceneVariant; children?: ReactNode }) {
  return <SceneVariantContext.Provider value={value}>{children}</SceneVariantContext.Provider>;
}

export function useSceneVariant(): SceneVariant {
  const provided = useContext(SceneVariantContext);
  if (provided) return provided;
  // Outside the studio's player (a scene rendered some other way), the page address still says.
  return typeof location === "undefined" ? {} : parseVariant(new URLSearchParams(location.search).get(VARIANT_PARAM));
}
