import { Surface, useSceneTime } from "@flickjs/record";
import { CustomerTable, Header, Metrics, RevenueChart, Sidebar } from "../../components/dashboard";

// The chart's own reveal follows scene time instead of a wall-clock animation.
function Chart() {
  const time = useSceneTime();
  return <RevenueChart progress={Math.min(1, Math.max(0, (time - 2200) / 2600))} />;
}

export default function Plating() {
  return (
    <Surface
      id="page"
      style={{ width: 1400, height: 980 }}
      content={<div style={{ position: "absolute", width: 1400, height: 980, background: "#f5f7fb" }} />}
    >
      <div className="dash" style={{ background: "none", minHeight: 0, height: 980 }}>
        <Surface id="sidebar" style={{ height: 980, display: "grid" }}><Sidebar /></Surface>
        <main className="main">
          <Surface id="header"><Header /></Surface>
          <Surface id="metrics"><Metrics /></Surface>
          <div className="row">
            <Surface id="chart"><Chart /></Surface>
            <Surface id="customers"><CustomerTable /></Surface>
          </div>
        </main>
      </div>
    </Surface>
  );
}
