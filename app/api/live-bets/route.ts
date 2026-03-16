/**
 * /api/live-bets
 *
 * Kalshi elections API actual field names (confirmed from live response):
 *   position_fp           → contract count as string float ("-2.00" = 2 NO contracts)
 *   total_traded_dollars  → cost paid, dollars as string ("1.6400")
 *   realized_pnl_dollars  → realized P&L, dollars as string
 *   market_exposure_dollars → max loss, dollars as string
 *   ticker                → market ticker
 *   (NO market_title — fetched from /markets/{ticker})
 */
import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";
export const maxDuration = 30;

const BASE   = "https://api.elections.kalshi.com/trade-api/v2";
const KEY_ID = process.env.KALSHI_API_KEY_ID ?? "";
const RAW_KEY = Buffer.from(process.env.KALSHI_PRIVATE_KEY ?? "", "base64")
  .toString("utf8")
  .trim();

function makeHeaders(method: string, urlPath: string): Record<string, string> {
  const ts  = Date.now().toString();
  const msg = ts + method.toUpperCase() + urlPath;
  const sig = crypto
    .sign("sha256", Buffer.from(msg), {
      key: RAW_KEY,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
    })
    .toString("base64");
  return {
    "KALSHI-ACCESS-KEY":       KEY_ID,
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
  if (!res.ok) throw new Error(`Kalshi ${path} → ${res.status}`);
  return res.json();
}

// Parse a dollar-string like "1.6400" → cents integer (164)
const toCents = (v: unknown): number =>
  Math.round(parseFloat(String(v ?? "0")) * 100);

export async function GET() {
  if (!KEY_ID || !RAW_KEY.includes("PRIVATE KEY")) {
    return NextResponse.json({ error: "Missing credentials" }, { status: 503 });
  }

  try {
    const posData = await kGet("/portfolio/positions");
    const allPositions = (posData.market_positions ?? []) as Record<string, unknown>[];

    // Filter to only positions with active contracts (position_fp != 0)
    const activePositions = allPositions.filter(
      (p) => parseFloat(String(p.position_fp ?? "0")) !== 0
    );

    const bets = await Promise.all(
      activePositions.map(async (p) => {
        const ticker   = String(p.ticker ?? "");
        // position_fp: "-2.00" = 2 NO contracts, "3.00" = 3 YES contracts
        const position = Math.round(parseFloat(String(p.position_fp ?? "0")));
        const side     = position >= 0 ? "yes" : "no";
        const costCents = toCents(p.total_traded_dollars);
        const realizedPnlCents = toCents(p.realized_pnl_dollars);

        // Fetch market data for title, price, result
        try {
          const mkt = await kGet(`/markets/${ticker}`);
          const m   = mkt.market ?? {};
          const d   = (f: string) => Math.round(parseFloat(String(m[f] ?? "0")) * 100);

          const lastPriceCents = d("last_price_dollars");
          const contracts      = Math.abs(position);

          // Unrealized P&L: (currentPrice - entryPrice) × contracts
          // entryPrice per contract = costCents / contracts
          const entryPriceCents = contracts > 0 ? Math.round(costCents / contracts) : 0;
          const currentSidePriceCents = side === "yes"
            ? Math.round((d("yes_bid_dollars") + d("yes_ask_dollars")) / 2)
            : Math.round(((100 - d("yes_ask_dollars") / 100) + (100 - d("yes_bid_dollars") / 100)) / 2);
          const unrealizedPnlCents = contracts > 0
            ? (currentSidePriceCents - entryPriceCents) * contracts
            : 0;

          return {
            ticker,
            title:               String(m.title ?? ticker),
            position,
            side,
            costCents,
            unrealizedPnlCents,
            realizedPnlCents,
            status:              String(m.status ?? "active"),
            result:              (m.result as string | null) ?? null,
            yesBid:              d("yes_bid_dollars"),
            yesAsk:              d("yes_ask_dollars"),
            lastPrice:           lastPriceCents,
            closeTime:           String(m.close_time ?? ""),
            expectedExpiration:  String(m.expected_expiration_time ?? m.close_time ?? ""),
          };
        } catch {
          return {
            ticker,
            title: ticker,
            position, side, costCents,
            unrealizedPnlCents: 0,
            realizedPnlCents,
            status: "active", result: null,
            yesBid: 0, yesAsk: 0, lastPrice: 0,
            closeTime: "", expectedExpiration: "",
          };
        }
      })
    );

    return NextResponse.json({ bets, ts: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 });
  }
}
