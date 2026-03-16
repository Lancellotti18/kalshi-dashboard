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

    // Only active positions (position_fp != 0)
    const activePos = ((posData.market_positions ?? []) as Record<string, unknown>[])
      .filter((p) => parseFloat(String(p.position_fp ?? "0")) !== 0);

    const positions = activePos.map((p) => ({
      ticker:       String(p.ticker ?? ""),
      title:        String(p.market_title ?? p.ticker ?? ""),
      position:     Math.round(parseFloat(String(p.position_fp ?? "0"))),
      unrealizedPnl: 0, // computed in live-bets from market price
      realizedPnl:  toCents(p.realized_pnl_dollars),
      exposure:     toCents(p.market_exposure_dollars),
      cost:         toCents(p.total_traded_dollars),
    }));

    // P&L = sum of all realized P&L across positions
    const totalRealizedPnlCents = positions.reduce((s, p) => s + p.realizedPnl, 0);

    return NextResponse.json({
      pnlCents:            totalRealizedPnlCents,
      balanceCents:        bal.balance ?? 0,
      portfolioValueCents: bal.portfolio_value ?? 0,
      positions,
      ts: Date.now(),
    });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
