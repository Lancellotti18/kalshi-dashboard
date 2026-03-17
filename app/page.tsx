"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// ── Constants ──────────────────────────────────────────────────────────────
const REFRESH_SEC  = 30;
const HISTORY_KEY  = "kalshi_pnl_history";
const BET_HIST_KEY = "kalshi_bet_history";

// ── Types ──────────────────────────────────────────────────────────────────
interface Stats {
  pnlCents: number;
  startingCapitalCents: number;
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
interface LiveBet {
  ticker: string;
  title: string;
  position: number;
  side: "yes" | "no";
  costCents: number;
  unrealizedPnlCents: number;
  realizedPnlCents: number;
  status: string;
  result: string | null;
  yesBid: number;
  yesAsk: number;
  lastPrice: number;
  closeTime: string;
  expectedExpiration: string;
}
interface SettledBet {
  ticker: string;
  title: string;
  side: "yes" | "no";
  costCents: number;
  realizedPnlCents: number;
  result: string | null;
  settledAt: number;
}
interface HistoryPoint { ts: number; pnl: number; }
interface Toast { id: number; type: "win" | "loss" | "info"; title: string; sub: string; }

type Period = "1D" | "7D" | "30D" | "ALL";
type HistFilter = "all" | "win" | "loss";
type HistSort = "newest" | "oldest" | "biggest_win" | "biggest_loss";

// ── localStorage helpers ───────────────────────────────────────────────────
function loadHistory(): HistoryPoint[] {
  try { return JSON.parse(localStorage.getItem(HISTORY_KEY) ?? "[]"); } catch { return []; }
}
function saveHistory(h: HistoryPoint[]) {
  try { localStorage.setItem(HISTORY_KEY, JSON.stringify(h)); } catch { /**/ }
}
function loadBetHistory(): SettledBet[] {
  try { return JSON.parse(localStorage.getItem(BET_HIST_KEY) ?? "[]"); } catch { return []; }
}
function saveBetHistory(h: SettledBet[]) {
  try { localStorage.setItem(BET_HIST_KEY, JSON.stringify(h)); } catch { /**/ }
}

// ── Formatters ────────────────────────────────────────────────────────────
function fmtUsd(cents: number, sign = false): string {
  const v = cents / 100;
  const abs = Math.abs(v).toFixed(2);
  return sign ? (v >= 0 ? "+" : "−") + "$" + abs : "$" + abs;
}
function fmtHours(h: number): string {
  if (h < 1) return `${Math.round(h * 60)}m`;
  if (h < 24) return `${Math.floor(h)}h ${Math.round((h % 1) * 60)}m`;
  return `${(h / 24).toFixed(1)}d`;
}
function fmtDate(ts: number): string {
  return new Date(ts).toLocaleDateString([], { month: "short", day: "numeric", year: "numeric" });
}
function fmtDateTime(ts: number): string {
  return new Date(ts).toLocaleString([], { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" });
}

// ── CSV export ────────────────────────────────────────────────────────────
function exportCsv(bets: SettledBet[]) {
  const rows = [
    ["Date", "Market", "Ticker", "Side", "Cost ($)", "Result", "P&L ($)"],
    ...bets.map(b => [
      fmtDate(b.settledAt),
      `"${b.title.replace(/"/g, '""')}"`,
      b.ticker,
      b.side.toUpperCase(),
      (b.costCents / 100).toFixed(2),
      b.result ?? "unknown",
      (b.result === b.side ? b.realizedPnlCents / 100 : -(b.costCents / 100)).toFixed(2),
    ]),
  ];
  const csv = rows.map(r => r.join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `kalshi-history-${new Date().toISOString().slice(0, 10)}.csv`;
  a.click();
  URL.revokeObjectURL(url);
}

// ── Filter history by period ───────────────────────────────────────────────
function filterByPeriod(pts: HistoryPoint[], period: Period): HistoryPoint[] {
  if (period === "ALL") return pts;
  const cutoff = {
    "1D": Date.now() - 86_400_000,
    "7D": Date.now() - 7 * 86_400_000,
    "30D": Date.now() - 30 * 86_400_000,
  }[period];
  return pts.filter(p => p.ts >= cutoff);
}

// ═══════════════════════════════════════════════════════════════════════════
export default function Dashboard() {
  const [data, setData]               = useState<Stats | null>(null);
  const [history, setHistory]         = useState<HistoryPoint[]>([]);
  const [liveBets, setLiveBets]       = useState<LiveBet[]>([]);
  const [settledBets, setSettledBets] = useState<SettledBet[]>([]);
  const [liveBetsLoading, setLiveBetsLoading] = useState(false);
  const [loading, setLoading]         = useState(true);
  const [countdown, setCountdown]     = useState(REFRESH_SEC);
  const [lastUpdate, setLastUpdate]   = useState("");
  const [period, setPeriod]           = useState<Period>("ALL");
  const [histFilter, setHistFilter]   = useState<HistFilter>("all");
  const [histSort, setHistSort]       = useState<HistSort>("newest");
  const [histSearch, setHistSearch]   = useState("");
  const [toasts, setToasts]           = useState<Toast[]>([]);
  const [notifyEnabled, setNotifyEnabled] = useState(false);
  const prevSettledRef = useRef<Set<string>>(new Set());
  const chartRef       = useRef<HTMLCanvasElement>(null);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const chartInstance  = useRef<any>(null);
  let toastId = useRef(0);

  // ── Push a toast ──────────────────────────────────────────────────────
  const pushToast = useCallback((t: Omit<Toast, "id">) => {
    const id = ++toastId.current;
    setToasts(prev => [...prev, { ...t, id }]);
    setTimeout(() => setToasts(prev => prev.filter(x => x.id !== id)), 5000);
  }, []);

  // ── Notifications ─────────────────────────────────────────────────────
  const requestNotify = useCallback(async () => {
    if (!("Notification" in window)) return;
    if (Notification.permission === "granted") { setNotifyEnabled(true); return; }
    const p = await Notification.requestPermission();
    setNotifyEnabled(p === "granted");
  }, []);

  const sendNotification = useCallback((title: string, body: string) => {
    if (notifyEnabled && Notification.permission === "granted") {
      new Notification(title, { body, icon: "/favicon.ico" });
    }
  }, [notifyEnabled]);

  // ── Fetch stats ───────────────────────────────────────────────────────
  const fetchStats = useCallback(async () => {
    try {
      const res = await fetch("/api/stats");
      const json: Stats = await res.json();
      setData(json);
      setLastUpdate(new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
      if (!json.error) {
        const h = loadHistory();
        h.push({ ts: json.ts, pnl: json.pnlCents / 100 });
        if (h.length > 500) h.splice(0, h.length - 500);
        saveHistory(h);
        setHistory([...h]);
      }
    } catch (e) { console.error(e); }
    finally { setLoading(false); }
    setCountdown(REFRESH_SEC);
  }, []);

  // ── Fetch live bets ───────────────────────────────────────────────────
  const fetchLiveBets = useCallback(async () => {
    setLiveBetsLoading(true);
    try {
      const res = await fetch("/api/live-bets");
      const json = await res.json();
      const incoming: LiveBet[] = json.bets ?? [];
      setLiveBets(incoming);

      const hist = loadBetHistory();
      const prevSettled = prevSettledRef.current;

      incoming.forEach(b => {
        if ((b.status === "finalized" || b.status === "settled" || b.result) && b.result) {
          if (!hist.some(h => h.ticker === b.ticker)) {
            const won = b.result === b.side;
            hist.push({
              ticker: b.ticker,
              title: b.title,
              side: b.side,
              costCents: b.costCents,
              realizedPnlCents: b.realizedPnlCents,
              result: b.result,
              settledAt: Date.now(),
            });
            // Notify on new settlement
            if (!prevSettled.has(b.ticker)) {
              prevSettled.add(b.ticker);
              const pnlStr = won
                ? `+${fmtUsd(b.realizedPnlCents)}`
                : `-${fmtUsd(b.costCents)}`;
              pushToast({
                type: won ? "win" : "loss",
                title: won ? `Win! ${pnlStr}` : `Loss ${pnlStr}`,
                sub: b.title.slice(0, 60),
              });
              sendNotification(
                won ? `✅ Win — ${pnlStr}` : `❌ Loss — ${pnlStr}`,
                b.title
              );
            }
          }
        }
      });

      if (hist.length > 500) hist.splice(0, hist.length - 500);
      saveBetHistory(hist);
      setSettledBets([...hist]);
    } catch (e) { console.error(e); }
    finally { setLiveBetsLoading(false); }
  }, [pushToast, sendNotification]);

  // ── Init ──────────────────────────────────────────────────────────────
  useEffect(() => {
    setHistory(loadHistory());
    const hist = loadBetHistory();
    setSettledBets([...hist]);
    hist.forEach(b => prevSettledRef.current.add(b.ticker));
    fetchStats();
    fetchLiveBets();
    // Check if notifications were previously granted
    if ("Notification" in window && Notification.permission === "granted") {
      setNotifyEnabled(true);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ── Countdown timer ───────────────────────────────────────────────────
  useEffect(() => {
    const t = setInterval(() => {
      setCountdown(c => {
        if (c <= 1) { fetchStats(); fetchLiveBets(); return REFRESH_SEC; }
        return c - 1;
      });
    }, 1000);
    return () => clearInterval(t);
  }, [fetchStats, fetchLiveBets]);

  // ── Chart ──────────────────────────────────────────────────────────────
  const chartData = useMemo(() => filterByPeriod(history, period), [history, period]);

  useEffect(() => {
    if (!chartRef.current || chartData.length < 2) return;
    const values = chartData.map(p => p.pnl);
    const labels = chartData.map(p => {
      const d = new Date(p.ts);
      if (period === "1D") return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
      return d.toLocaleDateString([], { month: "short", day: "numeric" }) + " " +
             d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
    });

    // Trend line (linear regression)
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
    const lineColor  = latestPnl >= 0 ? "#22c55e" : "#ef4444";
    const fillColor  = latestPnl >= 0 ? "rgba(34,197,94,0.07)" : "rgba(239,68,68,0.07)";

    import("chart.js/auto").then(({ default: Chart }) => {
      if (!chartRef.current) return;
      if (chartInstance.current) chartInstance.current.destroy();
      chartInstance.current = new Chart(chartRef.current, {
        type: "line",
        data: {
          labels,
          datasets: [
            {
              label: "Profit ($)",
              data: values,
              borderColor: lineColor,
              backgroundColor: fillColor,
              borderWidth: 2,
              pointRadius: values.length > 50 ? 0 : 2.5,
              pointHoverRadius: 4,
              tension: 0.3,
              fill: true,
            },
            {
              label: "Trend",
              data: trendData,
              borderColor: "#f97316",
              borderWidth: 1.5,
              borderDash: [6, 4],
              pointRadius: 0,
              spanGaps: true,
              tension: 0,
              fill: false,
            },
          ],
        },
        options: {
          responsive: true,
          maintainAspectRatio: false,
          animation: false,
          interaction: { mode: "index", intersect: false },
          plugins: {
            legend: { display: false },
            tooltip: {
              backgroundColor: "#0f1520",
              borderColor: "#1e2d45",
              borderWidth: 1,
              titleColor: "#64748b",
              bodyColor: "#e2e8f0",
              padding: 10,
              callbacks: {
                label: (ctx) => {
                  const v = ctx.parsed.y ?? 0;
                  return " " + (v >= 0 ? "+" : "−") + "$" + Math.abs(v).toFixed(2);
                },
              },
            },
          },
          scales: {
            x: {
              ticks: { color: "#4e6280", maxTicksLimit: 6, maxRotation: 0, font: { size: 10 } },
              grid: { color: "rgba(30,45,69,0.6)" },
              border: { color: "#1e2d45" },
            },
            y: {
              ticks: {
                color: "#4e6280",
                font: { size: 10 },
                callback: (v) => "$" + Number(v).toFixed(2),
              },
              grid: { color: "rgba(30,45,69,0.6)" },
              border: { color: "#1e2d45" },
            },
          },
        },
      });
    });
    return () => { if (chartInstance.current) { chartInstance.current.destroy(); chartInstance.current = null; } };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [chartData]);

  // ── Derived values ────────────────────────────────────────────────────
  const pnl      = data?.pnlCents ?? 0;
  const pnlUsd   = pnl / 100;
  const heroClass = pnlUsd > 0 ? "positive" : pnlUsd < 0 ? "negative" : "neutral";
  const pnlColor  = pnlUsd > 0 ? "var(--green)" : pnlUsd < 0 ? "var(--red)" : "var(--muted2)";

  const openBets = liveBets.filter(b => !b.result);

  // Profit tracker bar
  const netGain  = Math.max(0, pnl);
  const netLoss  = Math.max(0, -pnl);
  const projTotalPlacedCents = openBets.reduce((s, b) => s + b.costCents, 0);
  const projTotalPayoutCents = openBets.reduce((s, b) => s + Math.abs(b.position) * 100, 0);
  const projTotalProfitCents = projTotalPayoutCents - projTotalPlacedCents;
  const barScale = Math.max(1, netGain + projTotalProfitCents + netLoss + Math.abs(pnl) * 0.1 + 100);
  const gainPct  = (netGain / barScale) * 100;
  const projPct  = (projTotalProfitCents / barScale) * 100;
  const lossPct  = (netLoss / barScale) * 100;

  // Win rate
  const wins   = settledBets.filter(b => b.result === b.side).length;
  const losses = settledBets.filter(b => b.result && b.result !== b.side).length;
  const total  = wins + losses;
  const winRate = total > 0 ? ((wins / total) * 100).toFixed(0) : "—";
  const totalWonCents  = settledBets.filter(b => b.result === b.side).reduce((s, b) => s + b.realizedPnlCents, 0);
  const totalLostCents = settledBets.filter(b => b.result && b.result !== b.side).reduce((s, b) => s + b.costCents, 0);

  // ── History filtering + sorting ───────────────────────────────────────
  const filteredHistory = useMemo(() => {
    let h = [...settledBets];
    if (histFilter === "win")  h = h.filter(b => b.result === b.side);
    if (histFilter === "loss") h = h.filter(b => b.result && b.result !== b.side);
    if (histSearch.trim()) {
      const q = histSearch.toLowerCase();
      h = h.filter(b => b.title.toLowerCase().includes(q) || b.ticker.toLowerCase().includes(q));
    }
    if (histSort === "newest")      h.sort((a, b) => b.settledAt - a.settledAt);
    if (histSort === "oldest")      h.sort((a, b) => a.settledAt - b.settledAt);
    if (histSort === "biggest_win") h.sort((a, b) => (b.result === b.side ? b.realizedPnlCents : -b.costCents) - (a.result === a.side ? a.realizedPnlCents : -a.costCents));
    if (histSort === "biggest_loss")h.sort((a, b) => (a.result === a.side ? a.realizedPnlCents : -a.costCents) - (b.result === b.side ? b.realizedPnlCents : -b.costCents));
    return h;
  }, [settledBets, histFilter, histSort, histSearch]);

  // ── Render ──────────────────────────────────────────────────────────────
  return (
    <>
      {/* ── Header ── */}
      <div className="header">
        <div className="header-brand">
          <div className="live-badge">
            <span className="live-dot" />
            Kalshi Bot
          </div>
        </div>
        <div className="header-right">
          <div className="refresh-chip">
            Refreshes in {countdown}s
            {lastUpdate && <span style={{ color: "var(--muted)", marginLeft: 2 }}>· {lastUpdate}</span>}
          </div>
          <button
            className={`notify-btn${notifyEnabled ? " active" : ""}`}
            onClick={requestNotify}
            title={notifyEnabled ? "Notifications on" : "Enable notifications"}
          >
            {notifyEnabled ? "🔔" : "🔕"}
          </button>
        </div>
      </div>

      <div className="page">
        {data?.error && <div className="error-box">⚠ {data.error}</div>}

        {/* ── Hero P&L ── */}
        <div className={`hero ${heroClass}`}>
          <div className="hero-eyebrow">Total Profit / Loss</div>
          <div className={`hero-pnl ${heroClass}`} style={{ color: pnlColor }}>
            {loading ? "—" : fmtUsd(pnl, true)}
          </div>
          <div className="hero-sub">
            <span className="hero-sub-item">
              Portfolio: <strong style={{ color: "var(--text)" }}>{data ? fmtUsd(data.portfolioValueCents) : "—"}</strong>
            </span>
            <span className="hero-sub-dot" />
            <span className="hero-sub-item">
              Balance: <strong style={{ color: "var(--text)" }}>{data ? fmtUsd(data.balanceCents) : "—"}</strong>
            </span>
            <span className="hero-sub-dot" />
            <span className="hero-sub-item">
              <strong style={{ color: "var(--orange)" }}>{openBets.length}</strong> open bet{openBets.length !== 1 ? "s" : ""}
            </span>
          </div>

          {/* mini stats row at bottom of hero */}
          <div className="hero-meta">
            <div className="hero-meta-item">
              <div className="hero-meta-label">Win Rate</div>
              <div className="hero-meta-val" style={{ color: total > 0 ? "var(--green)" : "var(--muted2)" }}>
                {winRate}{total > 0 ? "%" : ""}
              </div>
            </div>
            <div className="hero-meta-item">
              <div className="hero-meta-label">Total Bets</div>
              <div className="hero-meta-val" style={{ color: "var(--blue)" }}>{total}</div>
            </div>
            <div className="hero-meta-item">
              <div className="hero-meta-label">Open</div>
              <div className="hero-meta-val" style={{ color: "var(--orange)" }}>{openBets.length}</div>
            </div>
          </div>
        </div>

        {/* ── Stat Cards ── */}
        <div className="cards">
          <div className="card green-accent">
            <div className="card-label">Balance</div>
            <div className="card-value green">{data ? fmtUsd(data.balanceCents) : "—"}</div>
            <div className="card-sub">available cash</div>
          </div>
          <div className="card blue-accent">
            <div className="card-label">Portfolio</div>
            <div className="card-value blue">{data ? fmtUsd(data.portfolioValueCents) : "—"}</div>
            <div className="card-sub">cash + positions</div>
          </div>
          <div className="card orange-accent">
            <div className="card-label">Wins</div>
            <div className="card-value green">{wins}</div>
            <div className="card-sub">+{fmtUsd(totalWonCents)} earned</div>
          </div>
          <div className="card purple-accent">
            <div className="card-label">Losses</div>
            <div className="card-value red">{losses}</div>
            <div className="card-sub">−{fmtUsd(totalLostCents)} lost</div>
          </div>
        </div>

        {/* ── Profit Tracker Bar ── */}
        {!loading && (
          <div className="section">
            <div className="pt-bar-section">
              <div className="pt-bar-header">
                <span className="pt-bar-title">Profit Tracker</span>
                <span style={{ fontSize: 11, color: "var(--muted2)" }}>
                  {openBets.length > 0 ? `${openBets.length} pending · best case ${fmtUsd(pnl + projTotalProfitCents, true)}` : "all bets settled"}
                </span>
              </div>
              <div className="pt-bar-wrap">
                {lossPct > 0 && <div className="pt-bar-seg pt-bar-loss" style={{ width: `${lossPct}%` }} />}
                {gainPct > 0 && <div className="pt-bar-seg pt-bar-realized" style={{ width: `${gainPct}%` }} />}
                {projPct > 0  && <div className="pt-bar-seg pt-bar-projected" style={{ width: `${projPct}%` }} />}
              </div>
              <div className="pt-legend">
                <div className="pt-leg-item">
                  <span className="pt-leg-dot" style={{ background: pnl >= 0 ? "var(--green)" : "var(--red)" }} />
                  <span className="pt-leg-label">Locked In</span>
                  <span className="pt-leg-val" style={{ color: pnlColor }}>{fmtUsd(pnl, true)}</span>
                </div>
                {openBets.length > 0 && (
                  <div className="pt-leg-item">
                    <span className="pt-leg-dot" style={{ background: "rgba(34,197,94,0.4)" }} />
                    <span className="pt-leg-label">Projected</span>
                    <span className="pt-leg-val" style={{ color: "var(--green)" }}>+{fmtUsd(projTotalProfitCents)}</span>
                  </div>
                )}
              </div>
            </div>
          </div>
        )}

        {/* ── P&L Chart ── */}
        <div className="chart-section">
          <div className="chart-header">
            <span className="chart-title">Profit Over Time</span>
            <div className="period-tabs">
              {(["1D","7D","30D","ALL"] as Period[]).map(p => (
                <button
                  key={p}
                  className={`period-btn${period === p ? " active" : ""}`}
                  onClick={() => setPeriod(p)}
                >
                  {p}
                </button>
              ))}
            </div>
          </div>
          <div className="chart-body">
            {chartData.length >= 2 ? (
              <div className="chart-wrap"><canvas ref={chartRef} /></div>
            ) : (
              <div className="chart-empty">
                Chart builds as data accumulates — each refresh adds a point.
              </div>
            )}
          </div>
        </div>

        {/* ── Active Bets ── */}
        <div className="section">
          <div className="section-header">
            <span className="section-title">
              Active Bets
              {liveBets.length > 0 && <span className="section-count">{openBets.length}</span>}
            </span>
            <div className="section-actions">
              <button className="refresh-btn" onClick={fetchLiveBets} disabled={liveBetsLoading}>
                {liveBetsLoading ? "..." : "↺ Refresh"}
              </button>
            </div>
          </div>

          <div className="bets-list">
            {liveBetsLoading && liveBets.length === 0 ? (
              <div className="empty"><div className="empty-sub">Loading bets...</div></div>
            ) : openBets.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">🎯</div>
                <div className="empty-title">No open bets</div>
                <div className="empty-sub">The bot will place bets on the next scan cycle.</div>
              </div>
            ) : openBets.map(b => {
              const contracts  = Math.abs(b.position);
              const costUsd    = b.costCents / 100;
              const payoutUsd  = contracts * 1.00;
              const profitUsd  = payoutUsd - costUsd;
              const unPnl      = b.unrealizedPnlCents / 100;
              const resolveTime = b.expectedExpiration || b.closeTime;
              const hrsLeft    = resolveTime
                ? Math.max(0, (new Date(resolveTime).getTime() - Date.now()) / 3_600_000)
                : null;
              const urgent     = hrsLeft !== null && hrsLeft < 2;

              return (
                <div key={b.ticker} className="bet-card">
                  <div className="bet-card-top">
                    <div className="bet-status-icon pending">→</div>
                    <div className="bet-card-body">
                      <div className="bet-card-title">
                        {b.side === "yes" ? "Betting YES — " : "Betting NO — "}{b.title}
                      </div>
                      <div className="bet-card-meta">
                        <span className={`side-badge side-${b.side}`}>{b.side.toUpperCase()}</span>
                        <span className="bet-chip">{b.ticker}</span>
                        <span className="bet-chip">{contracts} contract{contracts !== 1 ? "s" : ""}</span>
                      </div>
                    </div>
                  </div>

                  <div className="bet-money-row">
                    <div className="bet-money-block">
                      <div className="bet-money-label">Placed</div>
                      <div className="bet-money-val">${costUsd.toFixed(2)}</div>
                    </div>
                    <div className="bet-money-block">
                      <div className="bet-money-label">Cash if Win</div>
                      <div className="bet-money-val green">${payoutUsd.toFixed(2)}</div>
                    </div>
                    <div className="bet-money-block">
                      <div className="bet-money-label">Profit if Win</div>
                      <div className="bet-money-val" style={{ color: "var(--green)" }}>+${profitUsd.toFixed(2)}</div>
                    </div>
                    <div className="bet-money-block">
                      <div className="bet-money-label">Current P&L</div>
                      <div className="bet-money-val" style={{ color: unPnl >= 0 ? "var(--green)" : "var(--red)" }}>
                        {unPnl >= 0 ? "+" : "−"}${Math.abs(unPnl).toFixed(2)}
                      </div>
                    </div>
                  </div>

                  <div className="bet-card-footer">
                    <span className="bet-card-pnl" style={{ color: "var(--muted2)" }}>
                      Bid: {b.yesBid}¢ · Ask: {b.yesAsk}¢ · Last: {b.lastPrice}¢
                    </span>
                    <span className={`bet-card-time${urgent ? " urgent" : ""}`}>
                      {hrsLeft !== null ? `Closes in ${fmtHours(hrsLeft)}` : ""}
                    </span>
                  </div>
                </div>
              );
            })}
          </div>

          {/* Settled bets inline (below open) */}
          {liveBets.filter(b => !!b.result).length > 0 && (
            <>
              <div className="divider" />
              <div style={{ padding: "10px 18px 2px" }}>
                <span style={{ fontSize: 11, color: "var(--muted2)", fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.5px" }}>
                  Settled This Session
                </span>
              </div>
              {liveBets.filter(b => !!b.result).map(b => {
                const won     = b.result === b.side;
                const contracts = Math.abs(b.position);
                const costUsd = b.costCents / 100;
                return (
                  <div key={b.ticker + "_settled"} className="bet-card">
                    <div className="bet-card-top">
                      <div className={`bet-status-icon ${won ? "won" : "lost"}`}>{won ? "✓" : "✗"}</div>
                      <div className="bet-card-body">
                        <div className="bet-card-title">{b.title}</div>
                        <div className="bet-card-meta">
                          <span className={`side-badge side-${b.side}`}>{b.side.toUpperCase()}</span>
                          <span className="bet-chip">{b.ticker} · {contracts} contract{contracts !== 1 ? "s" : ""}</span>
                        </div>
                      </div>
                      <div style={{ fontWeight: 800, fontSize: 14, color: won ? "var(--green)" : "var(--red)" }}>
                        {won ? `+$${(b.realizedPnlCents / 100).toFixed(2)}` : `-$${costUsd.toFixed(2)}`}
                      </div>
                    </div>
                  </div>
                );
              })}
            </>
          )}
        </div>

        {/* ── Bet History ── */}
        <div className="section">
          <div className="section-header">
            <span className="section-title">
              Bet History
              {filteredHistory.length > 0 && <span className="section-count">{filteredHistory.length}</span>}
            </span>
            <div className="section-actions">
              {settledBets.length > 0 && (
                <button className="icon-btn" onClick={() => exportCsv(settledBets)}>
                  ↓ CSV
                </button>
              )}
            </div>
          </div>

          {/* Win rate summary */}
          {total > 0 && (
            <div className="stats-bar">
              <div className="stats-bar-item">
                <span className="stats-bar-label">Win Rate</span>
                <span className="stats-bar-val" style={{ color: "var(--green)" }}>{winRate}%</span>
              </div>
              <div className="stats-bar-item">
                <span className="stats-bar-label">Wins</span>
                <span className="stats-bar-val" style={{ color: "var(--green)" }}>{wins}</span>
              </div>
              <div className="stats-bar-item">
                <span className="stats-bar-label">Losses</span>
                <span className="stats-bar-val" style={{ color: "var(--red)" }}>{losses}</span>
              </div>
              <div className="stats-bar-item">
                <span className="stats-bar-label">Total Won</span>
                <span className="stats-bar-val" style={{ color: "var(--green)" }}>+{fmtUsd(totalWonCents)}</span>
              </div>
              <div className="stats-bar-item">
                <span className="stats-bar-label">Total Lost</span>
                <span className="stats-bar-val" style={{ color: "var(--red)" }}>−{fmtUsd(totalLostCents)}</span>
              </div>
              <div className="stats-bar-item">
                <span className="stats-bar-label">Net</span>
                <span className="stats-bar-val" style={{ color: (totalWonCents - totalLostCents) >= 0 ? "var(--green)" : "var(--red)" }}>
                  {fmtUsd(totalWonCents - totalLostCents, true)}
                </span>
              </div>
            </div>
          )}

          {/* Toolbar */}
          <div className="history-toolbar">
            <input
              className="search-input"
              type="text"
              placeholder="Search markets..."
              value={histSearch}
              onChange={e => setHistSearch(e.target.value)}
            />
            <select className="filter-select" value={histFilter} onChange={e => setHistFilter(e.target.value as HistFilter)}>
              <option value="all">All Results</option>
              <option value="win">Wins Only</option>
              <option value="loss">Losses Only</option>
            </select>
            <select className="filter-select" value={histSort} onChange={e => setHistSort(e.target.value as HistSort)}>
              <option value="newest">Newest First</option>
              <option value="oldest">Oldest First</option>
              <option value="biggest_win">Biggest Win</option>
              <option value="biggest_loss">Biggest Loss</option>
            </select>
          </div>

          <div className="history-list">
            {filteredHistory.length === 0 ? (
              <div className="empty">
                <div className="empty-icon">📋</div>
                <div className="empty-title">{settledBets.length === 0 ? "No history yet" : "No matches"}</div>
                <div className="empty-sub">
                  {settledBets.length === 0 ? "Settled bets will appear here automatically." : "Try adjusting your search or filter."}
                </div>
              </div>
            ) : filteredHistory.map((b, i) => {
              const won = b.result === b.side;
              const pnlCents = won ? b.realizedPnlCents : -b.costCents;
              return (
                <div key={b.ticker + i} className="history-row">
                  <div className={`history-icon ${won ? "win" : "loss"}`}>{won ? "✓" : "✗"}</div>
                  <div className="history-body">
                    <div className="history-title">{b.title}</div>
                    <div className="history-meta">
                      <span className={`side-badge side-${b.side}`}>{b.side.toUpperCase()}</span>
                      <span className="history-date">{fmtDateTime(b.settledAt)}</span>
                      <span className="bet-chip">{b.ticker}</span>
                    </div>
                  </div>
                  <div className="history-right">
                    <div className="history-cost">Cost: {fmtUsd(b.costCents)}</div>
                    <div className="history-pnl" style={{ color: won ? "var(--green)" : "var(--red)" }}>
                      {fmtUsd(pnlCents, true)}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      </div>

      {/* ── Toast notifications ── */}
      <div className="toast-container">
        {toasts.map(t => (
          <div key={t.id} className={`toast ${t.type}`}>
            <span className="toast-icon">{t.type === "win" ? "✅" : t.type === "loss" ? "❌" : "ℹ️"}</span>
            <div className="toast-body">
              <div className="toast-title">{t.title}</div>
              <div className="toast-sub">{t.sub}</div>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}
