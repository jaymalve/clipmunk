import { Surface, useSceneTime } from "clipmunk";
import { DashboardScene } from "../../../../site/demo/DashboardScene";
import "../../../../site/demo/demo.css";

/**
 * Relay's dashboard for one shot of the landing page's hero film.
 * The charts draw and the numbers count from `drawFrom` for `drawFor` milliseconds of scene time;
 * leave both out for a shot where they are already finished.
 */
export function Shot({ drawFrom, drawFor = 2000 }: { drawFrom?: number; drawFor?: number }) {
  const time = useSceneTime();
  const progress = drawFrom === undefined ? 1 : (time - drawFrom) / drawFor;
  return <DashboardScene Surface={Surface} progress={progress} />;
}
