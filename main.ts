// Dip-and-hold: a single-trade mean-reversion bot for a grind-down window.
//
// Design (from the dev-window diagnosis): the window grinds down with one
// slow recovery. Fast mean-reversion signals (SMA dip, RSI) fire dozens of
// times on 1-minute noise and lose to the 26 bps round-trip cost; momentum
// is negatively predictive here (sharp up-moves reverse). The one robust
// edge is a single patient trade: buy the first bounce after a deep dip
// below the 60-bar high, then HOLD through the chop with no tight stop
// (a tight stop is what killed every earlier design) and exit at a fixed
// take-profit near the recovery peak. A wide 2.5% safety stop only guards
// against a catastrophic decline; it never triggers on the dev window
// (max drawdown of the trade is ~1.5%).
//
// Entry (flat only): the latest close is at least 1.5% below the highest
// close of the previous 60 bars, AND the latest close is above the previous
// bar's close (bounce confirmation). One buy for the full cash balance.
// No new entries after scored bar 1200 (too little window left for the
// trade to reach its target).
//
// Exit (holding): take profit at +1.9% above the entry FILL price, or the
// 2.5% safety stop below it. Prices are measured from the harness-reported
// fill price, never from the trigger close.
//
// Deterministic: no randomness, no clock, no environment reads. All
// decisions come only from the bars received.

import { runBars } from "./vendor/makefun-bars.ts";
import type { BarsState, Batch } from "./vendor/makefun-bars.ts";

const SYMBOL = "CBBTC";
const PRICE_SCALE = 1e5;

// Strategy parameters.
const DIP_LOOKBACK = 60; // bars for the rolling high
const DIP_PCT = 0.015; // entry: close >= 1.5% below the 60-bar high
const TAKE_PROFIT = 0.019; // exit: +1.9% above the entry fill
const SAFETY_STOP = 0.025; // exit: -2.5% below the entry fill (safety only)
const LAST_ENTRY_BAR = 1200; // no new entries after this scored bar

// Close history in dollars, including warm-up bars.
const closes: number[] = [];
// Scored bars seen (warm-up batches do not count).
let scoredBar = 0;
// Entry fill price in dollars, from the harness-reported fill. Null when flat.
let entryFill: number | null = null;

function closeDollars(bar: { c: string }): number {
  return Number(BigInt(bar.c)) / PRICE_SCALE;
}

function rollingHigh(n: number): number | null {
  if (closes.length < n) return null;
  let hi = -Infinity;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i]! > hi) hi = closes[i]!;
  }
  return hi;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);
    if (bar === undefined) return [];

    // Fold in this batch's fills first: a filled buy sets the entry fill
    // price; a filled sell clears the position.
    for (const fill of batch.fills) {
      if (fill.symbol !== SYMBOL) continue;
      if (fill.status !== "filled") continue;
      if (fill.side === "buy") {
        entryFill = Number(BigInt(fill.price)) / PRICE_SCALE;
      } else if (fill.side === "sell") {
        entryFill = null;
      }
    }

    const close = closeDollars(bar);
    const prevClose = closes.length > 0 ? closes[closes.length - 1]! : null;

    // Warm-up batches build history but never trade.
    if (state.warmingUp) {
      closes.push(close);
      return [];
    }
    scoredBar += 1;

    const holding = state.positions.get(SYMBOL) !== undefined && entryFill !== null;

    // Exit checks (holding only).
    if (holding && entryFill !== null) {
      if (close >= entryFill * (1 + TAKE_PROFIT)) {
        const pos = state.positions.get(SYMBOL)!;
        entryFill = null;
        return [{ side: "sell", symbol: SYMBOL, qty: pos.qty, max_slippage_bps: 100 }];
      }
      if (close <= entryFill * (1 - SAFETY_STOP)) {
        const pos = state.positions.get(SYMBOL)!;
        entryFill = null;
        return [{ side: "sell", symbol: SYMBOL, qty: pos.qty, max_slippage_bps: 100 }];
      }
      closes.push(close);
      return [];
    }

    // Entry checks (flat only).
    if (!holding && scoredBar <= LAST_ENTRY_BAR) {
      const high = rollingHigh(DIP_LOOKBACK);
      if (
        high !== null &&
        prevClose !== null &&
        close <= high * (1 - DIP_PCT) &&
        close > prevClose
      ) {
        closes.push(close);
        return [{ side: "buy", symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: 100 }];
      }
    }

    closes.push(close);
    return [];
  },
});
