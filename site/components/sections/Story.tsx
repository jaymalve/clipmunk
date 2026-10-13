import Chip from "@/components/chip/Chip";
import InView from "@/components/ui/InView";

/** The comic: one feature, from merge to a clip in the pull request. */
export default function Story() {
  return (
    <section className="section story" id="story">
      <div className="wrap">
        <div className="shead">
          <h2>A feature, in four panels.</h2>
          <p>
            The part where you would normally open a screen recorder, sigh, and do it four times. Which, from now on, is
            Clipmunk&apos;s job.
          </p>
        </div>

        <InView className="strip" threshold={0.2}>
          <figure className="panel panel--1">
            <div className="panel__art">
              <div className="pr">
                <p className="pr__title">
                  feat(billing): usage-based plans <span className="dim">#312</span>
                </p>
                <p className="pr__meta">
                  <span className="pr__state">⇄ Merged</span> jay merged 9 commits into main
                </p>
                <span className="pr__btn">Merge pull request</span>
              </div>
              <span className="panel__sfx panel__sfx--tl">click.</span>
            </div>
            <figcaption>
              <time className="display">4:58 PM</time>
              You merge #312. It&apos;s good. Nobody has seen it move.
            </figcaption>
          </figure>

          <figure className="panel panel--2">
            <div className="panel__art">
              <div className="term display">
                <p>
                  <span className="munk">›</span> make a clip of the new plans page
                </p>
                <p className="dim">Reading CLIPMUNK.md</p>
                <p className="dim">Found &lt;PlanCards /&gt; and &lt;UsageChart /&gt;</p>
                <p>
                  Writing plans-reveal.scene.json
                  <i className="term__caret" />
                </p>
              </div>
            </div>
            <figcaption>
              <time className="display">4:59 PM</time>
              You ask your agent for a clip. In one sentence. Lowercase.
            </figcaption>
          </figure>

          <figure className="panel panel--3">
            <div className="panel__art">
              <div className="set">
                <span className="set__card set__card--back" />
                <span className="set__card set__card--mid" />
                <span className="set__card set__card--front">
                  <b>$29</b>
                  <i>Team</i>
                </span>
              </div>
              <Chip prop="clapper" eye="wide" className="panel__chip is-clapped" />
              <span className="panel__sfx panel__sfx--tr">CLACK!</span>
            </div>
            <figcaption>
              <time className="display">5:03 PM</time>
              Clipmunk picks a lens, pulls focus, and calls action on your real components.
            </figcaption>
          </figure>

          <figure className="panel panel--4">
            <div className="panel__art">
              <div className="cmt">
                <p className="cmt__who">
                  <b>jay</b> <span className="dim">commented just now</span>
                </p>
                <p>Here&apos;s how it moves 👇</p>
                <div className="cmt__vid">
                  <span className="cmt__play">▶</span>
                  <span className="cmt__len display">0:18</span>
                  <i className="cmt__bar" />
                </div>
                <p className="cmt__react">
                  <span>🔥 7</span>
                  <span>👀 4</span>
                  <span>🚀 2</span>
                </p>
              </div>
            </div>
            <figcaption>
              <time className="display">5:06 PM</time>
              The clip is in the PR before your coffee is cold.
            </figcaption>
          </figure>
        </InView>

        <div className="story__foot display">
          <span>SFX: a screen recorder, not opening</span>
          <span>To be continued… (every release)</span>
        </div>
      </div>
    </section>
  );
}
