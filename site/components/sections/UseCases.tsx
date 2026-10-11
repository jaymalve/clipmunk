import InView from "@/components/ui/InView";

const CURSOR = "M2 1.5v16l4.4-3.9 2.9 6.6 2.7-1.2-2.9-6.5h6.1z";

function Thumb({ className = "" }: { className?: string }) {
  return (
    <span className={`thumb ${className}`}>
      <i className="thumb__play">▶</i>
    </span>
  );
}

/** Six everyday jobs, each with a small moving mock of what Chip hands back. */
export default function UseCases() {
  return (
    <section className="section uses" id="uses">
      <div className="wrap">
        <div className="shead shead--left">
          <h2>Six reasons to stop screen-recording by hand.</h2>
          <p>
            From the pull request you opened this morning to the launch video you have been putting off since spring.
          </p>
        </div>

        <InView className="bento" threshold={0.1}>
          <article className="card use use--wide">
            <div className="use__art">
              <div className="mock">
                <p className="mock__head">
                  <b>jay</b> <span className="dim">commented on #312</span>
                </p>
                <p>Walkthrough of the new plans page:</p>
                <div className="mock__vid">
                  <Thumb />
                  <i className="mock__bar" />
                </div>
                <p className="mock__meta mono">LGTM, and I did not even pull the branch.</p>
              </div>
            </div>
            <p className="label label--munk">PR walkthroughs</p>
            <p className="use__text">
              Show the change, not just the diff. Reviewers watch twenty seconds instead of pulling your branch.
            </p>
          </article>

          <article className="card use use--wide">
            <div className="use__art">
              <ul className="log">
                <li>
                  <Thumb className="thumb--sm" />
                  <span>
                    <b>v2.4</b> Usage-based plans
                  </span>
                  <i className="mono">today</i>
                </li>
                <li>
                  <Thumb className="thumb--sm" />
                  <span>
                    <b>v2.3</b> Bulk invites
                  </span>
                  <i className="mono">Oct 2</i>
                </li>
                <li>
                  <Thumb className="thumb--sm" />
                  <span>
                    <b>v2.2</b> Keyboard shortcuts
                  </span>
                  <i className="mono">Sep 18</i>
                </li>
              </ul>
            </div>
            <p className="label label--munk">Changelog clips</p>
            <p className="use__text">
              Every release note gets a moving picture. Your changelog stops reading like a tax form.
            </p>
          </article>

          <article className="card use">
            <div className="use__art">
              <div className="diff mono">
                <p className="diff__del">− &lt;Button&gt;Save&lt;/Button&gt;</p>
                <p className="diff__add">+ &lt;Button&gt;Publish&lt;/Button&gt;</p>
                <p className="diff__out">
                  <i className="diff__spin" /> plans-reveal.mp4 re-exported
                </p>
              </div>
            </div>
            <p className="label label--munk">Docs that stay current</p>
            <p className="use__text">
              Scenes are files next to your code. When the UI changes, export again and the docs are right again.
            </p>
          </article>

          <article className="card use">
            <div className="use__art">
              <div className="bug">
                <p className="bug__title">
                  <span className="dim">#481</span> Invite does nothing on second click
                </p>
                <div className="bug__frame">
                  <span className="bug__btn">Send invite</span>
                  <i className="bug__ring" />
                  <i className="bug__ring bug__ring--2" />
                  <svg viewBox="0 0 20 22" aria-hidden>
                    <path d={CURSOR} />
                  </svg>
                </div>
              </div>
            </div>
            <p className="label label--munk">Bug reports</p>
            <p className="use__text">
              &ldquo;It breaks when I click here&rdquo; lands better when they can watch you click there.
            </p>
          </article>

          <article className="card use">
            <div className="use__art">
              <ul className="tour">
                <li>
                  <i>▶</i> Create a workspace <span className="mono">0:14</span>
                </li>
                <li>
                  <i>▶</i> Invite your team <span className="mono">0:11</span>
                </li>
                <li>
                  <i>▶</i> Send a first invoice <span className="mono">0:19</span>
                </li>
              </ul>
            </div>
            <p className="label label--munk">Onboarding clips</p>
            <p className="use__text">Short clips of the real product, for the new hire or the new customer.</p>
          </article>

          <article className="card use use--full">
            <div className="use__art use__art--launch">
              <div className="launch">
                <span className="launch__card launch__card--a" />
                <span className="launch__card launch__card--b" />
                <span className="launch__card launch__card--c">
                  <b>Usage-based plans</b>
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <p className="launch__meta mono">launch.mp4 · 4K · 0:42 · lofi</p>
            </div>
            <div>
              <p className="label label--munk">Launch videos</p>
              <p className="use__text">
                The cinematic one. Camera moves, depth of field and a soundtrack, shot on your actual components instead
                of a redrawn copy of them. The one you were going to hire someone for.
              </p>
            </div>
          </article>
        </InView>
      </div>
    </section>
  );
}
