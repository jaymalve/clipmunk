import InView from "@/components/ui/InView";

const RULES = [
  {
    title: "No account. No cloud.",
    text: "There is nothing to sign in to and nowhere to upload to. Recordings and exports stay on your disk.",
  },
  {
    title: "Your app's tab, and only that",
    text: "Chip records the tab your app runs in. Not your desktop, not your messages, not the other forty tabs.",
  },
  {
    title: "Nothing ships to production",
    text: "Clipmunk is a development tool. Your production build never hears about it.",
  },
  {
    title: "Files, not a database",
    text: "Scenes, edits and sequences are JSON in your project. Review a camera move the way you review any other change.",
  },
  {
    title: "Honest about its limits",
    text: "Recording and export run in Chromium. Depth of field is a careful approximation, not ray-traced bokeh. Better you hear it from us.",
  },
];

/** What Clipmunk will not do with a recording of your screen. */
export default function Local() {
  return (
    <section className="section local" id="local">
      <div className="wrap">
        <div className="shead shead--left">
          <h2>A very local chipmunk.</h2>
          <p>
            Something that records your screen should behave itself. Chip does, and everything it gathers stays in the
            burrow.
          </p>
          <div className="shead__actions">
            <a href="#faq" className="btn btn--sm">
              Read the FAQ <span className="chev">›</span>
            </a>
          </div>
        </div>

        <InView className="rules" threshold={0.15}>
          {RULES.map((rule, index) => (
            <article key={rule.title} className="card rule">
              <span className="rule__num mono">{String(index + 1).padStart(2, "0")}</span>
              <h3>{rule.title}</h3>
              <p>{rule.text}</p>
            </article>
          ))}
        </InView>
      </div>
    </section>
  );
}
