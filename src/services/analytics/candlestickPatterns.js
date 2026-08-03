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
  // Real user report: "нижняя тень 76%, тело 18% — если сложить проценты, 100% не
  // получается, непонятно где эта свеча". Both gaps had the same root cause — only two
  // of the three parts (the wick that matters + the body) were ever shown, and no date —
  // so a reader couldn't locate the exact candle or see where the missing % went. Now
  // states all three parts (both wicks + body, always summing to 100%) plus the date.
  const dateLabel = candle.date instanceof Date
    ? candle.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : null;
  const pct = (v) => Math.round((v / range) * 100);

  if (lowerWick >= 2 * body && lowerWick / range >= 0.6) {
    return {
      pattern: 'pin_bar_bullish',
      confidence: Math.round(Math.min(90, 40 + (lowerWick / range) * 60)),
      detail: `Пин-бар (бычий)${dateLabel ? ` — свеча ${dateLabel}` : ''}: нижняя тень ${pct(lowerWick)}%, `
        + `тело ${pct(body)}%, верхняя тень ${pct(upperWick)}% (в сумме 100% диапазона свечи) — отказ от более низких цен.`,
    };
  }
  if (upperWick >= 2 * body && upperWick / range >= 0.6) {
    return {
      pattern: 'pin_bar_bearish',
      confidence: Math.round(Math.min(90, 40 + (upperWick / range) * 60)),
      detail: `Пин-бар (медвежий)${dateLabel ? ` — свеча ${dateLabel}` : ''}: верхняя тень ${pct(upperWick)}%, `
        + `тело ${pct(body)}%, нижняя тень ${pct(lowerWick)}% (в сумме 100% диапазона свечи) — отказ от более высоких цен.`,
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
  const fmt = (c) => c.date instanceof Date ? c.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' }) : null;
  const prevDate = fmt(prevCandle), curDate = fmt(candle);
  return {
    pattern: bullish ? 'engulfing_bullish' : 'engulfing_bearish',
    confidence: Math.round(Math.min(90, 40 + Math.min(sizeRatio, 3) * 15)),
    // Two dates spelled out — real user confusion: "тут эта фигура состоит из трёх
    // свечей, а мы видели только ту, на которой вошли, и предыдущую" — knowing exactly
    // which two calendar days are meant removes the guessing.
    detail: `Поглощение (${bullish ? 'бычье' : 'медвежье'})${prevDate && curDate ? ` — свечи ${prevDate} → ${curDate}` : ''}: `
      + `${prevBullish ? 'бычью' : 'медвежью'} свечу ${prevDate || 'до'} перекрывает ${bullish ? 'бычья' : 'медвежья'} свеча ${curDate || 'после'}, `
      + `тело в ${sizeRatio.toFixed(1)}× больше и полностью её перекрывает.`,
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
