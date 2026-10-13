import type { ComponentType, CSSProperties, ReactNode } from "react";
import { Customers, Header, RevenueChart, Sidebar, Stat } from "./Dashboard";

/** Clipmunk's Surface, handed in by whoever renders the scene, so this file needs no copy of the SDK. */
type SurfaceLike = ComponentType<{ id: string; children?: ReactNode; content?: ReactNode; style?: CSSProperties }>;

/** Every piece that sits on its own Surface. A recipe's nodes must list the same ids. */
export const DASHBOARD_PARTS = ["sidebar", "header", "stat-0", "stat-1", "stat-2", "stat-3", "chart", "customers"];

/**
 * The dashboard with each piece on its own Surface, so a scene can bring them in one at a time.
 * It is the page's real markup: one live instance of every component.
 */
export function DashboardScene({
  Surface,
  progress = 1,
  rows,
}: {
  Surface: SurfaceLike;
  /** 0 to 1: how far the charts have drawn and the numbers have counted. */
  progress?: number;
  /** How many rows of the customer list have arrived. */
  rows?: number;
}) {
  return (
    <Surface id="page" style={{ width: 1440, height: 900 }} content={<div className="dm dm__bg" />}>
      <div className="dm dm-dash dm-dash--bare">
        <Surface id="sidebar" style={{ height: 900, display: "grid" }}>
          <Sidebar />
        </Surface>
        <main className="dash-main">
          <Surface id="header">
            <Header />
          </Surface>
          <div className="dash-stats">
            {[0, 1, 2, 3].map((index) => (
              <Surface key={index} id={`stat-${index}`}>
                <Stat index={index} progress={progress} />
              </Surface>
            ))}
          </div>
          <div className="dash-row">
            <Surface id="chart">
              <RevenueChart progress={progress} />
            </Surface>
            <Surface id="customers">
              <Customers progress={progress} shown={rows} />
            </Surface>
          </div>
        </main>
      </div>
    </Surface>
  );
}
