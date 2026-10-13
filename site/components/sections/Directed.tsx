import InView from "@/components/ui/InView";

type Token = [kind: "k" | "s" | "n" | "p", text: string];

const k = (text: string): Token => ["k", `"${text}"`];
const s = (text: string): Token => ["s", `"${text}"`];
const n = (value: number): Token => ["n", String(value)];
const p = (text: string): Token => ["p", text];

/** A real, valid recipe, trimmed to the parts worth reading. */
const RECIPE: Token[][] = [
  [p("{")],
  [p("  "), k("id"), p(": "), s("plans-reveal"), p(",")],
  [p("  "), k("definition"), p(": {")],
  [p("    "), k("width"), p(": "), n(1920), p(", "), k("height"), p(": "), n(1080), p(",")],
  [p("    "), k("scene"), p(": {")],
  [
    p("      "),
    k("camera"),
    p(": { "),
    k("perspective"),
    p(": "),
    n(1400),
    p(", "),
    k("rotateY"),
    p(": "),
    n(-26),
    p(", "),
    k("rotateX"),
    p(": "),
    n(10),
    p(" },"),
  ],
  [
    p("      "),
    k("focus"),
    p(": { "),
    k("distance"),
    p(": "),
    n(1150),
    p(", "),
    k("fStop"),
    p(": "),
    n(1.6),
    p(", "),
    k("focalLength"),
    p(": "),
    n(100),
    p(" },"),
  ],
  [p("      "), k("nodes"), p(": [{ "), k("id"), p(": "), s("plans"), p(" }]")],
  [p("    },")],
  [p("    "), k("motion"), p(": {")],
  [p("      "), k("durationMs"), p(": "), n(7000), p(",")],
  [p("      "), k("tracks"), p(": [{")],
  [
    p("        "),
    k("target"),
    p(": { "),
    k("kind"),
    p(": "),
    s("camera"),
    p(" }, "),
    k("property"),
    p(": "),
    s("x"),
    p(","),
  ],
  [p("        "), k("keyframes"), p(": [")],
  [p("          { "), k("timeMs"), p(": "), n(0), p(", "), k("value"), p(": "), n(-360), p(" },")],
  [p("          { "), k("timeMs"), p(": "), n(7000), p(", "), k("value"), p(": "), n(300), p(" }")],
  [p("        ]")],
  [p("      }]")],
  [p("    }")],
  [p("  },")],
  [p("  "), k("music"), p(": { "), k("style"), p(": "), s("lofi"), p(" }")],
  [p("}")],
];

const READS = [
  { label: "Surface", text: "plans, which is your real <PlanCards />" },
  { label: "Camera", text: "26° off to the left, tipped 10° down" },
  { label: "Lens", text: "100mm at f/1.6, focused 1150px out" },
  { label: "Motion", text: "slides left to right across 7 seconds" },
  { label: "Music", text: "lofi, timed to the key moments" },
  { label: "Output", text: "1920 × 1080 MP4" },
];

/** A scene recipe next to what it means and what it looks like. */
export default function Directed() {
  return (
    <section className="section directed" id="directed">
      <div className="wrap">
        <div className="shead">
          <h2>Directed in plain JSON.</h2>
          <p>
            A scene is two files in your project: a recipe and a component. Your agent writes them, you can read them,
            and git can diff them.
          </p>
        </div>

        <InView className="dir lit" threshold={0.15}>
          <div className="dir__code">
            <div className="win__bar">
              <span className="win__dots">
                <i />
                <i />
                <i />
              </span>
              src/clipmunk/scenes/plans-reveal.scene.json
            </div>
            <pre className="display">
              {RECIPE.map((line, row) => (
                <span key={row} className="dir__line">
                  <i>{row + 1}</i>
                  {line.map(([kind, text], column) => (
                    <span key={column} className={`tok-${kind}`}>
                      {text}
                    </span>
                  ))}
                  {"\n"}
                </span>
              ))}
            </pre>
          </div>

          <div className="dir__read">
            <div className="shot" aria-hidden>
              <div className="shot__cam">
                <span className="shot__card shot__card--far">
                  <b>$99</b>
                </span>
                <span className="shot__card shot__card--near">
                  <b>$29</b>
                </span>
                <span className="shot__card shot__card--close">
                  <b>$0</b>
                </span>
              </div>
              <span className="shot__badge display">
                <i className="dot dot--live" /> preview · 0:07
              </span>
            </div>
            <dl className="reads">
              {READS.map((read) => (
                <div key={read.label}>
                  <dt className="label">{read.label}</dt>
                  <dd>{read.text}</dd>
                </div>
              ))}
            </dl>
          </div>
        </InView>
        <p className="dir__foot display">
          Don&apos;t fancy writing JSON? Nobody does. That&apos;s what the agent is for.
        </p>
      </div>
    </section>
  );
}
