import { Surface, useSceneTime } from "clipmunk";
import { DashboardScene } from "../../../../site/demo/DashboardScene";
import "../../../../site/demo/demo.css";

/** Stop motion moves in poses, not glides: scene time is held for this long, then jumps. */
const POSE_MS = 100;

/**
 * Relay's dashboard for one shot of the landing page's hero film.
 * `draw` is when the charts start drawing and for how long; `rows` is when the first customer row
 * arrives and the gap before each next one. Leave either out and that part is already finished.
 */
export function Shot({
  draw,
  rows,
}: {
  draw?: [fromMs: number, forMs: number];
  rows?: [fromMs: number, everyMs: number];
}) {
  const pose = Math.floor(useSceneTime() / POSE_MS) * POSE_MS;
  const progress = draw ? (pose - draw[0]) / draw[1] : 1;
  const arrived = rows ? Math.floor((pose - rows[0]) / rows[1]) + 1 : undefined;
  return <DashboardScene Surface={Surface} progress={progress} rows={arrived} />;
}
