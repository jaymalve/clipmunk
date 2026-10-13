import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Customers, Header, RevenueChart, Sidebar, Stats } from "./Dashboard";

/** Clipmunk's Surface, handed in by whoever renders the scene, so this file needs no copy of the SDK. */
type SurfaceLike = ComponentType<{ id: string; children?: ReactNode; content?: ReactNode; style?: CSSProperties }>;

/** The dashboard's sections, in the order they sit in depth. A recipe's nodes must list the same ids. */
export const DASHBOARD_PARTS = ["sidebar", "header", "stats", "chart", "customers"] as const;
export type DashboardPart = (typeof DASHBOARD_PARTS)[number];

/**
 * The dashboard with each section on its own Surface, so a scene can move them apart in depth.
 * It is the same markup as the flat page: one live instance of every component.
 */
export function DashboardScene({
  Surface,
  progress = 1,
  onPoint,
}: {
  Surface: SurfaceLike;
  progress?: number;
  /** Called with the section the pointer is over, for a scene that pulls focus to it. */
  onPoint?: (part: DashboardPart) => void;
}) {
  const point = (part: DashboardPart) => (onPoint ? { onPointerEnter: () => onPoint(part) } : {});
  return (
    <Surface id="page" style={{ width: 1440, height: 900 }} content={<div className="dm dm__bg" />}>
      <div className="dm dm-dash dm-dash--bare">
        <Surface id="sidebar" style={{ height: 900, display: "grid" }}>
          <div {...point("sidebar")}>
            <Sidebar />
          </div>
        </Surface>
        <main className="dash-main">
          <Surface id="header">
            <div {...point("header")}>
              <Header />
            </div>
          </Surface>
          <Surface id="stats">
            <div {...point("stats")}>
              <Stats progress={progress} />
            </div>
          </Surface>
          <div className="dash-row">
            <Surface id="chart">
              <div {...point("chart")}>
                <RevenueChart progress={progress} />
              </div>
            </Surface>
            <Surface id="customers">
              <div {...point("customers")}>
                <Customers progress={progress} />
              </div>
            </Surface>
          </div>
        </main>
      </div>
    </Surface>
  );
}
