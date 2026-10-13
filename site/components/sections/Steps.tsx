import ChipTile from "@/components/ui/ChipTile";
import InView from "@/components/ui/InView";

/** Setup, as three cards. */
export default function Steps() {
  return (
    <section className="section how" id="how">
      <div className="wrap">
        <div className="shead">
          <ChipTile prop="acorn" />
          <h2>Your first product video is a prompt away</h2>
          <p>About five minutes. Most of it spent deciding which feature to show off first.</p>
        </div>

        <InView className="steps" threshold={0.2}>
          <article className="card step">
            <span className="step__num display">01</span>
            <h3>Drop it in</h3>
            <p>
              One command connects Clipmunk to your app and leaves a guide your agent can read. Nothing reaches your
              production build.
            </p>
            <code className="step__cmd mono">
              <span className="munk">$</span> npx clipmunk init
            </code>
            <ul className="step__tags">
              <li>Vite</li>
              <li>Next.js</li>
              <li>React 18 and 19</li>
            </ul>
          </article>

          <article className="card step">
            <span className="step__num display">02</span>
            <h3>Ask, or press record</h3>
            <p>
              Ask your agent for a scene in one sentence. Or press the shortcut and click through the feature yourself.
              Or both.
            </p>
            <p className="step__keys">
              <kbd>Alt</kbd>
              <kbd>Shift</kbd>
              <kbd>R</kbd>
            </p>
            <ul className="step__tags">
              <li>Claude Code</li>
              <li>Cursor</li>
              <li>Codex</li>
              <li>your own two hands</li>
            </ul>
          </article>

          <article className="card step">
            <span className="step__num display">03</span>
            <h3>Export and post it</h3>
            <p>
              Clipmunk renders an MP4 on your machine. Paste it into the PR, the changelog or the docs, and go outside.
            </p>
            <code className="step__cmd mono">
              <span className="munk">$</span> npx clipmunk export --scene plans-reveal
            </code>
            <ul className="step__tags">
              <li>MP4</li>
              <li>1080p</li>
              <li>4K</li>
            </ul>
          </article>
        </InView>
      </div>
    </section>
  );
}
