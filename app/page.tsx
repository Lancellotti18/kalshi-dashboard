"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const REFRESH_SEC = 30;
const HISTORY_KEY = "kalshi_pnl_history";

interface Stats {
  pnlCents: number;
  balanceCents: number;
  portfolioValueCents: number;
  positions: Position[];
  ts: number;
  error?: string;
}

interface Position {
  ticker: string;
  title: string;
  position: number;
  unrealizedPnl: number;
  realizedPnl: number;
  exposure: number;
  cost: number;
}

interface Signal {
  ticker: string;
  title: string;
  side: "yes" | "no";
  entryPriceCents: number;
  conviction: number;
  imbalance: number;
  volumeScore: number;
  volume: number;
  hoursToClose: number;
  allocatedUsd: number;
  contracts: number;
  maxProfit: number;
}

interface HistoryPoint { ts: number; pnl: number; }

function loadHistory(): HistoryPoint[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
}
function saveHistory(h: HistoryPoint[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /**/ }
}
function fmtUsd(cents: number, sign = false): string {
  const v = cents / 100;
  const abs = Math.abs(v).toFixed(2);
  return sign ? (v >= 0 ? "+" : "−") + "$" + abs : "$" + abs;
}
function fmtHours(h: number): string {
  if (h < 24) return h.toFixed(0) + "h";
  return (h / 24).toFixed(1) + "d";
}

export default function Dashboard() {
  const [data, setData]         = useState<Stats | null>(null);
  const [signals, setSignals]   = useState<Signal[]>([]);
  const [signalMeta, setSignalMeta] = useState<{ scanned: number; ts: number } | null>(null);
  const [history, setHistory]   = useState<HistoryPoint[]>([]);
  const [countdown, setCountdown] = useState(REFRESH_SEC);
  const [lastUpdate, setLastUpdate] = useState("");
  const [loading, setLoading]   = useState(true);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [signalsLoading, setSignalsLoading] = useState(false);
  const chartRef = useRef<HTMLCanvasElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartInstance = useRef<any>(null);

  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      const json: Stats = await res.json();
      setData(json);
      setLastUpdate(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      if (!json.error) {
        const h = loadHistory();
        h.push({ ts: json.ts, pnl: json.pnlCents / 100 });
        if (h.length > 300) h.splice(0, h.length - 300);
        saveHistory(h);
        setHistory([...h]);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
    setCountdown(REFRESH_SEC);
  }, []);

  const fetchSignals = useCallback(async () => {
    setSignalsLoading(true);
    try {
      const res = await fetch("/api/signals");
      const json = await res.json();
      setSignals(json.signals ?? []);
      setSignalMeta({ scanned: json.scanned ?? 0, ts: json.ts ?? Date.now() });
    } catch (e) { console.error(e); }
    finally { setSignalsLoading(false); }
  }, []);

  useEffect(() => {
    setHistory(loadHistory());
    fetchStats();
  }, [fetchStats]);

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown((c) => { if (c <= 1) { fetchStats(); return REFRESH_SEC; } return c - 1; });
    }, 1000);
    return () => clearInterval(t);
  }, [fetchStats]);

  // Fetch signals when sidebar opens
  useEffect(() => {
    if (sidebarOpen && signals.length === 0) fetchSignals();
  }, [sidebarOpen, signals.length, fetchSignals]);

  // Chart
  useEffect(() => {
    if (!chartRef.current || history.length < 2) return;
    const values = history.map((p) => p.pnl);
    const labels = history.map((p) => {
      const d = new Date(p.ts);
      return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
             d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    });
    const n = values.length;
    const sumX = (n * (n - 1)) / 2;
    const sumY = values.reduce((a, b) => a + b, 0);
    const sumXY = values.reduce((s, y, i) => s + i * y, 0);
    const sumX2 = (n * (n - 1) * (2 * n - 1)) / 6;
    const denom = n * sumX2 - sumX * sumX;
    const trendData: (number | null)[] = new Array(n).fill(null);
    if (denom !== 0) {
      const slope = (n * sumXY - sumX * sumY) / denom;
      const intercept = (sumY - slope * sumX) / n;
      trendData[0] = parseFloat(intercept.toFixed(4));
      trendData[n - 1] = parseFloat((intercept + slope * (n - 1)).toFixed(4));
    }
    const latestPnl = values[values.length - 1] ?? 0;
    const lineColor = latestPnl >= 0 ? "#22c55e" : "#ef4444";
    const fillColor = latestPnl >= 0 ? "rgba(34,197,94,0.08)" : "rgba(239,68,68,0.08)";

    import("chart.js/auto").then(({ default: Chart }) => {
      if (!chartRef.current) return;
      if (chartInstance.current) chartInstance.current.destroy();
      chartInstance.current = new Chart(chartRef.current, {
        type: "line",
        data: {
          labels,
          datasets: [
            { label: "Profit ($)", data: values, borderColor: lineColor, backgroundColor: fillColor, borderWidth: 2.5, pointRadius: 2, tension: 0.3, fill: true },
            { label: "Trend", data: trendData, borderColor: "#f97316", borderWidth: 1.5, borderDash: [6, 4], pointRadius: 0, spanGaps: true, tension: 0, fill: false },
          ],
        },
        options: {
          responsive: true, maintainAspectRatio: false, animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: { backgroundColor: "#1e293b", borderColor: "#334155", borderWidth: 1, titleColor: "#94a3b8", bodyColor: "#e2e8f0",
              callbacks: { label: (ctx) => { const v = ctx.parsed.y ?? 0; return " " + (v >= 0 ? "+" : "−") + "$" + Math.abs(v).toFixed(2); } } },
          },
          scales: {
            x: { ticks: { color: "#475569", maxTicksLimit: 5, maxRotation: 0, font: { size: 10 } }, grid: { color: "#1e293b" } },
            y: { ticks: { color: "#475569", font: { size: 10 }, callback: (v) => "$" + Number(v).toFixed(2) }, grid: { color: "#1e293b" } },
          },
        },
      });
    });
    return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } };
  }, [history]);

  const pnl = data?.pnlCents ?? 0;
  const pnlUsd = pnl / 100;
  const bannerClass = pnlUsd > 0 ? "positive" : pnlUsd < 0 ? "negative" : "neutral";
  const pnlColor = pnlUsd > 0 ? "var(--green)" : pnlUsd < 0 ? "var(--red)" : "var(--muted)";

  return (
    <>
      {/* Sidebar overlay */}
      {sidebarOpen && (
        <div className="sidebar-overlay" onClick={() => setSidebarOpen(false)} />
      )}

      {/* Sidebar */}
      <div className={`sidebar ${sidebarOpen ? "sidebar-open" : ""}`}>
        <div className="sidebar-header">
          <div>
            <div className="sidebar-title">Practice Trades</div>
            <div className="sidebar-sub">What the bot would do right now — no real money</div>
          </div>
          <button className="sidebar-close" onClick={() => setSidebarOpen(false)}>✕</button>
        </div>

        {signalMeta && (
          <div className="sidebar-meta">
            Scanned {signalMeta.scanned} markets · {new Date(signalMeta.ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
            <button className="refresh-btn" onClick={fetchSignals} disabled={signalsLoading}>
              {signalsLoading ? "..." : "↺ Refresh"}
            </button>
          </div>
        )}

        <div className="sidebar-body">
          {signalsLoading && signals.length === 0 ? (
            <div className="empty" style={{ padding: "40px 0" }}>
              <div className="empty-icon">⏳</div>
              <div className="empty-sub">Scanning markets...</div>
            </div>
          ) : signals.length === 0 ? (
            <div className="empty" style={{ padding: "40px 0" }}>
              <div className="empty-icon">🔍</div>
              <div className="empty-title">No signals right now</div>
              <div className="empty-sub">No markets currently meet the conviction threshold. Try refreshing.</div>
            </div>
          ) : (
            signals.map((s, i) => {
              const convPct = Math.round(s.conviction * 100);
              const convColor = convPct >= 75 ? "var(--green)" : convPct >= 65 ? "var(--orange)" : "var(--muted)";
              return (
                <div key={s.ticker} className="signal-card">
                  <div className="signal-rank">#{i + 1}</div>
                  <div className="signal-body">
                    <div className="signal-title">{s.title.slice(0, 65)}</div>
                    <div className="signal-ticker">{s.ticker}</div>
                    <div className="signal-tags">
                      <span className={`side-badge side-${s.side}`}>{s.side.toUpperCase()}</span>
                      <span className="tag-price">{s.entryPriceCents}¢</span>
                      <span className="tag-time">{fmtHours(s.hoursToClose)}</span>
                    </div>
                    <div className="conviction-row">
                      <div className="conviction-bar-wrap">
                        <div className="conviction-bar-fill" style={{ width: convPct + "%", background: convColor }} />
                      </div>
                      <span style={{ color: convColor, fontWeight: 700 }}>{convPct}%</span>
                    </div>
                    <div className="signal-trade">
                      <span className="signal-trade-label">Would buy</span>
                      <span className="signal-trade-val">{s.contracts} contracts · ${s.allocatedUsd.toFixed(2)}</span>
                      <span className="signal-profit green">max profit +${s.maxProfit.toFixed(2)}</span>
                    </div>
                  </div>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Header */}
      <div className="header">
        <div className="header-left">
          <span className="dot" />
          <h1>Kalshi Bot</h1>
          <span className="badge">LIVE</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <button className="practice-btn" onClick={() => setSidebarOpen(true)}>
            🧪 Practice Trades
          </button>
          <div className="refresh-info">
            {countdown}s<br />
            <span style={{ color: "var(--muted)" }}>{lastUpdate}</span>
          </div>
        </div>
      </div>

      <div className="page">
        {data?.error && <div className="error-box">⚠️ {data.error}</div>}

        {/* Profit Made Banner */}
        <div className={`profit-banner ${bannerClass}`}>
          <div className="profit-banner-label">Profit Made</div>
          <div className="profit-banner-value" style={{ color: pnlColor }}>
            {loading ? "—" : fmtUsd(pnl, true)}
          </div>
          <div className="profit-banner-sub">
            {data
              ? `Realized P&L · Balance: ${fmtUsd(data.balanceCents)} · Portfolio: ${fmtUsd(data.portfolioValueCents)}`
              : "Loading Kalshi account data..."}
          </div>
        </div>

        {/* Stats Cards */}
        <div className="cards">
          <div className="card">
            <div className="card-label">Balance</div>
            <div className={`card-value ${data && data.balanceCents > 0 ? "green" : ""}`}>
              {data ? fmtUsd(data.balanceCents) : "—"}
            </div>
            <div className="card-sub">available cash</div>
          </div>
          <div className="card">
            <div className="card-label">Portfolio Value</div>
            <div className="card-value blue">{data ? fmtUsd(data.portfolioValueCents) : "—"}</div>
            <div className="card-sub">cash + positions</div>
          </div>
          <div className="card">
            <div className="card-label">Open Positions</div>
            <div className="card-value orange">{data ? data.positions.length : "—"}</div>
            <div className="card-sub">{data?.positions.length === 1 ? "1 market" : `${data?.positions.length ?? 0} markets`}</div>
          </div>
          <div className="card">
            <div className="card-label">Unrealized P&L</div>
            <div className="card-value" style={{ color: data ? (data.positions.reduce((s, p) => s + p.unrealizedPnl, 0) >= 0 ? "var(--green)" : "var(--red)") : "var(--muted)" }}>
              {data ? fmtUsd(data.positions.reduce((s, p) => s + p.unrealizedPnl, 0), true) : "—"}
            </div>
            <div className="card-sub">open positions</div>
          </div>
        </div>

        {/* P&L Section */}
        <div className="section">
          <div className="section-header">
            <span>Profit / Loss</span>
            <span style={{ fontSize: 10, color: "var(--muted)" }}>from Kalshi account</span>
          </div>
          <div className="section-body">
            {data && !data.error ? (
              <>
                <div className="pnl-row"><span className="pnl-label">Realized P&L</span><span className="pnl-value" style={{ color: pnlColor }}>{fmtUsd(pnl, true)}</span></div>
                <div className="pnl-row"><span className="pnl-label">Unrealized P&L</span>
                  <span className="pnl-value" style={{ color: data.positions.reduce((s, p) => s + p.unrealizedPnl, 0) >= 0 ? "var(--green)" : "var(--red)" }}>
                    {fmtUsd(data.positions.reduce((s, p) => s + p.unrealizedPnl, 0), true)}
                  </span>
                </div>
                <div className="pnl-row"><span className="pnl-label">Available Balance</span><span className="pnl-value green">{fmtUsd(data.balanceCents)}</span></div>
                <div className="pnl-row"><span className="pnl-label">Portfolio Value</span><span className="pnl-value blue">{fmtUsd(data.portfolioValueCents)}</span></div>
              </>
            ) : (
              <div className="empty">
                <div className="empty-icon">📊</div>
                <div className="empty-title">{loading ? "Loading..." : "No data"}</div>
                <div className="empty-sub">{data?.error ?? "Connecting to Kalshi..."}</div>
              </div>
            )}
          </div>
        </div>

        {/* Chart */}
        <div className="section">
          <div className="section-header">
            <span>Profit Over Time</span>
            <span style={{ fontSize: 10, color: "var(--muted)" }}>
              <span style={{ color: "var(--blue)" }}>━</span> actual &nbsp;
              <span style={{ color: "var(--orange)" }}>╌</span> trend
            </span>
          </div>
          <div className="section-body">
            {history.length >= 2 ? (
              <div className="chart-wrap"><canvas ref={chartRef} /></div>
            ) : (
              <div className="empty" style={{ padding: "24px 0" }}>
                <div className="empty-icon">📈</div>
                <div className="empty-sub">Chart builds as you open this page — each visit logs a data point.</div>
              </div>
            )}
          </div>
        </div>

        {/* Open Positions */}
        <div className="section">
          <div className="section-header">
            <span>Open Positions</span>
            <span style={{ color: "var(--orange)" }}>{data?.positions.length ?? 0}</span>
          </div>
          <div className="section-body">
            {data?.positions.length ? data.positions.map((p) => {
              const side = p.position > 0 ? "yes" : "no";
              const unPnl = p.unrealizedPnl / 100;
              return (
                <div key={p.ticker} className="position-item">
                  <div style={{ minWidth: 0 }}>
                    <div className="position-ticker">{p.ticker}</div>
                    <div className="position-market">{String(p.title).slice(0, 55)}</div>
                    <div className="position-pnl" style={{ color: unPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                      {unPnl >= 0 ? "+" : "−"}${Math.abs(unPnl).toFixed(2)} unrealized
                    </div>
                  </div>
                  <div className="position-right">
                    <span className={`side-badge side-${side}`}>{side.toUpperCase()}</span><br />
                    <span style={{ fontSize: 12, color: "var(--muted)" }}>Cost: ${(p.cost / 100).toFixed(2)}</span>
                  </div>
                </div>
              );
            }) : (
              <div className="empty">
                <div className="empty-icon">🎯</div>
                <div className="empty-title">No open positions</div>
                <div className="empty-sub">Active trades will appear here.</div>
              </div>
            )}
          </div>
        </div>
      </div>
    </>
  );
}
