import { Surface, useSceneTime } from "clipmunk";
import { DashboardScene } from "../../../../site/demo/DashboardScene";
import "../../../../site/demo/demo.css";
import "./demo-video.css";

/** Words that rise into place one after another, the way launch videos set their captions. */
function Words({
  text,
  from = 150,
  every = 85,
  accent,
}: {
  text: string;
  from?: number;
  every?: number;
  accent?: string;
}) {
  const time = useSceneTime();
  // Each word keeps its place in the line as its identity; a caption never reorders.
  const words = text.split(" ").map((word, place) => ({ word, id: `${place}:${word}` }));
  return (
    <>
      {words.map(({ word, id }, index) => {
        const local = Math.min(1, Math.max(0, (time - from - index * every) / 420));
        const eased = 1 - (1 - local) ** 3;
        return (
          <span
            key={id}
            className={accent && word.replace(/[.,]/g, "") === accent ? "is-munk" : undefined}
            style={{ opacity: eased, transform: `translateY(${(1 - eased) * 18}px)` }}
          >
            {index ? ` ${word}` : word}
          </span>
        );
      })}
    </>
  );
}

/** The dashboard's progress for a shot: when its charts start drawing and for how long. */
function useDraw(draw?: [fromMs: number, forMs: number]) {
  const time = useSceneTime();
  return draw ? (time - draw[0]) / draw[1] : 1;
}

function App({ draw, rows }: { draw?: [number, number]; rows?: [number, number] }) {
  const time = useSceneTime();
  const progress = useDraw(draw);
  const arrived = rows ? Math.floor((time - rows[0]) / rows[1]) + 1 : undefined;
  return (
    <div className="dv__fit">
      <DashboardScene Surface={Surface} progress={progress} rows={arrived} />
    </div>
  );
}

const CHROME = <div className="dv__chrome" />;

/**
 * One feature beat: a caption above, the app in a window below. The window, the app inside it and
 * the callout are Surfaces, so the recipe moves them; the caption and the charts run on scene time.
 */
export function Beat({
  caption,
  draw,
  rows,
  callout,
}: {
  caption: string;
  draw?: [number, number];
  rows?: [number, number];
  /** Where the orange ring sits, in the app window's own pixels. */
  callout?: { left: number; top: number; width: number; height: number };
}) {
  return (
    <Surface id="stage" style={{ width: 1440, height: 900 }} content={<div className="dv__bg" />}>
      <div className="dv">
        <Surface id="caption" style={{ position: "absolute", left: 0, top: 58, width: 1440 }}>
          <p className="dv__caption">
            <Words text={caption} />
          </p>
        </Surface>
        <Surface
          id="window"
          content={CHROME}
          style={{
            position: "absolute",
            left: 200,
            top: 190,
            width: 1040,
            height: 682,
            overflow: "hidden",
            borderRadius: 16,
          }}
        >
          <Surface id="app" style={{ position: "absolute", left: 0, top: 32, width: 1040, height: 650 }}>
            <App draw={draw} rows={rows} />
            {callout && (
              <Surface id="callout" style={{ position: "absolute", ...callout }}>
                <div className="dv__callout" style={{ inset: 0 }} />
              </Surface>
            )}
          </Surface>
          <Surface id="bar" style={{ position: "absolute", left: 0, top: 0, width: 1040, height: 32 }}>
            <p className="dv__bar">
              <i />
              <i />
              <i />
              relay.dev/overview
            </p>
          </Surface>
        </Surface>
      </div>
    </Surface>
  );
}

/** The opening and closing cards: the product's mark and one line. */
export function Card({ title, accent, note }: { title: string; accent?: string; note?: string }) {
  return (
    <Surface id="stage" style={{ width: 1440, height: 900 }} content={<div className="dv__bg" />}>
      <div className="dv">
        <Surface id="mark" style={{ position: "absolute", left: 0, top: 0, width: 1440, height: 900 }}>
          <div className="dv-card">
            <p className="dv-card__brand">
              <span className="dv-card__mark">R</span> Relay
            </p>
            <p className="dv-card__title">
              <Words text={title} from={350} accent={accent} />
            </p>
            {note && (
              <p className="dv-card__note">
                <Words text={note} from={1100} every={60} />
              </p>
            )}
          </div>
        </Surface>
      </div>
    </Surface>
  );
}
