import { Surface } from "@flickjs/record";
import { CustomerTable, MetricCard } from "../../components/dashboard";

// Two flat layers at different depths: each gets one uniform blur, the cheapest path.
export default function RackFocus() {
  return (
    <div style={{ position: "relative", width: 1000, height: 600 }}>
      <Surface id="table" style={{ position: "absolute", left: 200, top: 90, width: 600 }}>
        <CustomerTable />
      </Surface>
      <Surface id="card" style={{ position: "absolute", left: 360, top: 200, width: 280 }}>
        <MetricCard index={0} />
      </Surface>
    </div>
  );
}
