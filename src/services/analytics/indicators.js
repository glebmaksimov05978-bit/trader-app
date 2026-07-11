// src/services/analytics/indicators.js
//
// Module 4 (part 1) of traderpro-architecture-v3.md — "exact algorithms" tier: plain
// formulas over historical closes/volumes, no AI, no interpretation of good/bad (that's
// the conclusions engine's job, not this module's). Every function here is a textbook
// definition — nothing candidate-confidence about it.

export function sma(values, period) {
  const out = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i];
    if (i >= period) sum -= values[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

export function ema(values, period) {
  const out = new Array(values.length).fill(null);
  const k = 2 / (period + 1);
  let prev = null;
  const seedBuffer = [];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    const isValid = v != null && !Number.isNaN(v);
    if (prev == null) {
      // Seed with a plain average of the first `period` VALID values — skips any
      // leading null/NaN run (e.g. macd's signal line, which starts null until the
      // slow EMA warms up) instead of poisoning the seed with NaN.
      if (!isValid) continue;
      seedBuffer.push(v);
      if (seedBuffer.length < period) continue;
      prev = seedBuffer.reduce((s, x) => s + x, 0) / period;
    } else if (isValid) {
      prev = v * k + prev * (1 - k);
    } else {
      continue; // gap after warm-up — leave this bar null, don't poison future bars
    }
    out[i] = prev;
  }
  return out;
}

function rsi(closes, period = 14) {
  const out = new Array(closes.length).fill(null);
  let avgGain = 0, avgLoss = 0;
  for (let i = 1; i < closes.length; i++) {
    const change = closes[i] - closes[i - 1];
    const gain = Math.max(change, 0);
    const loss = Math.max(-change, 0);
    if (i <= period) {
      avgGain += gain / period;
      avgLoss += loss / period;
      if (i === period) out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    } else {
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      out[i] = avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss);
    }
  }
  return out;
}

function macd(closes, fast = 12, slow = 26, signalPeriod = 9) {
  const emaFast = ema(closes, fast);
  const emaSlow = ema(closes, slow);
  const macdLine = closes.map((_, i) => (emaFast[i] != null && emaSlow[i] != null) ? emaFast[i] - emaSlow[i] : null);
  const signalLine = ema(macdLine.map((v) => v ?? NaN), signalPeriod).map((v) => Number.isNaN(v) ? null : v);
  const histogram = macdLine.map((v, i) => (v != null && signalLine[i] != null) ? v - signalLine[i] : null);
  return { macdLine, signalLine, histogram };
}

// Bollinger Bands: SMA(period) ± k standard deviations, computed on the same rolling
// window as the SMA itself (not the whole series) — the textbook definition. `percentB`
// (0 = at the lower band, 1 = at the upper band, can go outside [0,1] on a breakout) is
// the standard normalized read of "where in the bands is price right now."
function bollingerAt(closes, index, period = 20, k = 2) {
  if (index < period - 1) return null;
  const window = closes.slice(index - period + 1, index + 1);
  const mid = window.reduce((s, v) => s + v, 0) / period;
  const variance = window.reduce((s, v) => s + (v - mid) ** 2, 0) / period;
  const stdDev = Math.sqrt(variance);
  const upper = mid + k * stdDev;
  const lower = mid - k * stdDev;
  const close = closes[index];
  const percentB = upper !== lower ? (close - lower) / (upper - lower) : 0.5;
  const position = close > upper ? 'above_upper' : close < lower ? 'below_lower' : 'inside';
  return { upper, mid, lower, percentB, position };
}

function volumeRatioAt(volumes, index, period = 20) {
  if (index < period) return null;
  const window = volumes.slice(index - period, index);
  const avgVol = window.reduce((s, v) => s + v, 0) / period;
  return avgVol > 0 ? volumes[index] / avgVol : null;
}

// Finds the last candle at or before `atDate` — shared by indicators and pattern
// detection so both anchor to the exact same bar (and neither peeks at candles that
// didn't exist yet when the trade was opened — that would be hindsight, not analysis).
export function indexAtOrBefore(candles, atDate) {
  if (!candles?.length) return -1;
  const target = new Date(atDate).getTime();
  let index = -1;
  for (let i = 0; i < candles.length; i++) {
    if (candles[i].date.getTime() <= target) index = i;
    else break;
  }
  return index;
}

// Reports every indicator as of the bar at/before `atDate`. Indicators that don't have
// enough history yet (e.g. SMA200 on a freshly-listed ticker) come back null rather than
// a misleading partial number — the caller must show "нет данных", never guess.
export function computeIndicatorsAtEntry(candles, atDate) {
  const index = indexAtOrBefore(candles, atDate);
  if (index === -1) return null;

  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume);

  const sma200 = sma(closes, 200);
  const rsi14 = rsi(closes, 14);
  const { histogram } = macd(closes);

  const closeAtIndex = closes[index];
  const sma200AtIndex = sma200[index];

  return {
    date: candles[index].date,
    close: closeAtIndex,
    barsAvailable: index + 1,
    rsi14: rsi14[index] ?? null,
    macdHistogram: histogram[index] ?? null,
    sma200Distance: sma200AtIndex != null ? ((closeAtIndex - sma200AtIndex) / sma200AtIndex) * 100 : null,
    volumeRatio: volumeRatioAt(volumes, index),
    bollinger: bollingerAt(closes, index),
  };
}
