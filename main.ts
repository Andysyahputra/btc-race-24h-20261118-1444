// Bounce Rebound v3 — a two-mode mean-reversion bot for the BTC 24h race.
//
// Mode 1 (SMA-dip): buy a dip at least 0.7% below the 50-bar SMA once it
//   bounces, take profit at +1.5% or stop out at -0.6% from the entry fill,
//   with a 30-bar cooldown after a stop-loss and a -$15 cumulative loss
//   budget that disables this mode for the rest of the window.
// Mode 2 (deep-dip): buy a dip at least 3.0% below the 100-bar high with
//   RSI(14) < 30 once it bounces, take profit at +5.0% or stop out at -1.5%.
// A deep-dip signal while an SMA position is open switches into the deep
// trade: sell the SMA position, then buy the deep dip on the next bar if
// the switch sell fills.
// One full-size position at most. Deterministic: no clock, no randomness,
// every decision comes only from the bars received.

import { runBars } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
const MAX_SLIPPAGE_BPS = 100;

// SMA-dip parameters.
const SMA_PERIOD = 50;
const SMA_DIP = 0.007; // buy at least 0.7% below the 50-bar SMA
const SMA_TP = 0.015; // take profit +1.5% above the entry fill
const SMA_SL = 0.006; // stop loss -0.6% below the entry fill
const SMA_COOLDOWN = 31; // coolUntil = barIndex + 31 on a stop-loss exit
const SMA_LOSS_BUDGET_Q = -15_000_000n; // -$15 in micro-USDC

// Deep-dip parameters.
const DEEP_LOOKBACK = 100;
const DEEP_DIP = 0.03; // at least 3.0% below the 100-bar rolling high
const RSI_PERIOD = 14;
const RSI_MAX = 30;
const DEEP_TP = 0.05; // take profit +5.0% above the entry fill
const DEEP_SL = 0.015; // stop loss -1.5% below the entry fill
const MIN_CLOSES_DEEP = 102;

// ---------------------------------------------------------------- state

const closes: number[] = [];
let priceDiv = 100000; // 10 ** price_scale, set from hello
let mode: 'sma' | 'deep' | null = null;
let entryFill: number | null = null;
let cashBeforeBuy: bigint | null = null;
let smaPnlQ = 0n;
let coolUntil = -1;
let rebuyDeep = false;
let pendingBuyId: string | null = null;
let pendingSellId: string | null = null;
let switchSellId: string | null = null;
let orderNo = 0;

function nextId(prefix: string): string {
  orderNo += 1;
  return `${prefix}${orderNo}`;
}

// Simple moving average of the last n closes.
function smaLast(n: number): number {
  let s = 0;
  for (let i = closes.length - n; i < closes.length; i++) s += closes[i];
  return s / n;
}

// Highest close of the last n closes.
function highLast(n: number): number {
  let h = -Infinity;
  for (let i = closes.length - n; i < closes.length; i++) {
    if (closes[i] > h) h = closes[i];
  }
  return h;
}

// Simple-average RSI over the last n close-to-close changes.
// RSI = 100 - 100 / (1 + avgGain / avgLoss); 100 when average loss is 0.
function rsiLast(n: number): number {
  let gain = 0;
  let loss = 0;
  for (let i = closes.length - n; i < closes.length; i++) {
    const d = closes[i] - closes[i - 1];
    if (d > 0) gain += d;
    else loss += -d;
  }
  const avgGain = gain / n;
  const avgLoss = loss / n;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

// Deep-dip entry signal: at least 102 closes, close >= 3% below the
// 100-bar high, RSI(14) < 30, and the latest close is bouncing.
function deepSignal(close: number, bouncing: boolean): boolean {
  if (closes.length < MIN_CLOSES_DEEP) return false;
  if (!bouncing) return false;
  if (close > highLast(DEEP_LOOKBACK) * (1 - DEEP_DIP)) return false;
  if (rsiLast(RSI_PERIOD) >= RSI_MAX) return false;
  return true;
}

// SMA-dip entry signal: at least 50 closes, close >= 0.7% below the
// 50-bar SMA, and the latest close is bouncing.
function smaSignal(close: number, bouncing: boolean): boolean {
  if (closes.length < SMA_PERIOD) return false;
  if (!bouncing) return false;
  if (close > smaLast(SMA_PERIOD) * (1 - SMA_DIP)) return false;
  return true;
}

// ---------------------------------------------------------------- bot

await runBars({
  onHello(state) {
    const s = state.symbols.get(SYMBOL);
    if (s !== undefined) priceDiv = 10 ** s.price_scale;
  },

  onBatch(state, batch) {
    const bar = batch.bars.find((b) => b.symbol === SYMBOL);

    // 1. Settle the previous batch's orders from this batch's fills.
    for (const f of batch.fills) {
      if (f.symbol !== SYMBOL) continue;
      if (f.client_id === pendingBuyId) {
        if (f.status === 'filled') {
          entryFill = Number(f.price) / priceDiv;
        } else {
          // Buy rejected: the position never opened.
          mode = null;
          entryFill = null;
          cashBeforeBuy = null;
        }
        pendingBuyId = null;
      } else if (f.client_id === pendingSellId) {
        if (f.status === 'filled') {
          if (cashBeforeBuy !== null) {
            const pnl = state.cash - cashBeforeBuy;
            if (mode === 'sma') smaPnlQ += pnl;
          }
          mode = null;
          entryFill = null;
          cashBeforeBuy = null;
        } else {
          // Sell rejected: the position is still open.
          if (f.client_id === switchSellId) rebuyDeep = false;
        }
        if (f.client_id === switchSellId) switchSellId = null;
        pendingSellId = null;
      }
    }

    // 2. No bar (or no close) this minute: skip trading, never crash.
    if (bar === undefined || bar.c === null || bar.c === undefined) return [];
    const close = Number(bar.c) / priceDiv;
    if (!Number.isFinite(close) || close <= 0) return [];

    // 3. Record the close (warm-up bars count as history too).
    //    Never trade on warm-up batches.
    closes.push(close);
    const barIndex = closes.length - 1;
    if (state.warmingUp) return [];
    const bouncing = closes.length >= 2 && close > closes[closes.length - 2];

    const buy = (m: 'sma' | 'deep') => {
      const id = nextId('b');
      pendingBuyId = id;
      mode = m;
      cashBeforeBuy = state.cash;
      return {
        side: 'buy' as const,
        symbol: SYMBOL,
        notional_quote_units: state.cash,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        client_id: id,
      };
    };
    const sellAll = () => {
      const qty = state.positions.get(SYMBOL)?.qty ?? 0n;
      if (qty <= 0n) return null;
      const id = nextId('s');
      pendingSellId = id;
      return {
        side: 'sell' as const,
        symbol: SYMBOL,
        qty,
        max_slippage_bps: MAX_SLIPPAGE_BPS,
        client_id: id,
      };
    };

    // 4. A position is open. First drop a stale mode: if the entry fill
    //    is known but the harness reports no position (flattened outside
    //    this bot's sell flow), do not trade on a ghost position — clear
    //    the mode and fall through to the flat entry logic below.
    if (mode !== null && entryFill !== null) {
      const heldQty = state.positions.get(SYMBOL)?.qty ?? 0n;
      if (heldQty <= 0n) {
        mode = null;
        entryFill = null;
        cashBeforeBuy = null;
      }
    }
    if (mode !== null) {
      if (entryFill === null) return []; // buy sent, fill not reported yet
      if (mode === 'sma' && deepSignal(close, bouncing)) {
        // Deep dip while holding an SMA trade: switch into it.
        const order = sellAll();
        if (order === null) return [];
        switchSellId = order.client_id;
        rebuyDeep = true;
        return [order];
      }
      if (mode === 'sma') {
        if (close >= entryFill * (1 + SMA_TP)) {
          const order = sellAll();
          return order === null ? [] : [order];
        }
        if (close <= entryFill * (1 - SMA_SL)) {
          coolUntil = barIndex + SMA_COOLDOWN;
          const order = sellAll();
          return order === null ? [] : [order];
        }
        return [];
      }
      // Deep mode.
      if (close >= entryFill * (1 + DEEP_TP)) {
        const order = sellAll();
        return order === null ? [] : [order];
      }
      if (close <= entryFill * (1 - DEEP_SL)) {
        const order = sellAll();
        return order === null ? [] : [order];
      }
      return [];
    }

    // 5. Flat. Priority order:
    //    (1) switch rebuy, (2) deep-dip, (3) cooldown, (4) loss budget,
    //    (5) SMA-dip.
    if (rebuyDeep) {
      // The switch sell filled: that is the only way to be flat with
      // rebuyDeep set (a rejected switch sell clears it and keeps the
      // SMA position open).
      rebuyDeep = false;
      return [buy('deep')];
    }
    if (deepSignal(close, bouncing)) return [buy('deep')];
    if (barIndex <= coolUntil) return [];
    if (smaPnlQ <= SMA_LOSS_BUDGET_Q) return [];
    if (smaSignal(close, bouncing)) return [buy('sma')];
    return [];
  },
});
