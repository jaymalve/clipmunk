import { Surface } from "clipmunk";
import { Dashboard } from "../../components/dashboard";

export default function PageSurvey() {
  return (
    <Surface id="page" style={{ width: 1400, height: 980 }}>
      <Dashboard />
    </Surface>
  );
}
