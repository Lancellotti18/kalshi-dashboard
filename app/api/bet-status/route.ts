import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const BASE = "https://api.elections.kalshi.com/trade-api/v2";

export async function GET(req: Request) {
  const { searchParams } = new URL(req.url);
  const tickers = (searchParams.get("tickers") ?? "").split(",").filter(Boolean);
  if (!tickers.length) return NextResponse.json({ markets: [] });

  const results = await Promise.all(
    tickers.map(async (ticker) => {
      try {
        const res = await fetch(`${BASE}/markets/${ticker}`, { cache: "no-store" });
        if (!res.ok) return { ticker, status: "unknown" };
        const d = await res.json();
        const m = d.market ?? {};
        const dollars = (f: string) => Math.round(parseFloat(String(m[f] ?? "0")) * 100);
        return {
          ticker,
          status:     m.status ?? "unknown",
          result:     m.result ?? null,         // "yes" | "no" | "" | null
          yesBid:     dollars("yes_bid_dollars"),
          yesAsk:     dollars("yes_ask_dollars"),
          noBid:      dollars("no_bid_dollars"),
          noAsk:      dollars("no_ask_dollars"),
          lastPrice:  dollars("last_price_dollars"),
          closeTime:  m.close_time ?? null,
        };
      } catch {
        return { ticker, status: "unknown" };
      }
    })
  );

  return NextResponse.json({ markets: results });
}
