/**
 * Relay's pull request page: what the hero's recorded take clicks through.
 * It has no state of its own; the take tells it which tab is open and how far the review has got.
 */

export type PullRequestState = {
  tab: "conversation" | "files";
  approved: boolean;
  merged: boolean;
};

const DIFF: { kind: "" | "add" | "del"; line: number; text: string }[] = [
  { kind: "", line: 12, text: "export function priceFor(plan: Plan, usage: Usage) {" },
  { kind: "del", line: 13, text: "  return plan.flatPrice;" },
  { kind: "add", line: 13, text: "  const included = Math.min(usage.events, plan.includedEvents);" },
  { kind: "add", line: 14, text: "  const extra = usage.events - included;" },
  { kind: "add", line: 15, text: "  return plan.basePrice + extra * plan.pricePerEvent;" },
  { kind: "", line: 16, text: "}" },
  { kind: "", line: 17, text: "" },
  { kind: "add", line: 18, text: "export const PLANS = [starter, team, scale] as const;" },
];

const CHECKS = [
  { name: "Build", detail: "2m 04s" },
  { name: "Tests", detail: "312 passed" },
  { name: "Preview", detail: "relay-pr-312.dev" },
];

export function PullRequest({ tab, approved, merged }: PullRequestState) {
  return (
    <div className="dm dm-pr">
      <header className="pr-top">
        <span className="dm-mark">R</span>
        <span className="pr-top__crumb">
          relay / <b>web</b>
        </span>
        <span className="pr-top__search">Search or jump to…</span>
        <span className="dm-avatar dm-avatar--munk">S</span>
      </header>

      <div className="pr-body">
        <div className="pr-title">
          <h1>
            Usage-based plans <span>#312</span>
          </h1>
          <span className={`dm-pill ${merged ? "dm-pill--dark" : ""}`}>{merged ? "Merged" : "Open"}</span>
        </div>
        <p className="pr-meta">
          <b>maya</b> {merged ? "merged" : "wants to merge"} 9 commits into <code>main</code> from{" "}
          <code>feat/usage-plans</code>
        </p>

        <ul className="pr-tabs">
          <li className={tab === "conversation" ? "is-on" : ""}>
            Conversation <i>3</i>
          </li>
          <li>
            Commits <i>9</i>
          </li>
          <li className={tab === "files" ? "is-on" : ""} data-take="files">
            Files changed <i>4</i>
          </li>
        </ul>

        <div className="pr-grid">
          <div className="pr-col">
            {tab === "conversation" ? (
              <>
                <section className="dm-card pr-note">
                  <p className="pr-note__who">
                    <span className="dm-avatar">M</span> <b>maya</b> opened this 2 hours ago
                  </p>
                  <p>Plans now bill by usage. Here is how the new page moves:</p>
                  <div className="pr-clip">
                    <i>▶</i>
                    <span>plans-reveal.mp4 · 0:18</span>
                  </div>
                </section>
                <ul className="dm-card pr-checks">
                  {CHECKS.map((check) => (
                    <li key={check.name}>
                      <i className="pr-tick">✓</i> <b>{check.name}</b> <span className="pr-checks__detail">{check.detail}</span>
                    </li>
                  ))}
                </ul>
              </>
            ) : (
              <>
                <section className="dm-card pr-file" data-take="diff">
                  <p className="pr-file__head">
                    billing/plans.ts <span>+5 −1</span>
                  </p>
                  <ul className="pr-diff">
                    {DIFF.map((row, index) => (
                      // biome-ignore lint/suspicious/noArrayIndexKey: the lines never reorder
                      <li key={index} className={row.kind ? `is-${row.kind}` : ""}>
                        <i>{row.line}</i>
                        <b>{row.kind === "add" ? "+" : row.kind === "del" ? "−" : " "}</b>
                        <span>{row.text}</span>
                      </li>
                    ))}
                  </ul>
                </section>
                <section className="dm-card pr-review">
                  <p>
                    <b>{merged ? "Merged into main" : approved ? "Approved, checks passed" : "Review these changes"}</b>
                    {merged
                      ? "The branch can be deleted."
                      : approved
                        ? "This pull request is ready to merge."
                        : "3 checks passed. 1 review needed."}
                  </p>
                  {!approved && (
                    <span className="dm-btn dm-btn--quiet" data-take="approve">
                      Approve
                    </span>
                  )}
                  {approved && !merged && (
                    <span className="dm-btn dm-btn--munk" data-take="merge">
                      Merge pull request
                    </span>
                  )}
                  {merged && <span className="dm-pill dm-pill--dark">✓ Merged</span>}
                </section>
              </>
            )}
          </div>

          <aside className="pr-aside">
            <section className="dm-card">
              <h2>Reviewers</h2>
              <ul>
                <li>
                  <span className="dm-avatar dm-avatar--munk">S</span> sam <span className="pr-aside__value">{approved ? "✓ Approved" : "Pending"}</span>
                </li>
              </ul>
            </section>
            <section className="dm-card">
              <h2>Labels</h2>
              <ul>
                <li>
                  <span className="dm-pill">feature</span>
                  <span className="dm-pill dm-pill--plain">billing</span>
                </li>
              </ul>
            </section>
            <section className="dm-card">
              <h2>Checks</h2>
              <ul>
                {CHECKS.map((check) => (
                  <li key={check.name}>
                    <i className="pr-tick">✓</i> {check.name} <span className="pr-aside__value">{check.detail}</span>
                  </li>
                ))}
              </ul>
            </section>
          </aside>
        </div>
      </div>
    </div>
  );
}
