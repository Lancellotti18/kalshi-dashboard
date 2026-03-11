/**
 * Practice Signals API
 *
 * Runs the same conviction scoring logic as the Kalshi bot,
 * but entirely server-side on Vercel. No real trades placed.
 * Returns the top markets the bot would trade right now.
 */

import { NextResponse } from "next/server";

export const runtime = "nodejs";
export const maxDuration = 30;

const BASE = "https://api.elections.kalshi.com/trade-api/v2";
const HOURS_MS = 3_600_000;

// Config mirrors kalshi-bot defaults
const MIN_CONVICTION = 0.55; // slightly lower so we always show something
const MIN_VOLUME = 200;
const MIN_PRICE_CENTS = 8;
const MAX_PRICE_CENTS = 92;
const MIN_HOURS_TO_CLOSE = 2;

interface Market {
  ticker: string;
  title: string;
  status: string;
  close_time: string;
  yes_bid: number;
  yes_ask: number;
  no_bid: number;
  no_ask: number;
  last_price: number;
  volume: number;
  volume_24h: number;
}

interface Orderbook {
  yes: [number, number][];
  no: [number, number][];
}

async function getMarkets(cursor?: string): Promise<{ markets: Market[]; cursor: string | null }> {
  const params = new URLSearchParams({ limit: "200", status: "open" });
  if (cursor) params.set("cursor", cursor);
  const res = await fetch(`${BASE}/markets?${params}`, { cache: "no-store" });
  if (!res.ok) return { markets: [], cursor: null };
  const d = await res.json();
  return { markets: d.markets ?? [], cursor: d.cursor ?? null };
}

async function getOrderbook(ticker: string): Promise<Orderbook | null> {
  try {
    const res = await fetch(`${BASE}/markets/${ticker}/orderbook?depth=10`, { cache: "no-store" });
    if (!res.ok) return null;
    const d = await res.json();
    return d.orderbook ?? null;
  } catch { return null; }
}

function computeImbalance(ob: Orderbook): { imbalance: number; side: "yes" | "no" } {
  const yesLiq = (ob.yes ?? []).reduce((s, [p, sz]) => s + p * sz, 0);
  const noLiq  = (ob.no  ?? []).reduce((s, [p, sz]) => s + p * sz, 0);
  const total = yesLiq + noLiq;
  if (total === 0) return { imbalance: 0.5, side: "yes" };
  const yesFrac = yesLiq / total;
  return yesFrac >= 0.5
    ? { imbalance: yesFrac, side: "yes" }
    : { imbalance: 1 - yesFrac, side: "no" };
}

function timeFactor(hoursToClose: number): number {
  if (hoursToClose < 2)  return 0;
  if (hoursToClose <= 48) return 1.0;
  if (hoursToClose <= 168) return 1 - (hoursToClose - 48) / 120;
  return 0.1;
}

function volumeScore(vol: number): number {
  return Math.min(1, Math.log10(Math.max(vol, 1)) / Math.log10(50_000));
}

export async function GET() {
  try {
    // Fetch up to 600 markets (3 pages)
    const allMarkets: Market[] = [];
    let cursor: string | undefined;
    for (let i = 0; i < 3; i++) {
      const { markets, cursor: next } = await getMarkets(cursor);
      allMarkets.push(...markets);
      if (!next) break;
      cursor = next;
    }

    const now = Date.now();
    const minClose = now + MIN_HOURS_TO_CLOSE * HOURS_MS;

    // Pre-filter
    const eligible = allMarkets.filter((m) => {
      if (m.status !== "open" && m.status !== "active") return false;
      const closeMs = new Date(m.close_time).getTime();
      if (closeMs < minClose) return false;
      const mid = Math.round(((m.yes_bid ?? 0) + (m.yes_ask ?? 0)) / 2);
      if (mid < MIN_PRICE_CENTS || mid > MAX_PRICE_CENTS) return false;
      const vol = m.volume_24h ?? m.volume ?? 0;
      if (vol < MIN_VOLUME) return false;
      return true;
    });

    // Sort by volume desc, score top 20
    eligible.sort((a, b) => (b.volume_24h ?? 0) - (a.volume_24h ?? 0));
    const candidates = eligible.slice(0, 20);

    const signals = [];

    for (const m of candidates) {
      const ob = await getOrderbook(m.ticker);
      const hoursToClose = (new Date(m.close_time).getTime() - now) / HOURS_MS;
      const vol = m.volume_24h ?? m.volume ?? 0;

      const { imbalance, side } = ob
        ? computeImbalance(ob)
        : { imbalance: 0.5, side: "yes" as const };

      const vScore = volumeScore(vol);
      const tFactor = timeFactor(hoursToClose);

      // conviction = same formula as the bot
      const conviction = imbalance * 0.40 + vScore * 0.30 + 0.5 * 0.20 + tFactor * 0.10;

      if (conviction < MIN_CONVICTION) continue;

      const entryPrice = side === "yes"
        ? Math.round(((m.yes_bid ?? 0) + (m.yes_ask ?? 0)) / 2)
        : Math.round(((m.no_bid ?? 0) + (m.no_ask ?? 0)) / 2);

      signals.push({
        ticker: m.ticker,
        title: m.title,
        side,
        entryPriceCents: entryPrice,
        conviction: parseFloat(conviction.toFixed(3)),
        imbalance: parseFloat(imbalance.toFixed(3)),
        volumeScore: parseFloat(vScore.toFixed(3)),
        timeFactor: parseFloat(tFactor.toFixed(3)),
        volume: vol,
        hoursToClose: parseFloat(hoursToClose.toFixed(1)),
        // Simulated trade sizing (same as bot with $100 capital, 10% max position)
        maxPosition: 10.00,
        allocatedUsd: parseFloat((10.00 * Math.pow(conviction, 1.5)).toFixed(2)),
        contracts: entryPrice > 0
          ? Math.floor((10.00 * Math.pow(conviction, 1.5)) / (entryPrice / 100))
          : 0,
        maxProfit: entryPrice > 0
          ? parseFloat(((Math.floor((10.00 * Math.pow(conviction, 1.5)) / (entryPrice / 100))) * (1 - entryPrice / 100)).toFixed(2))
          : 0,
      });
    }

    signals.sort((a, b) => b.conviction - a.conviction);

    return NextResponse.json({ signals: signals.slice(0, 8), scanned: eligible.length, ts: Date.now() });
  } catch (e) {
    return NextResponse.json({ error: String(e), signals: [] }, { status: 500 });
  }
}
