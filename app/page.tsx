"use client";

import { useCallback, useEffect, useRef, useState } from "react";

const REFRESH_SEC  = 30;
const HISTORY_KEY  = "kalshi_pnl_history";
const BET_HIST_KEY = "kalshi_bet_history";

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
function fmtUsd(cents: number, sign = false): string {
  const v = cents / 100;
  const abs = Math.abs(v).toFixed(2);
  return sign ? (v >= 0 ? "+" : "−") + "$" + abs : "$" + abs;
}
function fmtHours(h: number): string {
  if (h < 1) return Math.round(h * 60) + "m";
  if (h < 24) return h.toFixed(0) + "h";
  return (h / 24).toFixed(1) + "d";
}

export default function Dashboard() {
  const [data, setData]         = useState<Stats | null>(null);
  const [history, setHistory]   = useState<HistoryPoint[]>([]);
  const [liveBets, setLiveBets] = useState<LiveBet[]>([]);
  const [settledBets, setSettledBets] = useState<SettledBet[]>([]);
  const [liveBetsLoading, setLiveBetsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<"live" | "history" | "pnl" | "chart">("live");
  const [countdown, setCountdown] = useState(REFRESH_SEC);
  const [lastUpdate, setLastUpdate] = useState("");
  const [loading, setLoading]   = useState(true);
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

  const fetchLiveBets = useCallback(async () => {
    setLiveBetsLoading(true);
    try {
      const res = await fetch("/api/live-bets");
      const json = await res.json();
      const incoming: LiveBet[] = json.bets ?? [];
      setLiveBets(incoming);

      // Move settled bets into history
      const hist = loadBetHistory();
      incoming.forEach(b => {
        if ((b.status === "finalized" || b.status === "settled" || b.result) && b.result) {
          if (!hist.some(h => h.ticker === b.ticker)) {
            hist.push({
              ticker: b.ticker,
              title: b.title,
              side: b.side,
              costCents: b.costCents,
              realizedPnlCents: b.realizedPnlCents,
              result: b.result,
              settledAt: Date.now(),
            });
          }
        }
      });
      if (hist.length > 200) hist.splice(0, hist.length - 200);
      saveBetHistory(hist);
      setSettledBets([...hist].reverse());
    } catch (e) { console.error(e); }
    finally { setLiveBetsLoading(false); }
  }, []);

  useEffect(() => {
    setHistory(loadHistory());
    setSettledBets([...loadBetHistory()].reverse());
    fetchStats();
    fetchLiveBets();
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fetchStats]);

  useEffect(() => {
    const t = setInterval(() => {
      setCountdown((c) => { if (c <= 1) { fetchStats(); fetchLiveBets(); return REFRESH_SEC; } return c - 1; });
    }, 1000);
    return () => clearInterval(t);
  }, [fetchStats, fetchLiveBets]);

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
  const positions = data?.positions ?? [];
  const unrealizedTotal = positions.reduce((s, p) => s + p.unrealizedPnl, 0);

  // Projected winnings across all open bets
  const openBets = liveBets.filter(b => !b.result);
  const projTotalPlacedCents  = openBets.reduce((s, b) => s + b.costCents, 0);
  const projTotalPayoutCents  = openBets.reduce((s, b) => s + Math.abs(b.position) * 100, 0);
  const projTotalProfitCents  = projTotalPayoutCents - projTotalPlacedCents;

  // Profit tracker bar
  const realizedProfit  = Math.max(0, pnl);          // locked-in wins (cents)
  const realizedLoss    = Math.max(0, -pnl);          // locked-in losses (cents)
  const barScale        = Math.max(1, realizedProfit + projTotalProfitCents + realizedLoss);
  const realizedPct     = (realizedProfit / barScale) * 100;
  const projectedPct    = (projTotalProfitCents / barScale) * 100;
  const lossPct         = (realizedLoss / barScale) * 100;
  const totalPotential  = pnl + projTotalProfitCents; // best-case total

  return (
    <>
      {/* Header */}
      <div className="header">
        <div className="header-left">
          <span className="dot" />
          <h1>Kalshi Bot</h1>
          <span className="badge">LIVE</span>
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
          <div className="refresh-info">
            Refreshes in {countdown}s
            {lastUpdate && <span style={{ color: "var(--muted)", marginLeft: 6 }}>{lastUpdate}</span>}
          </div>
        </div>
      </div>

      <div className="page">
        {data?.error && <div className="error-box">⚠️ {data.error}</div>}

        {/* Profit Made Banner */}
        <div className={`profit-banner ${bannerClass}`}>
          <div className="profit-banner-label">Total Profit / Loss</div>
          <div className="profit-banner-value" style={{ color: pnlColor }}>
            {loading ? "—" : fmtUsd(pnl, true)}
          </div>
          <div className="profit-banner-sub">
            {data && !data.error
              ? `Balance: ${fmtUsd(data.balanceCents ?? 0)} · Portfolio: ${fmtUsd(data.portfolioValueCents ?? 0)} · ${liveBets.length} open bet${liveBets.length !== 1 ? "s" : ""}`
              : data?.error
              ? "API error — check credentials"
              : "Connecting to Kalshi..."}
          </div>
        </div>

        {/* Profit Tracker Bar */}
        {(openBets.length > 0 || pnl !== 0) && (
          <div className="profit-tracker">
            <div className="pt-header">
              <span className="pt-title">Profit Tracker</span>
              <span className="pt-meta">
                {openBets.length > 0 ? `${openBets.length} bet${openBets.length !== 1 ? "s" : ""} pending` : "all bets settled"}
              </span>
            </div>

            {/* Bar */}
            <div className="pt-bar-wrap">
              {lossPct > 0 && (
                <div className="pt-bar-seg pt-bar-loss" style={{ width: `${lossPct}%` }} title={`Locked loss: ${fmtUsd(-pnl)}`} />
              )}
              {realizedPct > 0 && (
                <div className="pt-bar-seg pt-bar-realized" style={{ width: `${realizedPct}%` }} title={`Locked profit: ${fmtUsd(realizedProfit)}`} />
              )}
              {projectedPct > 0 && (
                <div className="pt-bar-seg pt-bar-projected" style={{ width: `${projectedPct}%` }} title={`Projected: +${fmtUsd(projTotalProfitCents)}`} />
              )}
            </div>

            {/* Legend row */}
            <div className="pt-legend">
              <div className="pt-leg-item">
                <span className="pt-leg-dot" style={{ background: "var(--green)" }} />
                <span className="pt-leg-label">Locked In</span>
                <span className="pt-leg-val" style={{ color: pnl >= 0 ? "var(--green)" : "var(--red)" }}>
                  {fmtUsd(pnl, true)}
                </span>
              </div>
              {openBets.length > 0 && (
                <div className="pt-leg-item">
                  <span className="pt-leg-dot" style={{ background: "rgba(34,197,94,0.35)" }} />
                  <span className="pt-leg-label">Projected</span>
                  <span className="pt-leg-val" style={{ color: "var(--green)" }}>+{fmtUsd(projTotalProfitCents)}</span>
                </div>
              )}
              <div className="pt-leg-item">
                <span className="pt-leg-dot" style={{ background: "var(--blue)" }} />
                <span className="pt-leg-label">Best Case Total</span>
                <span className="pt-leg-val" style={{ color: totalPotential >= 0 ? "var(--green)" : "var(--red)" }}>
                  {fmtUsd(totalPotential, true)}
                </span>
              </div>
            </div>
          </div>
        )}

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
            <div className="card-label">Open Bets</div>
            <div className="card-value orange">{liveBetsLoading && liveBets.length === 0 ? "…" : liveBets.length}</div>
            <div className="card-sub">{liveBets.length === 1 ? "1 market" : `${liveBets.length} markets`}</div>
          </div>
          <div className="card">
            <div className="card-label">Unrealized P&L</div>
            <div className="card-value" style={{ color: data ? (unrealizedTotal >= 0 ? "var(--green)" : "var(--red)") : "var(--muted)" }}>
              {data ? fmtUsd(unrealizedTotal, true) : "—"}
            </div>
            <div className="card-sub">open positions</div>
          </div>
        </div>

        {/* Tab bar */}
        <div className="tab-bar">
          {(["live","history","pnl","chart"] as const).map(tab => (
            <button
              key={tab}
              className={`tab-btn${activeTab === tab ? " tab-active" : ""}`}
              onClick={() => setActiveTab(tab)}
            >
              {tab === "live"    ? `Live Bets${liveBets.length ? ` (${liveBets.length})` : ""}` :
               tab === "history" ? `History${settledBets.length ? ` (${settledBets.length})` : ""}` :
               tab === "pnl"     ? "P&L" : "Chart"}
            </button>
          ))}
        </div>

        {/* ── Live Bets tab ── */}
        {activeTab === "live" && (
          <div className="section">
            <div className="section-header">
              <span>Live Bets</span>
              <button className="refresh-btn" onClick={fetchLiveBets} disabled={liveBetsLoading}>
                {liveBetsLoading ? "..." : "↺ Refresh"}
              </button>
            </div>
            <div className="section-body" style={{ padding: 0 }}>
              {liveBetsLoading && liveBets.length === 0 ? (
                <div className="empty"><div className="empty-sub">Loading bets...</div></div>
              ) : liveBets.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon">🎯</div>
                  <div className="empty-title">No open bets</div>
                  <div className="empty-sub">The bot will place bets on the next scan cycle.</div>
                </div>
              ) : liveBets.map((b) => {
                const won     = b.result === b.side;
                const settled = !!b.result;
                const icon    = settled ? (won ? "✓" : "✗") : "→";
                const iconClr = settled ? (won ? "var(--green)" : "var(--red)") : "var(--orange)";
                const costUsd = b.costCents / 100;
                const contracts = Math.abs(b.position);
                // Payout = contracts × $1.00 if we win
                const payoutUsd = contracts * 1.00;
                const profitUsd = payoutUsd - costUsd;
                const unPnl = b.unrealizedPnlCents / 100;
                const resolveTime = b.expectedExpiration || b.closeTime;
                const hrsLeft = resolveTime
                  ? Math.max(0, (new Date(resolveTime).getTime() - Date.now()) / 3_600_000)
                  : null;
                // Human-readable bet description
                const betLabel = b.side === "yes"
                  ? `Betting YES — ${b.title}`
                  : `Betting NO — ${b.title}`;

                return (
                  <div key={b.ticker} className="bet-card">
                    {/* Status icon + title */}
                    <div className="bet-card-top">
                      <div className="bet-status-icon" style={{ color: iconClr }}>{icon}</div>
                      <div className="bet-card-info">
                        <div className="bet-card-title">{betLabel}</div>
                        <div className="bet-card-ticker">{b.ticker} · {contracts} contract{contracts !== 1 ? "s" : ""}</div>
                      </div>
                    </div>

                    {/* Money row: placed → cash if win */}
                    <div className="bet-money-row">
                      <div className="bet-money-block">
                        <div className="bet-money-label">Placed</div>
                        <div className="bet-money-val">${costUsd.toFixed(2)}</div>
                      </div>
                      <div className="bet-money-arrow">→</div>
                      <div className="bet-money-block">
                        <div className="bet-money-label">Cash if Win</div>
                        <div className="bet-money-val green">${payoutUsd.toFixed(2)}</div>
                      </div>
                      <div className="bet-money-block">
                        <div className="bet-money-label">Profit if Win</div>
                        <div className="bet-money-val" style={{ color: "var(--green)" }}>+${profitUsd.toFixed(2)}</div>
                      </div>
                    </div>

                    {/* Bottom row: status + time */}
                    <div className="bet-card-footer">
                      {settled ? (
                        <span style={{ color: won ? "var(--green)" : "var(--red)", fontWeight: 700, fontSize: 13 }}>
                          {won
                            ? `Won +$${(b.realizedPnlCents / 100).toFixed(2)}`
                            : `Lost -$${costUsd.toFixed(2)}`}
                        </span>
                      ) : (
                        <span style={{ color: unPnl >= 0 ? "var(--green)" : "var(--red)", fontSize: 12 }}>
                          Current P&L: {unPnl >= 0 ? "+" : "−"}${Math.abs(unPnl).toFixed(2)}
                        </span>
                      )}
                      <span style={{ fontSize: 11, color: hrsLeft !== null && hrsLeft < 2 ? "var(--orange)" : "var(--muted)" }}>
                        {settled ? "Settled" : hrsLeft !== null ? `Closes in ${fmtHours(hrsLeft)}` : ""}
                      </span>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── History tab ── */}
        {activeTab === "history" && (
          <div className="section">
            <div className="section-header">
              <span>Bet History</span>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>settled bets</span>
            </div>
            <div className="section-body" style={{ padding: 0 }}>
              {settledBets.length === 0 ? (
                <div className="empty">
                  <div className="empty-icon">📋</div>
                  <div className="empty-title">No history yet</div>
                  <div className="empty-sub">Settled bets will appear here automatically.</div>
                </div>
              ) : settledBets.map((b, i) => {
                const won = b.result === b.side;
                const pnlCents = b.realizedPnlCents;
                return (
                  <div key={b.ticker + i} className="bet-row">
                    <div className="bet-icon" style={{ color: won ? "var(--green)" : "var(--red)", fontSize: 18 }}>
                      {won ? "✓" : "✗"}
                    </div>
                    <div className="bet-body">
                      <div className="bet-title">{b.title.slice(0, 60)}</div>
                      <div className="bet-meta">
                        <span className={`side-badge side-${b.side}`}>{b.side.toUpperCase()}</span>
                        <span style={{ fontSize: 10, color: "var(--muted)", marginLeft: 6 }}>
                          {new Date(b.settledAt).toLocaleDateString([], { month: "short", day: "numeric" })}
                        </span>
                      </div>
                    </div>
                    <div className="bet-right">
                      <div className="bet-amounts">
                        <span style={{ color: "var(--muted)", fontSize: 11 }}>Cost</span>
                        <span style={{ fontWeight: 700, fontSize: 13 }}>${(b.costCents / 100).toFixed(2)}</span>
                      </div>
                      <div className="bet-amounts" style={{ marginTop: 2 }}>
                        <span style={{ color: "var(--muted)", fontSize: 11 }}>{won ? "Profit" : "Loss"}</span>
                        <span style={{ fontWeight: 700, fontSize: 13, color: won ? "var(--green)" : "var(--red)" }}>
                          {won ? `+$${(pnlCents / 100).toFixed(2)}` : `-$${(b.costCents / 100).toFixed(2)}`}
                        </span>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          </div>
        )}

        {/* ── P&L tab ── */}
        {activeTab === "pnl" && (
          <div className="section">
            <div className="section-header">
              <span>Profit / Loss</span>
              <span style={{ fontSize: 10, color: "var(--muted)" }}>live from Kalshi</span>
            </div>
            <div className="section-body">
              {data && !data.error ? (
                <>
                  <div className="pnl-row"><span className="pnl-label">Realized P&L</span><span className="pnl-value" style={{ color: pnlColor }}>{fmtUsd(pnl, true)}</span></div>
                  <div className="pnl-row"><span className="pnl-label">Unrealized P&L</span>
                    <span className="pnl-value" style={{ color: unrealizedTotal >= 0 ? "var(--green)" : "var(--red)" }}>
                      {fmtUsd(unrealizedTotal, true)}
                    </span>
                  </div>
                  <div className="pnl-row"><span className="pnl-label">Available Balance</span><span className="pnl-value green">{fmtUsd(data.balanceCents)}</span></div>
                  <div className="pnl-row"><span className="pnl-label">Portfolio Value</span><span className="pnl-value blue">{fmtUsd(data.portfolioValueCents)}</span></div>
                  <div className="pnl-row"><span className="pnl-label">Open Positions</span><span className="pnl-value orange">{liveBets.length}</span></div>
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
        )}

        {/* ── Chart tab ── */}
        {activeTab === "chart" && (
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
                  <div className="empty-sub">Chart builds as you open the app — each visit logs a point.</div>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </>
  );
}
