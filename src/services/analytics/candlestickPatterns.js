// src/services/analytics/candlestickPatterns.js
//
// Single/two-candle patterns — a different category from patterns.js's multi-swing
// figures. These are honest even on low timeframes (M1/M5) because they don't depend on
// swing-point confirmation lag, just the shape of one or two bars that already closed.

// Pin bar: small body, one wick at least 2x the body and at least 60% of the full range.
// Bullish (long lower wick, price rejected lower prices) or bearish (long upper wick).
export function detectPinBar(candle) {
  const range = candle.high - candle.low;
  if (range <= 0) return null;
  const body = Math.abs(candle.close - candle.open);
  const bodyRatio = body / range;
  if (bodyRatio > 0.35) return null;

  const upperWick = candle.high - Math.max(candle.open, candle.close);
  const lowerWick = Math.min(candle.open, candle.close) - candle.low;

  if (lowerWick >= 2 * body && lowerWick / range >= 0.6) {
    return {
      pattern: 'pin_bar_bullish',
      confidence: Math.round(Math.min(90, 40 + (lowerWick / range) * 60)),
      detail: `Пин-бар (бычий): нижняя тень ${Math.round((lowerWick / range) * 100)}% свечи, `
        + `тело всего ${Math.round(bodyRatio * 100)}% — отказ от более низких цен.`,
    };
  }
  if (upperWick >= 2 * body && upperWick / range >= 0.6) {
    return {
      pattern: 'pin_bar_bearish',
      confidence: Math.round(Math.min(90, 40 + (upperWick / range) * 60)),
      detail: `Пин-бар (медвежий): верхняя тень ${Math.round((upperWick / range) * 100)}% свечи, `
        + `тело всего ${Math.round(bodyRatio * 100)}% — отказ от более высоких цен.`,
    };
  }
  return null;
}

// Engulfing: current candle's body fully covers the previous candle's body, opposite color.
export function detectEngulfing(prevCandle, candle) {
  const prevBody = Math.abs(prevCandle.close - prevCandle.open);
  const body = Math.abs(candle.close - candle.open);
  if (prevBody === 0 || body === 0) return null;

  const prevBullish = prevCandle.close > prevCandle.open;
  const bullish = candle.close > candle.open;
  if (prevBullish === bullish) return null;

  const engulfs = Math.max(candle.open, candle.close) >= Math.max(prevCandle.open, prevCandle.close)
    && Math.min(candle.open, candle.close) <= Math.min(prevCandle.open, prevCandle.close);
  if (!engulfs) return null;

  const sizeRatio = body / prevBody;
  return {
    pattern: bullish ? 'engulfing_bullish' : 'engulfing_bearish',
    confidence: Math.round(Math.min(90, 40 + Math.min(sizeRatio, 3) * 15)),
    detail: `Поглощение (${bullish ? 'бычье' : 'медвежье'}): тело текущей свечи в ${sizeRatio.toFixed(1)}× `
      + `больше предыдущей и полностью её перекрывает.`,
  };
}

export function detectCandlestickPatterns(candles, index) {
  const out = [];
  const pin = detectPinBar(candles[index]);
  if (pin) out.push(pin);
  if (index > 0) {
    const eng = detectEngulfing(candles[index - 1], candles[index]);
    if (eng) out.push(eng);
  }
  return out;
}
