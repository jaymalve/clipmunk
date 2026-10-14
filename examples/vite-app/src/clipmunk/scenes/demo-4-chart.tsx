import { Beat } from "../../hero/Demo";

export default function DemoChart() {
  return (
    <Beat
      caption="See the trend before the meeting."
      draw={[200, 2000]}
      callout={{ left: 184, top: 196, width: 532, height: 340 }}
    />
  );
}
