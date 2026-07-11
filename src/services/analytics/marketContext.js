// src/services/analytics/marketContext.js
//
// Module 7.3 of traderpro-architecture-v3.md — automatic market-regime tagging.
// No manual input from the trader except one checkbox that genuinely can't be inferred
// from price ("важные новости" — the market itself doesn't announce a central bank
// meeting). Trend and volatility are both computed from the same candle series
// indicators.js already fetches, no new data source.
//
// Both trend and volatility are reported as a continuous 0-100 "gauge" position, not
// just a bucket label — a bucket alone ("high volatility") hides *how* high, which is
// exactly the nuance the trader asked for (a gauge/speedometer, not a flag).
import { sma, indexAtOrBefore } from './indicators';

// --- Trend: slope of a moving average over a lookback window ------------------------

const TREND_MA_PERIOD = 50;
const TREND_LOOKBACK = 20;
const TREND_FLAT_THRESHOLD_PCT = 2; // slope within ±2% counts as sideways, not a trend

function classifyTrendAt(closes, index) {
  const maSeries = sma(closes, TREND_MA_PERIOD);
  const pastIndex = index - TREND_LOOKBACK;
  if (pastIndex < 0 || maSeries[index] == null || maSeries[pastIndex] == null) return null;

  const now = maSeries[index];
  const past = maSeries[pastIndex];
  const slopePct = ((now - past) / past) * 100;
  const label = slopePct > TREND_FLAT_THRESHOLD_PCT ? 'up' : slopePct < -TREND_FLAT_THRESHOLD_PCT ? 'down' : 'sideways';

  // Gauge position: clamp slope to a ±10% range and map to 0-100 (0 = strong downtrend,
  // 50 = flat, 100 = strong uptrend). The clamp range is a judgment call, not a law of
  // physics — wide enough that a typical 50-day MA move fills the gauge without pinning
  // at the ends on every ordinary trend.
  const clamped = Math.max(-10, Math.min(10, slopePct));
  const gaugePercent = ((clamped + 10) / 20) * 100;

  return { slopePct, label, gaugePercent };
}

// --- Volatility: current ATR vs its own historical average --------------------------

const ATR_PERIOD = 14;
const ATR_AVG_PERIOD = 100;
const VOL_HIGH_RATIO = 1.3;
const VOL_LOW_RATIO = 0.7;

// True Range per bar, then a simple rolling average — same simple-SMA style already
// used for Bollinger Bands in indicators.js, not Wilder smoothing, for consistency.
function atrSeries(candles, period = ATR_PERIOD) {
  const trueRanges = candles.map((c, i) => {
    if (i === 0) return c.high - c.low;
    const prevClose = candles[i - 1].close;
    return Math.max(c.high - c.low, Math.abs(c.high - prevClose), Math.abs(c.low - prevClose));
  });
  return sma(trueRanges, period);
}

function classifyVolatilityAt(candles, index) {
  const atr = atrSeries(candles);
  if (atr[index] == null) return null;

  const windowStart = Math.max(0, index - ATR_AVG_PERIOD);
  const window = atr.slice(windowStart, index).filter((v) => v != null);
  if (window.length < 20) return null; // too little history for a meaningful "average" ATR

  const avgAtr = window.reduce((s, v) => s + v, 0) / window.length;
  if (!avgAtr) return null;

  const ratio = atr[index] / avgAtr;
  const label = ratio > VOL_HIGH_RATIO ? 'high' : ratio < VOL_LOW_RATIO ? 'low' : 'normal';

  // Gauge position: clamp ratio to [0.3, 1.7] centered on 1.0 (= 50%) — "normal"
  // volatility sits in the middle, not at an arbitrary end of the scale.
  const clamped = Math.max(0.3, Math.min(1.7, ratio));
  const gaugePercent = ((clamped - 0.3) / (1.7 - 0.3)) * 100;

  return { ratio, label, gaugePercent, currentAtr: atr[index], avgAtr };
}

// --- Entry point: same "as of this bar, no lookahead" contract as the rest of module 4 ---

export function computeMarketContextAtEntry(candles, atDate) {
  const index = indexAtOrBefore(candles, atDate);
  if (index === -1) return null;

  const closes = candles.map((c) => c.close);
  const visibleCandles = candles.slice(0, index + 1);

  return {
    date: candles[index].date,
    trend: classifyTrendAt(closes.slice(0, index + 1), index),
    volatility: classifyVolatilityAt(visibleCandles, index),
  };
}
