const QUESTIONS = [
  {
    q: "Is this just another screen recorder?",
    a: "No. A screen recorder captures pixels and leaves the editing to you. Clipmunk runs inside your app, so it knows what you clicked and where every element sits. That is how the cursor, the zooms and the 3D shots come out right without you touching a timeline.",
  },
  {
    q: "How is it different from writing a video in React?",
    a: "Tools for that have you build new components just for the video. Clipmunk films the components you already shipped, with their real providers, data and styles, so the clip cannot drift away from the product.",
  },
  {
    q: "Do I need a coding agent?",
    a: "No. Takes are recorded by hand, and scenes are plain files you can write yourself. An agent just writes them faster. Clipmunk has no AI inside it and never calls one.",
  },
  {
    q: "What does it run on?",
    a: "React 18.2 or 19 with Vite or Next.js, and Node 22 for the command line. Recording and export use Chromium.",
  },
  {
    q: "Where do my recordings go?",
    a: "Into a folder in your project, through a small server that only listens on your own machine. That is the whole journey.",
  },
  {
    q: "Is the music really mine to use?",
    a: "Yes. It is generated in code on your machine, not picked from a library, so there is no licence to check and nobody else with a claim on it.",
  },
];

export default function FAQ() {
  return (
    <section className="section faq" id="faq">
      <div className="wrap faq__in">
        <div className="shead shead--left">
          <h2>Questions, answered.</h2>
          <p>Still curious? Ask Clipmunk. Busy, but surprisingly patient.</p>
        </div>
        <div className="faq__list">
          {QUESTIONS.map((item, index) => (
            <details key={item.q} name="faq" open={index === 0}>
              <summary>
                {item.q}
                <i aria-hidden />
              </summary>
              <p>{item.a}</p>
            </details>
          ))}
        </div>
      </div>
    </section>
  );
}
