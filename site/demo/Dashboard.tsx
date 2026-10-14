/**
 * Acme's dashboard: the page the hero's film is shot on.
 * Plain React with no state. `progress` runs from 0 to 1 and draws the charts and counts the numbers
 * up, so a scene can drive them from its own clock and an ordinary page can leave them finished.
 */

const NAV = ["Overview", "Revenue", "Customers", "Invoices", "Reports"];

const STATS = [
  { label: "Monthly revenue", value: 84210, prefix: "$", delta: "+12.4%", spark: [8, 10, 9, 13, 12, 16, 15, 19, 22] },
  { label: "Active customers", value: 3482, prefix: "", delta: "+4.1%", spark: [12, 12, 13, 13, 15, 14, 16, 17, 18] },
  { label: "Churn", value: 1.9, prefix: "", suffix: "%", delta: "−0.3%", spark: [16, 15, 15, 13, 14, 12, 11, 11, 9] },
  { label: "Net promoter", value: 62, prefix: "", delta: "+5", spark: [9, 10, 12, 11, 13, 15, 14, 17, 19] },
];

const WEEKS = [38, 41, 40, 47, 52, 50, 58, 63, 61, 70, 77, 84];

const CUSTOMERS = [
  { name: "Northwind Labs", plan: "Scale", amount: 12400, share: 1 },
  { name: "Helios Freight", plan: "Team", amount: 9860, share: 0.8 },
  { name: "Juniper & Co", plan: "Scale", amount: 8120, share: 0.66 },
  { name: "Atlas Robotics", plan: "Enterprise", amount: 6900, share: 0.56 },
  { name: "Lumen Health", plan: "Team", amount: 5120, share: 0.41 },
];

const clamp = (value: number) => Math.min(1, Math.max(0, value));
/** Fast at first, then settling: how a number counts up without looking mechanical. */
const settle = (value: number) => 1 - (1 - clamp(value)) ** 3;

function count(value: number, progress: number) {
  const now = value * settle(progress);
  return Number.isInteger(value) ? Math.round(now).toLocaleString("en-US") : now.toFixed(1);
}

function line(points: number[], width: number, height: number, top: number) {
  const max = Math.max(...points),
    min = Math.min(...points);
  return points.map((point, index) => {
    const x = (index / (points.length - 1)) * width;
    const y = top + (1 - (point - min) / (max - min)) * (height - top);
    return [x, y] as const;
  });
}

const path = (dots: readonly (readonly [number, number])[]) =>
  dots.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");

export function Sidebar() {
  return (
    <aside className="dash-side">
      <p className="dash-side__brand">
        <span className="dm-mark">A</span> Acme
      </p>
      <ul>
        {NAV.map((item, index) => (
          <li key={item} className={index === 0 ? "is-on" : ""}>
            <i /> {item}
          </li>
        ))}
      </ul>
      <p className="dash-side__foot">
        <span className="dm-avatar dm-avatar--munk">A</span>
        <b>
          Alvin Okafor <span>Acme · Scale plan</span>
        </b>
      </p>
    </aside>
  );
}

export function Header() {
  return (
    <header className="dash-head">
      <div>
        <h1>Good morning, Alvin</h1>
        <p>Here is how Acme is doing this week.</p>
      </div>
      <div className="dash-head__tools">
        <p className="dash-range">
          <span>7d</span>
          <span>30d</span>
          <span className="is-on">12w</span>
        </p>
        <span className="dm-btn dm-btn--munk">New report</span>
      </div>
    </header>
  );
}

export function Stat({ index, progress = 1 }: { index: number; progress?: number }) {
  const stat = STATS[index % STATS.length]!;
  const dots = line(stat.spark, 260, 30, 4);
  return (
    <section className="dm-card dash-stat">
      <p className="dash-stat__label">
        {stat.label} <span className="dm-pill">{stat.delta}</span>
      </p>
      <p className="dash-stat__value">
        {stat.prefix}
        {count(stat.value, progress)}
        {stat.suffix}
      </p>
      <svg viewBox="0 0 260 34" preserveAspectRatio="none" aria-hidden="true">
        <path d={path(dots)} fill="none" stroke="#f47a38" strokeWidth="2.5" strokeLinecap="round" pathLength="1"
          strokeDasharray="1" strokeDashoffset={1 - settle(progress)} vectorEffect="non-scaling-stroke" />
      </svg>
    </section>
  );
}

export function RevenueChart({ progress = 1 }: { progress?: number }) {
  const width = 760,
    height = 300;
  const dots = line(WEEKS, width, height - 10, 24);
  const drawn = settle(progress);
  const reach = drawn * (dots.length - 1);
  const at = Math.min(dots.length - 2, Math.floor(reach));
  const [fromX, fromY] = dots[at]!,
    [toX, toY] = dots[at + 1]!;
  const tipX = fromX + (toX - fromX) * (reach - at),
    tipY = fromY + (toY - fromY) * (reach - at);
  return (
    <section className="dm-card dash-chart">
      <div className="dash-chart__head">
        <h2>Revenue, last 12 weeks</h2>
        <span className="dm-pill dm-pill--plain">Weekly</span>
      </div>
      <p className="dash-chart__big">
        ${count(84210, progress)}
        <span>+12.4% this quarter</span>
      </p>
      <svg viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none" aria-hidden="true">
        <defs>
          <linearGradient id="dm-fill" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#f47a38" stopOpacity="0.32" />
            <stop offset="1" stopColor="#f47a38" stopOpacity="0" />
          </linearGradient>
          <clipPath id="dm-reveal">
            <rect x="0" y="0" width={tipX} height={height} />
          </clipPath>
        </defs>
        {[0.25, 0.5, 0.75].map((row) => (
          <line key={row} x1="0" x2={width} y1={height * row} y2={height * row} stroke="#2b2b2b" strokeWidth="1" />
        ))}
        <g clipPath="url(#dm-reveal)">
          <path d={`${path(dots)} L${width} ${height} L0 ${height} Z`} fill="url(#dm-fill)" />
          <path d={path(dots)} fill="none" stroke="#f47a38" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round" />
        </g>
        {drawn > 0.02 && (
          <>
            <circle cx={tipX} cy={tipY} r="11" fill="#f47a38" opacity="0.2" />
            <circle cx={tipX} cy={tipY} r="5.5" fill="#1c1c1c" stroke="#f47a38" strokeWidth="3" />
          </>
        )}
      </svg>
      <p className="dash-chart__weeks">
        <span>Jul 21</span>
        <span>Aug 11</span>
        <span>Sep 1</span>
        <span>Sep 22</span>
        <span>Oct 6</span>
      </p>
    </section>
  );
}

/** `shown` is how many rows have arrived; the rest keep their place but stay invisible. */
export function Customers({ progress = 1, shown = CUSTOMERS.length }: { progress?: number; shown?: number }) {
  return (
    <section className="dm-card dash-list">
      <div className="dash-list__head">
        <h2>Top customers</h2>
        <span className="dm-pill dm-pill--plain">By revenue</span>
      </div>
      <ul>
        {CUSTOMERS.map((customer, index) => (
          <li key={customer.name} style={index < shown ? undefined : { opacity: 0 }}>
            <span className={`dm-avatar ${index === 0 ? "dm-avatar--munk" : ""}`}>{customer.name[0]}</span>
            <span>
              <b>{customer.name}</b>
              <small>{customer.plan}</small>
              <span className="dash-list__bar">
                <i style={{ width: `${customer.share * settle(progress * 1.4 - index * 0.08) * 100}%` }} />
              </span>
            </span>
            <span className="dash-list__amount">${count(customer.amount, progress * 1.2)}</span>
          </li>
        ))}
      </ul>
    </section>
  );
}
