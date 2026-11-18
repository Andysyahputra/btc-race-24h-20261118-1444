// Deep-dip hold — BTC Race 24h (btc-race-24h-20261118-1444).
//
// One patient trade: buy the first deep dip and ride the recovery to a
// fixed target, instead of scalping small bounces. The dev window is a
// steady grind down with a single +2.5% recovery in the middle; small
// dips after the recovery are 1-minute noise that lose to the 26 bps
// round-trip cost, so this bot only buys a dip deep enough to be the
// real bottom, then holds through the chop.
//
// Rules (all in integer basis points, no floats, no clock, no randomness):
//   Entry: close <= 60-bar high * (1 - 2.4%) AND close > previous close
//          (a bounce after a deep dip). Full cash, one position.
//   Exit:  take profit at entry fill * (1 + 2.6%), or safety stop at
//          entry fill * (1 - 2.5%) against a catastrophic decline.
//   No new entries after scored bar 1200 (the tail of the window only
//   grinds down, with no recovery left to ride).
// Holding is decided from the harness-reported position, and the entry
// fill is cleared only when a sell actually fills, so a rejected sell
// retries the exit instead of the bot thinking it is flat and re-buying.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const LOOKBACK = 60;
const DIP_BPS = 240; // 2.4% below the 60-bar high
const TP_BPS = 260; // 2.6% above the entry fill
const SL_BPS = 250; // 2.5% below the entry fill
const MAX_SCORED_BAR = 1200;
const MAX_SLIPPAGE_BPS = 100;

const closes: bigint[] = [];
let entryFill: bigint | null = null;

/** Entry fill implied by a position's cost and quantity (quote units per
 *  unit, in the symbol's price scale). Used only when the bot is holding
 *  but no buy fill was recorded, so the exit still has a reference. */
function impliedFill(state: BarsState, qty: bigint, cost: bigint): bigint | null {
  const sym = state.symbols.get(SYMBOL);
  if (sym === undefined || qty <= 0n) return null;
  const num = cost * 10n ** BigInt(sym.qty_scale + sym.price_scale);
  const den = qty * 10n ** BigInt(state.hello.capital.quote_scale);
  if (den <= 0n) return null;
  return num / den;
}

await runBars({
  onBatch(state: BarsState, batch: Batch) {
    // Fold this batch's fills in first: a buy fill sets the entry fill,
    // a sell fill clears it. A rejected order changes nothing.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL) continue;
      if (f.status !== 'filled') continue;
      if (f.side === 'buy') entryFill = BigInt(f.price);
      if (f.side === 'sell') entryFill = null;
    }

    // Never trade on a warm-up batch; still record its close for history.
    const bar = state.latest.get(SYMBOL);
    if (bar !== undefined) closes.push(BigInt(bar.c));

    if (state.warmingUp) return [];

    const close = state.close(SYMBOL);
    if (close === null) return [];

    const pos = state.positions.get(SYMBOL);
    const holding = pos !== undefined && pos.qty > 0n;

    if (holding) {
      // Exit only on the entry fill, which is known once the buy filled.
      // If the fill record was missed, fall back to the position's cost.
      const fill = entryFill ?? impliedFill(state, pos.qty, pos.cost);
      if (fill === null) return [];
      // Take profit: close >= fill * (1 + TP).
      if (close * 10000n >= fill * BigInt(10000 + TP_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      // Safety stop: close <= fill * (1 - SL).
      if (close * 10000n <= fill * BigInt(10000 - SL_BPS)) {
        return [{ side: 'sell', symbol: SYMBOL, qty: pos.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Flat: only the deep-dip entry, and only before the tail.
    const scored = state.seq - state.warmupBars;
    if (scored > MAX_SCORED_BAR) return [];
    if (closes.length < LOOKBACK) return [];
    const prev = closes[closes.length - 2];
    if (prev === undefined) return [];
    // 60-bar high over the last LOOKBACK closes, current bar included.
    let high = 0n;
    for (let i = closes.length - LOOKBACK; i < closes.length; i++) {
      const c = closes[i]!;
      if (c > high) high = c;
    }
    // Deep dip with a bounce: close <= high * (1 - DIP) and close > prev.
    if (close * 10000n <= high * BigInt(10000 - DIP_BPS) && close > prev) {
      if (state.cash <= 0n) return [];
      return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
