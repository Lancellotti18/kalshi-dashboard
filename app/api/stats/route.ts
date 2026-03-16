import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const KEY_ID = process.env.KALSHI_API_KEY_ID ?? "";
const RAW_KEY = Buffer.from(process.env.KALSHI_PRIVATE_KEY ?? "", "base64").toString("utf8").trim();

function makeHeaders(method: string, urlPath: string): Record<string, string> {
  const ts = Date.now().toString();
  const msg = ts + method.toUpperCase() + urlPath;
  const sig = crypto
    .sign("sha256", Buffer.from(msg), {
      key: RAW_KEY,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
  return {
    "KALSHI-ACCESS-KEY": KEY_ID,
    "KALSHI-ACCESS-SIGNATURE": sig,
    "KALSHI-ACCESS-TIMESTAMP": ts,
    Accept: "application/json",
  };
}

async function kGet(path: string) {
  const basePath = new URL(BASE).pathname;
  const res = await fetch(BASE + path, {
    headers: makeHeaders("GET", basePath + path),
    cache: "no-store",
  });
  if (!res.ok) throw new Error(`Kalshi ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function GET() {
  if (!KEY_ID || !RAW_KEY.includes("PRIVATE KEY")) {
    return NextResponse.json(
      { error: "Missing Kalshi credentials — set KALSHI_API_KEY_ID and KALSHI_PRIVATE_KEY in Vercel env vars." },
      { status: 503 }
    );
  }

  try {
    const [bal, posData] = await Promise.all([
      kGet("/portfolio/balance"),
      kGet("/portfolio/positions"),
    ]);

    // Kalshi elections API uses _dollars suffix string fields and position_fp
    const toCents = (v: unknown): number =>
      Math.round(parseFloat(String(v ?? "0")) * 100);

    // ── P&L: portfolio_value − starting_capital ───────────────────────────────
    // Kalshi's /portfolio/positions only returns ACTIVE positions; settled ones
    // are not included, so realized_pnl_dollars from positions is always 0.
    // Instead, use portfolio_value (cash + open positions at market value) minus
    // starting capital — this reliably captures every win and loss.
    //
    // TOTAL_CAPITAL_USD: set this in Vercel env vars to match your deposit amount.
    // Defaults to 13 ($13) if not set.
    const startingCapitalCents = Math.round(
      parseFloat(process.env.TOTAL_CAPITAL_USD ?? "13") * 100
    );
    const portfolioValueCents = bal.portfolio_value ?? 0;
    const pnlCents = portfolioValueCents - startingCapitalCents;

    // Active positions (position_fp != 0) for the open bets display only
    const allPos = ((posData.market_positions ?? []) as Record<string, unknown>[]);
    const activePos = allPos.filter(
      (p) => parseFloat(String(p.position_fp ?? "0")) !== 0
    );

    const positions = activePos.map((p) => ({
      ticker:        String(p.ticker ?? ""),
      title:         String(p.market_title ?? p.ticker ?? ""),
      position:      Math.round(parseFloat(String(p.position_fp ?? "0"))),
      unrealizedPnl: 0, // computed in live-bets from market price
      realizedPnl:   toCents(p.realized_pnl_dollars),
      exposure:      toCents(p.market_exposure_dollars),
      cost:          toCents(p.total_traded_dollars),
    }));

    return NextResponse.json({
      pnlCents,
      startingCapitalCents,
      balanceCents:        bal.balance ?? 0,
      portfolioValueCents,
      positions,
      ts: Date.now(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
