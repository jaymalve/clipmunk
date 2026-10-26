import { Surface, useSceneVariant } from "clipmunk";
import { PlanCard, ThemeProvider, usePalette } from "../../components/theme";

// Rendered in each of the config's themes: the variant goes straight to the host's own provider.
export default function ThemedCard() {
  const { theme, ratio } = useSceneVariant();
  return (
    <ThemeProvider theme={theme}>
      <Page tall={ratio === "9:16"} />
    </ThemeProvider>
  );
}

function Page({ tall }: { tall: boolean }) {
  const palette = usePalette();
  const width = tall ? 300 : 400,
    height = tall ? 534 : 300;
  return (
    <div style={{ position: "relative", width, height, background: palette.page }}>
      <Surface id="card" style={{ position: "absolute", left: (width - 288) / 2, top: (height - 130) / 2 }}>
        <PlanCard />
      </Surface>
    </div>
  );
}
