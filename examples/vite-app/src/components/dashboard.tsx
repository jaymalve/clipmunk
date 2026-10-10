// The example host app. Scenes import these real components; nothing here knows about Flick.
const METRICS = [
  { label: "Revenue", value: "$84,210", change: "+12.4%", up: true },
  { label: "Active customers", value: "3,482", change: "+4.1%", up: true },
  { label: "Churn", value: "1.9%", change: "-0.3%", up: true },
  { label: "Open invoices", value: "127", change: "+18", up: false },
];
const CUSTOMERS = [
  ["Northwind Labs", "Scale", "$12,400", "Paid"],
  ["Helios Freight", "Team", "$4,860", "Paid"],
  ["Juniper & Co", "Scale", "$11,950", "Pending"],
  ["Atlas Robotics", "Enterprise", "$38,000", "Paid"],
  ["Lumen Health", "Team", "$5,120", "Pending"],
  ["Parallel Studio", "Starter", "$890", "Paid"],
];
const SERIES = [32, 41, 38, 52, 49, 63, 58, 71, 69, 84, 80, 96];

export function Sidebar() {
  return (
    <aside className="side">
      <div className="brand"><i /> Orbit</div>
      {["Overview", "Revenue", "Customers", "Invoices", "Reports", "Team", "Settings"].map((item, index) => (
        <div key={item} className={index === 0 ? "nav on" : "nav"}>{item}</div>
      ))}
      <div className="foot">Orbit Analytics · v4.2</div>
    </aside>
  );
}

export function Header() {
  return (
    <div className="head">
      <div>
        <h1>Good morning, Maya</h1>
        <p>Here is how Orbit is doing this week.</p>
      </div>
      <div className="actions">
        <input className="search" type="search" placeholder="Search customers" aria-label="Search customers" />
        <button className="btn" type="button">New report</button>
      </div>
    </div>
  );
}

export function MetricCard({ index }: { index: number }) {
  const metric = METRICS[index]!;
  return (
    <div className="card">
      <small>{metric.label}</small>
      <b>{metric.value}</b>
      <span className={metric.up ? "up" : "down"}>{metric.change} this week</span>
    </div>
  );
}
export const Metrics = () => (
  <div className="cards">{METRICS.map((_, index) => <MetricCard key={index} index={index} />)}</div>
);

/** `progress` (0..1) reveals the line, so a scene can drive it from scene time. */
export function RevenueChart({ progress = 1 }: { progress?: number }) {
  const width = 640, height = 260, max = 100;
  const points = SERIES.map((value, index) => [(index / (SERIES.length - 1)) * width, height - (value / max) * (height - 20) - 10] as const);
  const line = points.map(([x, y], index) => `${index ? "L" : "M"}${x.toFixed(1)} ${y.toFixed(1)}`).join(" ");
  return (
    <div className="panel">
      <h2>Revenue, last 12 weeks</h2>
      <svg className="chart" viewBox={`0 0 ${width} ${height}`} preserveAspectRatio="none">
        <defs>
          <linearGradient id="orbit-fill" x1="0" x2="0" y1="0" y2="1">
            <stop offset="0" stopColor="#6366f1" stopOpacity=".28" /><stop offset="1" stopColor="#6366f1" stopOpacity="0" />
          </linearGradient>
          <clipPath id="orbit-reveal"><rect x="0" y="0" width={width * progress} height={height} /></clipPath>
        </defs>
        {[0.25, 0.5, 0.75].map((y) => <line key={y} x1="0" x2={width} y1={height * y} y2={height * y} stroke="#e2e8f0" />)}
        <g clipPath="url(#orbit-reveal)">
          <path d={`${line} L${width} ${height} L0 ${height} Z`} fill="url(#orbit-fill)" />
          <path d={line} fill="none" stroke="#4f46e5" strokeWidth="3" strokeLinejoin="round" />
        </g>
      </svg>
    </div>
  );
}

export function CustomerTable() {
  return (
    <div className="panel">
      <h2>Top customers</h2>
      <table>
        <thead><tr><th>Customer</th><th>Plan</th><th>MRR</th><th>Status</th></tr></thead>
        <tbody>
          {CUSTOMERS.map(([name, plan, mrr, status]) => (
            <tr key={name}><td>{name}</td><td>{plan}</td><td>{mrr}</td><td><span className={status === "Paid" ? "pill" : "pill wait"}>{status}</span></td></tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Dashboard() {
  return (
    <div className="dash">
      <Sidebar />
      <main className="main">
        <Header />
        <Metrics />
        <div className="row"><RevenueChart /><CustomerTable /></div>
      </main>
    </div>
  );
}
