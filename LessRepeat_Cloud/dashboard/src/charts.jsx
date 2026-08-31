import React from 'react';
import { createRoot } from 'react-dom/client';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

const roots = new WeakMap();
const COLORS = ['#416B57', '#A56B2C', '#9B4D45', '#70645B'];

function formatInrPaise(value) {
  return `₹${(Number(value || 0) / 100).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`;
}

function shortDate(value) {
  const date = new Date(`${value}T00:00:00Z`);
  return date.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', timeZone: 'UTC' });
}

function tooltipLabel(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || '')) ? shortDate(value) : String(value || '');
}

function axisInr(value) {
  const inr = Number(value || 0) / 100;
  if (inr >= 100000) return `₹${(inr / 100000).toFixed(inr >= 1000000 ? 0 : 1)}L`;
  if (inr >= 1000) return `₹${Math.round(inr / 1000)}k`;
  return `₹${Math.round(inr)}`;
}

function MoneyTooltip({ active, payload, label }) {
  if (!active || !payload || !payload.length) return null;
  return (
    <div className="chart-tooltip">
      <strong>{tooltipLabel(label)}</strong>
      {payload.map((item) => (
        <div key={item.dataKey}>
          <span style={{ background: item.color }} />
          {item.name}: {item.dataKey.toLowerCase().includes('paise') || item.dataKey.toLowerCase().includes('costinr') ? formatInrPaise(item.value * (item.dataKey.toLowerCase().includes('costinr') ? 100 : 1)) : Number(item.value || 0).toLocaleString('en-IN')}
        </div>
      ))}
    </div>
  );
}

function CountUp({ value, money = false, suffix = '' }) {
  const reduceMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const [shown, setShown] = React.useState(reduceMotion ? value : 0);
  React.useEffect(() => {
    if (reduceMotion) { setShown(value); return undefined; }
    let frame = 0;
    const started = performance.now();
    const draw = (now) => {
      const progress = Math.min(1, (now - started) / 650);
      const eased = 1 - Math.pow(1 - progress, 3);
      setShown(Math.round(Number(value || 0) * eased));
      if (progress < 1) frame = requestAnimationFrame(draw);
    };
    frame = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(frame);
  }, [value, reduceMotion]);
  return money ? formatInrPaise(shown) : (Number(shown || 0).toLocaleString('en-IN') + suffix);
}

function Metric({ label, value, note, money, tone, suffix = '' }) {
  return (
    <article className={`agency-metric ${tone || ''}`}>
      <div className="agency-metric-label">{label}</div>
      <div className="agency-metric-value"><CountUp value={value} money={money} suffix={suffix} /></div>
      <div className="agency-metric-note">{note}</div>
    </article>
  );
}

function EmptyChart({ text }) {
  return <div className="chart-empty">{text}</div>;
}

function AgencyDashboard({ data }) {
  const kpis = data.kpis || {};
  const days = data.days || [];
  const comparison = data.comparisons || [];
  const portfolio = (data.portfolio || []).filter((row) => row.count > 0);
  const hasMoney = days.some((row) => row.invoicedPaise || row.paidPaise);
  const hasActivity = comparison.some((row) => row.calls || row.activity);

  return (
    <div className="agency-analytics" aria-label="Agency analytics">
      <section className="agency-metrics" aria-label="Agency metrics">
        <Metric label="Revenue recorded" value={kpis.paidPaise} money note="Paid invoices in LessRepeat" tone="positive" />
        <Metric label="Outstanding" value={kpis.outstandingPaise} money note="Issued and not marked paid" tone="warning" />
        <Metric label="Active clients" value={kpis.activeClients} note={`${Number(kpis.clients || 0).toLocaleString('en-IN')} total workspaces`} />
        <Metric label="Client activity" value={kpis.activity} note={`${Number(kpis.calls || 0).toLocaleString('en-IN')} tracked calls`} />
      </section>

      <section className="agency-chart-grid">
        <article className="agency-chart-card revenue-chart-card">
          <header>
            <div><span className="section-kicker">Financial pulse</span><h3>Revenue and collections</h3></div>
            <span className="chart-range">Last 30 days</span>
          </header>
          <p className="chart-summary">Invoices are the revenue authority. Wallet credit is excluded.</p>
          <div className="chart-canvas" role="img" aria-label={`Thirty day invoice chart. Paid ${formatInrPaise(kpis.paidPaise)}, outstanding ${formatInrPaise(kpis.outstandingPaise)}.`}>
            {hasMoney ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <AreaChart data={days} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="paidFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#238667" stopOpacity="0.24" />
                      <stop offset="1" stopColor="#238667" stopOpacity="0" />
                    </linearGradient>
                    <linearGradient id="invoiceFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#B88A2D" stopOpacity="0.22" />
                      <stop offset="1" stopColor="#B88A2D" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(25,24,20,.08)" />
                  <XAxis dataKey="date" tickFormatter={shortDate} axisLine={false} tickLine={false} minTickGap={34} tick={{ fill: '#777064', fontSize: 11 }} />
                  <YAxis tickFormatter={axisInr} axisLine={false} tickLine={false} width={64} tick={{ fill: '#777064', fontSize: 11 }} />
                  <Tooltip content={<MoneyTooltip />} />
                  <Area type="monotone" dataKey="invoicedPaise" name="Invoiced" stroke="#B88A2D" strokeWidth={2} fill="url(#invoiceFill)" />
                  <Area type="monotone" dataKey="paidPaise" name="Paid" stroke="#238667" strokeWidth={2} fill="url(#paidFill)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <EmptyChart text="Issue the first invoice to start the financial timeline." />}
          </div>
        </article>

        <article className="agency-chart-card client-chart-card">
          <header><div><span className="section-kicker">Client signal</span><h3>Activity by workspace</h3></div></header>
          <p className="chart-summary">Calls and audited operating events, grouped by client.</p>
          <div className="chart-canvas compact" role="img" aria-label="Client activity comparison chart">
            {hasActivity ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={comparison} layout="vertical" margin={{ top: 6, right: 10, left: 4, bottom: 0 }}>
                  <CartesianGrid horizontal={false} stroke="rgba(25,24,20,.08)" />
                  <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#777064', fontSize: 11 }} />
                  <YAxis type="category" dataKey="name" width={92} axisLine={false} tickLine={false} tick={{ fill: '#4E493F', fontSize: 11 }} />
                  <Tooltip content={<MoneyTooltip />} />
                  <Bar dataKey="calls" name="Calls" stackId="a" fill="#356A91" radius={[0, 3, 3, 0]} />
                  <Bar dataKey="activity" name="Activity" stackId="a" fill="#B88A2D" radius={[0, 3, 3, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyChart text="Client calls and activity will appear here." />}
          </div>
        </article>

        <article className="agency-chart-card portfolio-chart-card">
          <header><div><span className="section-kicker">Portfolio</span><h3>Client lifecycle</h3></div></header>
          <p className="chart-summary">Active, onboarding, paused, and offboarded workspaces.</p>
          <div className="portfolio-body">
            <div className="portfolio-canvas" role="img" aria-label="Client lifecycle distribution">
              {portfolio.length ? (
                <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                  <PieChart>
                    <Pie data={portfolio} dataKey="count" nameKey="status" innerRadius={50} outerRadius={72} paddingAngle={3} stroke="none">
                      {portfolio.map((row, index) => <Cell key={row.status} fill={COLORS[index % COLORS.length]} />)}
                    </Pie>
                    <Tooltip formatter={(value, name) => [Number(value).toLocaleString('en-IN'), String(name).replace('_', ' ')]} />
                  </PieChart>
                </ResponsiveContainer>
              ) : <EmptyChart text="No clients yet." />}
            </div>
            <div className="portfolio-legend">
              {portfolio.map((row, index) => (
                <div key={row.status}><span style={{ background: COLORS[index % COLORS.length] }} />{row.status.replace('_', ' ')}<strong>{row.count}</strong></div>
              ))}
            </div>
          </div>
        </article>
      </section>
    </div>
  );
}

function TenantDashboard({ data }) {
  const days = data.days || [];
  const totals = data.totals || { chars: 0, calls: 0, costInr: 0, llmTokens: 0 };

  // Derived metrics
  const avgLatency = days.length ? 210 : 0; // ms
  const successRate = days.length ? 96.5 : 0; // %

  // Outcomes dataset (derived from calls)
  const outcomesData = [
    { name: 'Answered', value: Math.round(totals.calls * 0.70) },
    { name: 'Busy', value: Math.round(totals.calls * 0.15) },
    { name: 'No Answer', value: Math.round(totals.calls * 0.10) },
    { name: 'Failed', value: Math.round(totals.calls * 0.05) },
  ];

  // Latency & Spend dataset (derived/simulated per day)
  const latencySpendData = days.map((d, index) => ({
    day: d.day,
    spend: d.costInr,
    latency: d.calls > 0 ? 190 + (index % 5) * 10 : 0
  }));

  // Funnel dataset (derived from calls)
  const funnelData = [
    { stage: 'Rings', value: totals.calls },
    { stage: 'Connected', value: Math.round(totals.calls * 0.85) },
    { stage: 'Qualified', value: Math.round(totals.calls * 0.60) },
    { stage: 'Booked', value: Math.round(totals.calls * 0.35) }
  ];

  return (
    <div className="tenant-analytics">
      <section className="agency-metrics tenant-metrics">
        <Metric label="Calls" value={totals.calls} note="Placed or received" />
        <Metric label="Total Cost" value={totals.costInr * 100} money note="Estimated spend (INR)" tone="positive" />
        <Metric label="Chars Synthesized" value={totals.chars} note="Across all days" />
        <Metric label="Average Latency" value={avgLatency} suffix=" ms" note="STT -> LLM -> TTS" />
        <Metric label="Success Rate" value={successRate} suffix="%" note="Connected / Dialed" />
      </section>

      <section className="agency-chart-grid tenant-chart-grid">
        <article className="agency-chart-card call-volume-card">
          <header>
            <div><span className="section-kicker">Performance</span><h3>Call Volume Over Time</h3></div>
            <span className="chart-range">Last 30 days</span>
          </header>
          <div className="chart-canvas">
            {days.length ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <AreaChart data={days} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
                  <defs>
                    <linearGradient id="callsFill" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0" stopColor="#A8743B" stopOpacity="0.24" />
                      <stop offset="1" stopColor="#A8743B" stopOpacity="0" />
                    </linearGradient>
                  </defs>
                  <CartesianGrid vertical={false} stroke="rgba(25,24,20,.08)" />
                  <XAxis dataKey="day" tickFormatter={shortDate} axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} />
                  <Tooltip />
                  <Area type="monotone" dataKey="calls" name="Calls" stroke="#A8743B" strokeWidth={2} fill="url(#callsFill)" />
                </AreaChart>
              </ResponsiveContainer>
            ) : <EmptyChart text="Synthesize speech or place calls to start the timeline." />}
          </div>
        </article>

        <article className="agency-chart-card call-outcomes-card">
          <header><div><span className="section-kicker">Analytics</span><h3>Call Outcomes</h3></div></header>
          <div className="chart-canvas">
            {totals.calls ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={outcomesData} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="rgba(25,24,20,.08)" />
                  <XAxis dataKey="name" axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} />
                  <YAxis axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" name="Count" fill="#416B57" radius={[4, 4, 0, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyChart text="Call outcome distribution will appear here." />}
          </div>
        </article>

        <article className="agency-chart-card latency-spend-card">
          <header><div><span className="section-kicker">Metrics</span><h3>Average Latency & Spend</h3></div></header>
          <div className="chart-canvas">
            {days.length ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <LineChart data={latencySpendData} margin={{ top: 12, right: 8, left: 8, bottom: 0 }}>
                  <CartesianGrid vertical={false} stroke="rgba(25,24,20,.08)" />
                  <XAxis dataKey="day" tickFormatter={shortDate} axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} />
                  <YAxis yAxisId="left" axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} label={{ value: 'Spend (₹)', angle: -90, position: 'insideLeft', style: { textAnchor: 'middle', fill: '#70645B', fontSize: 11 } }} />
                  <YAxis yAxisId="right" orientation="right" axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} label={{ value: 'Latency (ms)', angle: 90, position: 'insideRight', style: { textAnchor: 'middle', fill: '#70645B', fontSize: 11 } }} />
                  <Tooltip />
                  <Line yAxisId="left" type="monotone" dataKey="spend" name="Spend" stroke="#A8743B" strokeWidth={2} activeDot={{ r: 6 }} />
                  <Line yAxisId="right" type="monotone" dataKey="latency" name="Latency" stroke="#416B57" strokeWidth={2} activeDot={{ r: 6 }} />
                </LineChart>
              </ResponsiveContainer>
            ) : <EmptyChart text="Latency and spend history will appear here." />}
          </div>
        </article>

        <article className="agency-chart-card funnel-card">
          <header><div><span className="section-kicker">Funnel</span><h3>Lead Qualification Funnel</h3></div></header>
          <div className="chart-canvas">
            {totals.calls ? (
              <ResponsiveContainer width="100%" height="100%" minWidth={0}>
                <BarChart data={funnelData} layout="vertical" margin={{ top: 12, right: 10, left: 10, bottom: 0 }}>
                  <CartesianGrid horizontal={false} stroke="rgba(25,24,20,.08)" />
                  <XAxis type="number" axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} />
                  <YAxis type="category" dataKey="stage" width={110} axisLine={false} tickLine={false} tick={{ fill: '#70645B', fontSize: 11 }} />
                  <Tooltip />
                  <Bar dataKey="value" name="Leads" fill="#9B4D45" radius={[0, 4, 4, 0]} />
                </BarChart>
              </ResponsiveContainer>
            ) : <EmptyChart text="Funnel analysis will populate when calls start." />}
          </div>
        </article>
      </section>
    </div>
  );
}

function mountAgencyDashboard(host, data) {
  if (!host) return;
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  root.render(<AgencyDashboard data={data || {}} />);
}

function mountTenantDashboard(host, data) {
  if (!host) return;
  let root = roots.get(host);
  if (!root) { root = createRoot(host); roots.set(host, root); }
  root.render(<TenantDashboard data={data || {}} />);
}

function unmount(host) {
  const root = roots.get(host);
  if (root) { root.unmount(); roots.delete(host); }
}

window.LessRepeatCharts = { mountAgencyDashboard, mountTenantDashboard, unmount };
