import { Surface, useSceneTime } from "clipmunk";
import { DashboardScene } from "../../../../site/demo/DashboardScene";
import "../../../../site/demo/demo.css";

/**
 * Relay's dashboard for one shot of the landing page's hero film.
 * `draw` is when the charts start drawing and for how long; `rows` is when the first customer row
 * arrives and the gap before each next one. Leave either out and that part is already finished.
 * The pieces and the view move in jumps, but the charts and numbers run smoothly on scene time.
 */
export function Shot({
  draw,
  rows,
}: {
  draw?: [fromMs: number, forMs: number];
  rows?: [fromMs: number, everyMs: number];
}) {
  const time = useSceneTime();
  const progress = draw ? (time - draw[0]) / draw[1] : 1;
  const arrived = rows ? Math.floor((time - rows[0]) / rows[1]) + 1 : undefined;
  return <DashboardScene Surface={Surface} progress={progress} rows={arrived} />;
}
