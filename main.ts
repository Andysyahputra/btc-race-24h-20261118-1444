// Bounce Rebound v3 — a mean-reversion cbBTC bot for the make.fun BTC Race.
// Two entry modes share one full-size long-only position:
//   Mode 1 (SMA-dip): buy when the close is >=0.7% below its 50-bar SMA and
//     bouncing; exit at +1.5% take-profit or -0.6% stop-loss from the entry
//     FILL price, with a 30-bar re-entry cooldown after a stop-loss and a
//     -$15 cumulative loss budget that disables the mode for the window.
//   Mode 2 (deep-dip): buy a >=3.0% dip below the 100-bar high while
//     RSI(14) < 30 and bouncing; exit at +5.0% take-profit or -1.5%
//     stop-loss from the entry fill price. Overrides cooldown and budget.
//   Switch: if the deep signal fires while an SMA position is open, sell the
//     SMA position and buy the deep dip on the next bar once the sell fills.
// Deterministic: every decision comes only from the bars received.
// Prices: closes are integer raw units at price_scale 1e5; math in dollars.

import { runBars } from './vendor/makefun-bars.ts';
import type { BarsState, Batch, OrderInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const PRICE_SCALE = 1e5;
const MAX_SLIPPAGE_BPS = 100;

// SMA-dip mode
const SMA_LEN = 50;
const SMA_DIP = 0.007; // buy >= 0.7% below the 50-bar SMA
const SMA_TP = 0.015; // take profit +1.5% from entry fill
const SMA_SL = 0.006; // stop loss -0.6% from entry fill
const SMA_COOLDOWN_BARS = 31; // barIndex + 31 after a stop-loss exit
const SMA_LOSS_BUDGET_MICRO = -15_000_000n; // -$15 cumulative SMA PnL

// Deep-dip mode
const HIGH_LEN = 100;
const DEEP_DIP = 0.03; // buy >= 3.0% below the 100-bar high
const RSI_LEN = 14;
const RSI_MAX = 30;
const DEEP_TP = 0.05; // take profit +5.0% from entry fill
const DEEP_SL = 0.015; // stop loss -1.5% from entry fill

type Mode = 'sma' | 'deep' | null;

interface BotState {
  closes: number[]; // close prices in dollars, warm-up bars included
  mode: Mode; // mode of the open (or pending) position, null when flat
  entryFill: number | null; // entry FILL price in dollars, null until it fills
  cashBeforeBuy: bigint | null; // harness cash (micro-USDC) when the buy was sent
  smaPnl: bigint; // cumulative PnL of completed SMA trades, micro-USDC
  coolUntil: number; // SMA entry blocked while barIndex <= coolUntil
  rebuyDeep: boolean; // a switch sell was sent; buy deep once it fills
  switchFilled: boolean; // the switch sell filled in this batch
  buyPending: boolean; // a buy was sent, its fill not yet seen
  exitPending: boolean; // a sell was sent, its fill not yet seen
}

const s: BotState = {
  closes: [],
  mode: null,
  entryFill: null,
  cashBeforeBuy: null,
  smaPnl: 0n,
  coolUntil: -1,
  rebuyDeep: false,
  switchFilled: false,
  buyPending: false,
  exitPending: false,
};

function sma(values: number[], len: number): number {
  let sum = 0;
  for (let i = values.length - len; i < values.length; i++) sum += values[i];
  return sum / len;
}

function rollingHigh(values: number[], len: number): number {
  let hi = -Infinity;
  for (let i = values.length - len; i < values.length; i++) {
    if (values[i] > hi) hi = values[i];
  }
  return hi;
}

// RSI(14) over the last 14 close-to-close changes, simple averages
// (NOT Wilder smoothing). 100 when the average loss is 0.
function rsi14(values: number[]): number {
  let gain = 0;
  let loss = 0;
  for (let i = values.length - RSI_LEN; i < values.length; i++) {
    const ch = values[i] - values[i - 1];
    if (ch > 0) gain += ch;
    else loss -= ch;
  }
  const avgGain = gain / RSI_LEN;
  const avgLoss = loss / RSI_LEN;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// The deep-dip entry signal: >=3% below the 100-bar high, RSI(14) < 30,
// and the latest close bouncing above the previous close.
function deepSignal(values: number[]): boolean {
  if (values.length < HIGH_LEN + 2) return false;
  const close = values[values.length - 1];
  const prev = values[values.length - 2];
  if (close <= prev) return false;
  if (close > rollingHigh(values, HIGH_LEN) * (1 - DEEP_DIP)) return false;
  if (rsi14(values) >= RSI_MAX) return false;
  return true;
}

// The SMA-dip entry signal: >=0.7% below the 50-bar SMA and bouncing.
function smaSignal(values: number[]): boolean {
  if (values.length < SMA_LEN) return false;
  const close = values[values.length - 1];
  const prev = values[values.length - 2];
  if (close <= prev) return false;
  if (close > sma(values, SMA_LEN) * (1 - SMA_DIP)) return false;
  return true;
}

function buyAll(state: BarsState, mode: Exclude<Mode, null>): OrderInput[] {
  if (state.cash <= 0n) return [];
  s.mode = mode;
  s.cashBeforeBuy = state.cash;
  s.buyPending = true;
  return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: state.cash, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function sellAll(state: BarsState): OrderInput[] {
  const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
  if (qty <= 0n) return [];
  s.exitPending = true;
  return [{ side: 'sell', symbol: SYMBOL, qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
}

function onBatch(state: BarsState, batch: Batch): OrderInput[] {
  s.switchFilled = false;

  // --- Fold in this batch's fills first (they priced at this bar's open). ---
  for (const fill of batch.fills) {
    if (fill.symbol !== SYMBOL) continue;
    if (fill.side === 'buy') {
      if (fill.status === 'filled') {
        s.entryFill = Number(fill.price) / PRICE_SCALE;
        s.buyPending = false;
      } else {
        // Buy rejected: no position, drop the pending mode.
        s.mode = null;
        s.cashBeforeBuy = null;
        s.entryFill = null;
        s.buyPending = false;
      }
    } else if (fill.side === 'sell') {
      if (fill.status === 'filled') {
        if (s.mode === 'sma' && s.cashBeforeBuy !== null) {
          s.smaPnl += state.cash - s.cashBeforeBuy;
        }
        if (s.rebuyDeep) s.switchFilled = true;
        s.mode = null;
        s.cashBeforeBuy = null;
        s.entryFill = null;
        s.exitPending = false;
      } else {
        // Sell rejected: the position is still open, retry next bar.
        s.exitPending = false;
        if (s.rebuyDeep) s.rebuyDeep = false;
      }
    }
  }

  // --- Record this bar's close (warm-up bars included in history). ---
  const bar = batch.bars.find((b) => b.symbol === SYMBOL);
  if (bar === undefined || bar.c === undefined) return [];
  const close = Number(bar.c) / PRICE_SCALE;
  if (!Number.isFinite(close)) return [];
  s.closes.push(close);
  const barIndex = s.closes.length - 1;

  // Warm-up batches build history only; every order on one is rejected.
  if (state.warmingUp) return [];
  // A buy or sell decided last bar has not filled yet: wait for its fill.
  if (s.buyPending || s.exitPending) return [];

  const positionQty = state.positions.get(SYMBOL)?.qty ?? 0n;
  const deep = deepSignal(s.closes);

  // --- A position is open: manage the exit (fill price anchors TP/SL). ---
  if (s.mode !== null && s.entryFill !== null && positionQty > 0n) {
    if (s.mode === 'sma') {
      if (close >= s.entryFill * (1 + SMA_TP)) return sellAll(state);
      if (close <= s.entryFill * (1 - SMA_SL)) {
        s.coolUntil = barIndex + SMA_COOLDOWN_BARS;
        return sellAll(state);
      }
      // Switch: the deep dip arrived while holding an SMA position.
      if (deep) {
        s.rebuyDeep = true;
        return sellAll(state);
      }
      return [];
    }
    // Deep mode.
    if (close >= s.entryFill * (1 + DEEP_TP)) return sellAll(state);
    if (close <= s.entryFill * (1 - DEEP_SL)) return sellAll(state);
    return [];
  }
  if (s.mode !== null && s.entryFill === null) return []; // buy in flight
  if (s.mode !== null && positionQty <= 0n) {
    // Defensive: mode set but nothing held; drop the stale mode.
    s.mode = null;
    s.cashBeforeBuy = null;
    s.entryFill = null;
  }

  // --- Flat: entries, in priority order. ---
  // 1. The switch sell filled: buy the deep dip now.
  if (s.rebuyDeep && s.switchFilled) {
    s.rebuyDeep = false;
    return buyAll(state, 'deep');
  }
  // 2. Deep-dip signal (overrides cooldown and loss budget).
  if (deep) return buyAll(state, 'deep');
  // 3. Post-stop-loss cooldown.
  if (barIndex <= s.coolUntil) return [];
  // 4. SMA loss budget spent.
  if (s.smaPnl <= SMA_LOSS_BUDGET_MICRO) return [];
  // 5. SMA-dip entry.
  if (smaSignal(s.closes)) return buyAll(state, 'sma');
  return [];
}

await runBars({ onBatch });
