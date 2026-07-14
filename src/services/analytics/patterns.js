// src/services/analytics/patterns.js
//
// Module 4 (part 2) of traderpro-architecture-v3.md — "candidate algorithms" tier:
// formalizable chart figures on local price extremes. Each detector returns
// {pattern, confidence} — a percentage match against explicit geometric rules, never an
// AI opinion. Everything here operates ONLY on candles up to and including the entry
// bar — using later candles would be hindsight, not analysis of what was visible when
// the trade was opened.
//
// Honesty note (important for the "never confidently lie" principle this whole app is
// built on): classic technical-analysis figures — especially Elliott wave counting —
// are subjective even among professional analysts. The 5-wave detector below checks a
// few of the textbook structural rules (alternation, wave 3 not the shortest, wave 4
// not overlapping wave 1) but is NOT full Elliott theory (no Fibonacci ratio checks, no
// alternation-of-corrections rule, no larger-degree wave context). Its confidence is
// capped well below 100% for exactly this reason, and it always reports its own
// checklist so the trader can see which rules passed and correct the read themselves.
import { ema } from './indicators';
import { detectCandlestickPatterns } from './candlestickPatterns';

const EMA_PERIODS = [9, 100, 200];

// Below this confidence, a pattern is more coincidence than shape — the geometric rules
// technically matched (that's why `status` still says "confirmed": the swings genuinely
// exist), but showing every 30%-match double top buries the handful that are actually
// worth looking at. Filtered out of the default candidate list, not deleted from the
// underlying detection — a future "show everything" toggle can still surface them.
export const MIN_DISPLAY_CONFIDENCE = 50;

// Swing-based figures (double top/bottom, H&S, flags, triangles, wedges) need enough
// bars for a swing point to mean anything — below M15 the zig-zag is mostly spread/bot
// noise, not structure a human trader would recognize. This constant exists now so the
// future intraday live panel (Calculator) can gate swing detection without duplicating
// the threshold; it's a no-op today since candles.js only fetches daily bars.
export const MIN_SWING_TIMEFRAME_MINUTES = 15;
export function swingPatternsAllowedForTimeframe(timeframeMinutes) {
  return timeframeMinutes == null || timeframeMinutes >= MIN_SWING_TIMEFRAME_MINUTES;
}

// --- Swing points (local extremes) — the geometric skeleton everything else reads ----

// A bar is a swing high if its high is the max within `lookback` bars on both sides,
// swing low symmetrically for lows. Consecutive same-type swings collapse to the most
// extreme one, so the result always alternates high/low/high/low — a clean zig-zag.
export function findSwingPoints(candles, lookback = 3) {
  const raw = [];
  for (let i = lookback; i < candles.length - lookback; i++) {
    const windowSlice = candles.slice(i - lookback, i + lookback + 1);
    const isHigh = candles[i].high === Math.max(...windowSlice.map((c) => c.high));
    const isLow = candles[i].low === Math.min(...windowSlice.map((c) => c.low));
    // A bar can't be flagged as both without a degenerate (near-flat) window; high wins.
    if (isHigh) raw.push({ index: i, date: candles[i].date, price: candles[i].high, type: 'high' });
    else if (isLow) raw.push({ index: i, date: candles[i].date, price: candles[i].low, type: 'low' });
  }
  const out = [];
  for (const p of raw) {
    const last = out[out.length - 1];
    if (!last) { out.push(p); continue; }
    if (last.type === p.type) {
      if ((p.type === 'high' && p.price > last.price) || (p.type === 'low' && p.price < last.price)) {
        out[out.length - 1] = p;
      }
    } else {
      out.push(p);
    }
  }
  return out;
}

// --- Levels: EMA9/100/200 as moving support/resistance + static swing-based levels ---

export function computeEmaLevelsAtIndex(candles, index) {
  const closes = candles.map((c) => c.close);
  const result = {};
  for (const period of EMA_PERIODS) {
    const series = ema(closes, period);
    const value = series[index];
    if (value == null) { result[`ema${period}`] = null; continue; }
    const trendRef = series[Math.max(0, index - 10)];
    result[`ema${period}`] = {
      value,
      distancePct: ((closes[index] - value) / value) * 100,
      position: closes[index] >= value ? 'above' : 'below',
      slope: trendRef != null ? (value > trendRef ? 'rising' : value < trendRef ? 'falling' : 'flat') : null,
    };
  }
  return result;
}

// Static support/resistance from clustered swing points — a "level" is any price where
// at least 2 different swings landed within `toleranceRatio` of each other; the more
// touches, the more traders plausibly have orders sitting there.
export function findSupportResistance(swings, currentPrice, toleranceRatio = 0.006) {
  const sorted = [...swings].sort((a, b) => a.price - b.price);
  const clusters = [];
  for (const s of sorted) {
    const cluster = clusters.find((c) => Math.abs(c.price - s.price) / c.price <= toleranceRatio);
    if (cluster) {
      cluster.touches.push(s);
      cluster.price = cluster.touches.reduce((sum, t) => sum + t.price, 0) / cluster.touches.length;
    } else {
      clusters.push({ price: s.price, touches: [s] });
    }
  }
  return clusters
    .filter((c) => c.touches.length >= 2)
    .map((c) => ({
      price: c.price,
      touchCount: c.touches.length,
      type: c.price > currentPrice ? 'resistance' : 'support',
      lastTouchDate: c.touches[c.touches.length - 1].date,
    }))
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
}

// --- Fibonacci retracement levels, from the most recent confirmed swing leg ---------

const FIB_RATIOS = [0.236, 0.382, 0.5, 0.618, 0.786];

export function computeFibonacciLevels(swings) {
  if (swings.length < 2) return null;
  const [from, to] = swings.slice(-2);
  const high = Math.max(from.price, to.price);
  const low = Math.min(from.price, to.price);
  const range = high - low;
  if (range <= 0) return null;
  const direction = to.price > from.price ? 'up' : 'down';
  const levels = FIB_RATIOS.map((ratio) => ({
    ratio,
    // For an up-leg, retracement levels count down from the high; for a down-leg, up from the low.
    price: direction === 'up' ? high - range * ratio : low + range * ratio,
  }));
  return { from, to, direction, levels };
}

// --- Pattern candidates -------------------------------------------------------------

// Finds the extreme (high or low) in the tail of candles that `findSwingPoints` can't
// confirm yet — it needs `lookback` bars on both sides, so the most recent `lookback`
// bars never produce a confirmed swing no matter how extreme they are. This is exactly
// where a "forming" setup lives: a peak/trough that's real on the chart right now but
// hasn't had time to prove itself yet.
function tailExtreme(candles, lookback, type) {
  const tail = candles.slice(-lookback);
  if (!tail.length) return null;
  const tailStartIndex = candles.length - tail.length;
  let bestIdx = tailStartIndex;
  let bestVal = type === 'high' ? tail[0].high : tail[0].low;
  tail.forEach((c, i) => {
    const v = type === 'high' ? c.high : c.low;
    if ((type === 'high' && v > bestVal) || (type === 'low' && v < bestVal)) {
      bestVal = v;
      bestIdx = tailStartIndex + i;
    }
  });
  return { index: bestIdx, price: bestVal, barsAgo: candles.length - 1 - bestIdx };
}

// A live, still-developing double top/bottom: the tail (unconfirmed) extreme sits near
// the last CONFIRMED swing of the same type, and price has already pulled back a little
// from that tail extreme — i.e. it looks like a second peak/trough is forming, just
// hasn't had enough bars yet to count as a confirmed swing. `status: 'forming'` only
// becomes meaningful with live polling (Calculator's "🔴 Live" toggle) — on a frozen
// historical view (Journal) it's really just "what the chart looked like right then."
function detectFormingDoubleTopBottom(swings, visibleCandles, swingLookback, matchTolerancePct = 2) {
  if (!swings.length) return [];
  const lastSwing = swings[swings.length - 1];
  const tail = tailExtreme(visibleCandles, swingLookback, lastSwing.type);
  if (!tail || tail.index <= lastSwing.index) return [];

  const diffPct = (Math.abs(tail.price - lastSwing.price) / lastSwing.price) * 100;
  if (diffPct > matchTolerancePct) return [];

  const currentPrice = visibleCandles[visibleCandles.length - 1].close;
  const pulledBack = lastSwing.type === 'high' ? currentPrice < tail.price * 0.997 : currentPrice > tail.price * 1.003;
  if (!pulledBack) return [];

  const readyInBars = Math.max(1, swingLookback - tail.barsAgo);
  const confidence = Math.round(Math.max(20, 55 - diffPct * 10));
  const firstLabel = lastSwing.type === 'high' ? 'пик' : 'провал';
  // "рядом с уровнем 2155.00" used to read as if 2155 were the forming second point —
  // it's actually the FIRST (already-confirmed) swing's own price, which the still-
  // forming tail is matching against (real user report: "непонятно где он нашёл первое
  // дно"). Spelling out both points and the first one's date removes the ambiguity.
  const firstDate = lastSwing.date instanceof Date
    ? lastSwing.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' })
    : null;

  return [{
    pattern: lastSwing.type === 'high' ? 'double_top' : 'double_bottom',
    status: 'forming',
    confidence,
    readyInBars,
    levelPrice: lastSwing.price, // stable identity for cross-poll diffing (confirmed/invalidated) by the caller
    detail: `Первый ${firstLabel} был на ${lastSwing.price.toFixed(2)}${firstDate ? ` (${firstDate})` : ''} — `
      + `сейчас цена делает второй рядом, на ${tail.price.toFixed(2)}. Подтверждение примерно через ${readyInBars} `
      + `${readyInBars === 1 ? 'свечу' : readyInBars < 5 ? 'свечи' : 'свечей'}, если цена не пойдёт дальше.`,
  }];
}

// Double top/bottom: swing A and C are the same type and close in price (within
// `matchTolerancePct`), with swing B between them retracing at least `minDepthPct`.
// `sinceSwingIndex` restricts the scan to recent swings only — otherwise a year of
// history throws off dozens of coincidental matches nobody was actually looking at.
function detectDoubleTopBottom(swings, matchTolerancePct = 2, minDepthPct = 2, sinceSwingIndex = 0) {
  const out = [];
  for (let i = Math.max(0, sinceSwingIndex); i + 2 < swings.length; i++) {
    const [a, b, c] = swings.slice(i, i + 3);
    if (a.type !== c.type || a.type === b.type) continue;
    const diffPct = (Math.abs(a.price - c.price) / a.price) * 100;
    const depthPct = (Math.abs(a.price - b.price) / a.price) * 100;
    if (diffPct <= matchTolerancePct && depthPct >= minDepthPct) {
      const confidence = Math.round(Math.max(0, 100 - diffPct * 25) * Math.min(1, depthPct / 5));
      out.push({
        pattern: a.type === 'high' ? 'double_top' : 'double_bottom',
        confidence: Math.min(confidence, 90),
        points: [a, b, c],
        levelPrice: a.price, // same identity field detectFormingDoubleTopBottom uses — lets a caller match "this forming setup confirmed"
        detail: `${a.type === 'high' ? 'Два пика' : 'Два дна'} на уровне ~${a.price.toFixed(2)} `
          + `(расхождение ${diffPct.toFixed(1)}%), между ними откат ${depthPct.toFixed(1)}%.`,
      });
    }
  }
  return out;
}

// Breakout of a static S/R level on the entry bar itself, with volume confirmation.
function detectBreakout(candles, index, levels, volumeRatio) {
  if (index < 1) return [];
  const price = candles[index].close;
  const prevPrice = candles[index - 1].close;
  const out = [];
  for (const lvl of levels) {
    const crossedUp = lvl.type === 'resistance' && prevPrice <= lvl.price && price > lvl.price;
    const crossedDown = lvl.type === 'support' && prevPrice >= lvl.price && price < lvl.price;
    if (!crossedUp && !crossedDown) continue;
    const volumeConfirmed = volumeRatio != null && volumeRatio > 1.3;
    out.push({
      pattern: crossedUp ? 'breakout_up' : 'breakout_down',
      confidence: volumeConfirmed ? 80 : 50,
      level: lvl.price,
      touchCount: lvl.touchCount,
      volumeConfirmed,
      detail: `Пробой уровня ${lvl.type === 'resistance' ? 'сопротивления' : 'поддержки'} `
        + `${lvl.price.toFixed(2)} (${lvl.touchCount} касаний ранее)`
        + (volumeConfirmed ? ', объём подтверждает.' : ', но объём не подтверждает — слабее сигнал.'),
    });
  }
  return out;
}

// Classifies the last 5 swings (2-3 highs, 2-3 lows) into one shape: symmetric/
// ascending/descending triangle, rising/falling wedge, or a flag/pennant in whichever
// direction if there's a strong prior move (a "flagpole") feeding into the range. Only
// one of these fires per call — they're geometrically exclusive by construction (a range
// can't be both converging-opposite AND same-direction-sloped at once).
function classifyConsolidation(swings) {
  if (swings.length < 6) return null; // need one swing before the window to detect a flagpole
  const last5 = swings.slice(-5);
  const pole = swings[swings.length - 6];
  const highs = last5.filter((s) => s.type === 'high');
  const lows = last5.filter((s) => s.type === 'low');
  if (highs.length < 2 || lows.length < 2) return null;

  const highSlopePct = ((highs[highs.length - 1].price - highs[0].price) / highs[0].price) * 100;
  const lowSlopePct = ((lows[lows.length - 1].price - lows[0].price) / lows[0].price) * 100;
  const flat = (slopePct) => Math.abs(slopePct) < 1;

  const range = (pts) => Math.max(...pts.map((p) => p.price)) - Math.min(...pts.map((p) => p.price));
  const isNarrowing = range(last5.slice(-3)) < range(last5.slice(0, 3)) * 0.7;

  const poleMovePct = (Math.abs(last5[0].price - pole.price) / pole.price) * 100;
  const hasPole = poleMovePct >= 3; // arbitrary "strong prior move" threshold
  const poleDirection = last5[0].price > pole.price ? 'up' : 'down';
  const poleLabel = poleDirection === 'up' ? 'роста' : 'падения';

  if (highSlopePct < -1 && lowSlopePct > 1 && isNarrowing) {
    if (hasPole) {
      return {
        pattern: poleDirection === 'up' ? 'pennant_bullish' : 'pennant_bearish', confidence: 55, points: last5,
        detail: `Вымпел после ${poleLabel} на ${poleMovePct.toFixed(1)}% — небольшой симметрично сужающийся диапазон.`,
      };
    }
    return {
      pattern: 'triangle_symmetric', confidence: 50, points: last5,
      detail: 'Симметричный треугольник — максимумы понижаются, минимумы повышаются, без выраженного импульса перед этим.',
    };
  }
  if (flat(highSlopePct) && lowSlopePct > 1) {
    return {
      pattern: 'triangle_ascending', confidence: 55, points: last5,
      detail: 'Восходящий треугольник — сопротивление держится на месте, поддержка последовательно растёт.',
    };
  }
  if (flat(lowSlopePct) && highSlopePct < -1) {
    return {
      pattern: 'triangle_descending', confidence: 55, points: last5,
      detail: 'Нисходящий треугольник — поддержка держится на месте, сопротивление последовательно снижается.',
    };
  }
  if (highSlopePct > 1 && lowSlopePct > 1 && isNarrowing) {
    return {
      pattern: 'wedge_rising', confidence: 50, points: last5,
      detail: 'Восходящий клин — обе границы растут, но диапазон сужается. Чаще медвежий разворотный сигнал, не продолжение.',
    };
  }
  if (highSlopePct < -1 && lowSlopePct < -1 && isNarrowing) {
    return {
      pattern: 'wedge_falling', confidence: 50, points: last5,
      detail: 'Нисходящий клин — обе границы падают, но диапазон сужается. Чаще бычий разворотный сигнал, не продолжение.',
    };
  }
  if (hasPole && !isNarrowing) {
    const channelDirection = (highSlopePct > 1 && lowSlopePct > 1) ? 'ascending'
      : (highSlopePct < -1 && lowSlopePct < -1) ? 'descending' : 'horizontal';
    const labels = { ascending: 'восходящий', descending: 'нисходящий', horizontal: 'горизонтальный' };
    return {
      pattern: `flag_${channelDirection}`, confidence: 50, points: last5,
      detail: `Флаг (${labels[channelDirection]}) после ${poleLabel} на ${poleMovePct.toFixed(1)}%.`,
    };
  }
  return null;
}

// Head & shoulders (top) / inverted (bottom) — needs exactly 5 alternating swings:
// shoulder-neckline-head-neckline-shoulder. The head must be the most extreme point,
// the two shoulders reasonably symmetric (within `shoulderTolerancePct` of each other).
function detectHeadAndShoulders(swings, shoulderTolerancePct = 6) {
  if (swings.length < 5) return null;
  const last5 = swings.slice(-5);
  const types = last5.map((s) => s.type).join(',');
  const isTop = types === 'high,low,high,low,high';
  const isBottom = types === 'low,high,low,high,low';
  if (!isTop && !isBottom) return null;

  const [leftShoulder, neck1, head, neck2, rightShoulder] = last5;
  const headIsExtreme = isTop
    ? head.price > leftShoulder.price && head.price > rightShoulder.price
    : head.price < leftShoulder.price && head.price < rightShoulder.price;
  if (!headIsExtreme) return null;

  const shoulderDiffPct = (Math.abs(leftShoulder.price - rightShoulder.price) / leftShoulder.price) * 100;
  if (shoulderDiffPct > shoulderTolerancePct) return null;
  const neckline = (neck1.price + neck2.price) / 2;
  const confidence = Math.min(85, Math.round(Math.max(0, 80 - shoulderDiffPct * 6)));

  return {
    pattern: isTop ? 'head_shoulders_top' : 'head_shoulders_bottom',
    confidence, points: last5, neckline,
    detail: `${isTop ? 'Голова-плечи' : 'Перевёрнутые голова-плечи'}: плечи ${leftShoulder.price.toFixed(2)} / `
      + `${rightShoulder.price.toFixed(2)} (расхождение ${shoulderDiffPct.toFixed(1)}%), `
      + `голова ${head.price.toFixed(2)}, линия шеи ~${neckline.toFixed(2)}.`,
  };
}

// Simplified 5-wave impulse check — see file header for the honesty caveat. Requires the
// last 6 swing points (5 legs) to alternate direction correctly, then scores against
// four textbook rules, two of them now Fibonacci-based (wave 2 and wave 4 retracement
// ratios) per the user's request to make this less of a coin flip. Still explicitly NOT
// full Elliott theory (no alternation-of-corrections rule, no larger-degree context) —
// confidence is capped at 75, well short of "confirmed fact."
function detectFiveWaveStructure(swings) {
  if (swings.length < 6) return null;
  const w = swings.slice(-6);
  const up = w[0].type === 'low';
  const legs = [];
  for (let i = 1; i < w.length; i++) legs.push(w[i].price - w[i - 1].price);
  const directionsOk = up
    ? (legs[0] > 0 && legs[1] < 0 && legs[2] > 0 && legs[3] < 0 && legs[4] > 0)
    : (legs[0] < 0 && legs[1] > 0 && legs[2] < 0 && legs[3] > 0 && legs[4] < 0);
  if (!directionsOk) return null;

  const lens = legs.map(Math.abs);
  const wave3NotShortest = lens[2] >= lens[0] && lens[2] >= lens[4];
  // Wave 4 shouldn't retrace into wave 1's price territory (classic impulse rule).
  const wave4NoOverlap = up ? w[4].price > w[1].price : w[4].price < w[1].price;
  // Textbook Fibonacci zones: wave 2 typically retraces 38.2-78.6% of wave 1, wave 4
  // typically retraces 23.6-50% of wave 3. "Typically", not "always" — that's exactly
  // why this only nudges confidence, never gates the pattern outright.
  const wave2Retrace = lens[0] > 0 ? lens[1] / lens[0] : 0;
  const wave4Retrace = lens[2] > 0 ? lens[3] / lens[2] : 0;
  const wave2FibOk = wave2Retrace >= 0.382 && wave2Retrace <= 0.786;
  const wave4FibOk = wave4Retrace >= 0.236 && wave4Retrace <= 0.5;

  const rulesPassed = [wave3NotShortest, wave4NoOverlap, wave2FibOk, wave4FibOk].filter(Boolean).length;
  const confidence = Math.round(10 + (rulesPassed / 4) * 65); // 10..75, never higher

  return {
    pattern: up ? 'impulse_up_5wave' : 'impulse_down_5wave',
    confidence,
    lastLegDirection: legs[4] > 0 ? 'up' : 'down',
    checklist: { alternation: true, wave3NotShortest, wave4NoOverlap, wave2FibOk, wave4FibOk },
    points: w,
    detail: `Похоже на 5-волновую структуру (чередование — да, 3-я волна не самая короткая — `
      + `${wave3NotShortest ? 'да' : 'нет'}, 4-я не заходит в зону 1-й — ${wave4NoOverlap ? 'да' : 'нет'}, `
      + `2-я волна в фибо-зоне (38-79%) — ${wave2FibOk ? 'да' : 'нет'} (факт. ${(wave2Retrace * 100).toFixed(0)}%), `
      + `4-я волна в фибо-зоне (24-50%) — ${wave4FibOk ? 'да' : 'нет'} (факт. ${(wave4Retrace * 100).toFixed(0)}%)). `
      + `Последняя (5-я) волна направлена ${legs[4] > 0 ? 'вверх' : 'вниз'} — `
      + `это упрощённая проверка, не полноценный волновой анализ, проверьте глазами.`,
  };
}

// --- Entry point: everything computed as of the entry bar, no lookahead --------------

export function computePatternsAtEntry(candles, atDate, { swingLookback = 3, timeframeMinutes = null } = {}) {
  const target = new Date(atDate).getTime();
  const index = (() => {
    let idx = -1;
    for (let i = 0; i < candles.length; i++) {
      if (candles[i].date.getTime() <= target) idx = i;
      else break;
    }
    return idx;
  })();
  if (index === -1) return null;

  // Only candles up to and including the entry bar — no hindsight.
  const visibleCandles = candles.slice(0, index + 1);
  const emaLevels = computeEmaLevelsAtIndex(candles, index);
  const currentPrice = visibleCandles[visibleCandles.length - 1].close;

  // Swing-based figures (double top/bottom, H&S, flags/triangles/wedges, static S/R)
  // need M15+ to mean anything — below that, a 3-candle lookback window is mostly
  // spread/bot noise, not structure a human trader would recognize (agreed with the
  // trader after they'd watched patterns break down on M15 themselves). Candlestick
  // patterns (pin bar, engulfing) stay honest on any timeframe since they don't depend
  // on swing confirmation lag.
  const swingsAllowed = swingPatternsAllowedForTimeframe(timeframeMinutes);
  const swings = swingsAllowed ? findSwingPoints(visibleCandles, swingLookback) : [];
  const levels = swingsAllowed ? findSupportResistance(swings, currentPrice).slice(0, 6) : [];

  const volumes = visibleCandles.map((c) => c.volume);
  const avgVol20 = volumes.length >= 21
    ? volumes.slice(-21, -1).reduce((s, v) => s + v, 0) / 20
    : null;
  const volumeRatio = avgVol20 ? volumes[volumes.length - 1] / avgVol20 : null;

  // Only scan the most recent swings for double top/bottom — otherwise a year of history
  // throws off dozens of coincidental matches nobody was actually watching form.
  const recentDoubles = swingsAllowed ? detectDoubleTopBottom(swings, 2, 2, swings.length - 15) : [];

  const rawCandidates = [
    ...recentDoubles,
    ...(swingsAllowed ? detectFormingDoubleTopBottom(swings, visibleCandles, swingLookback) : []),
    ...(swingsAllowed ? detectBreakout(visibleCandles, visibleCandles.length - 1, levels, volumeRatio) : []),
    swingsAllowed ? classifyConsolidation(swings) : null,
    swingsAllowed ? detectHeadAndShoulders(swings) : null,
    swingsAllowed ? detectFiveWaveStructure(swings) : null,
    ...detectCandlestickPatterns(visibleCandles, visibleCandles.length - 1),
  ].filter(Boolean);

  // Most candidates are built from confirmed swings/closed candles → status 'confirmed'.
  // `detectFormingDoubleTopBottom` is the one detector that looks at the *unconfirmed*
  // tail and explicitly sets 'forming' — kept exempt from the confidence floor below,
  // since a forming setup is inherently low-confidence by definition (it hasn't proven
  // itself yet) but is exactly the "heads up, watch this" signal live polling exists for.
  const candidates = rawCandidates
    .map((c) => ({ ...c, status: c.status || 'confirmed' }))
    .filter((c) => c.status === 'forming' || c.confidence >= MIN_DISPLAY_CONFIDENCE)
    .sort((a, b) => (a.status === 'forming' ? -1 : b.status === 'forming' ? 1 : b.confidence - a.confidence))
    .slice(0, 6);

  const fibonacci = computeFibonacciLevels(swings);
  if (fibonacci) {
    // Flags which level (if any) the entry price is actually sitting near — otherwise
    // the trader has to eyeball five numbers and guess which one matters right now.
    const nearestIdx = fibonacci.levels.reduce((best, lvl, i) => {
      const dist = Math.abs(currentPrice - lvl.price);
      return (best === -1 || dist < Math.abs(currentPrice - fibonacci.levels[best].price)) ? i : best;
    }, -1);
    const nearest = fibonacci.levels[nearestIdx];
    const nearestDistPct = (Math.abs(currentPrice - nearest.price) / currentPrice) * 100;
    fibonacci.levels = fibonacci.levels.map((lvl, i) => ({ ...lvl, isNearest: i === nearestIdx && nearestDistPct <= 1.5 }));
  }

  return {
    date: visibleCandles[visibleCandles.length - 1].date,
    emaLevels,
    supportResistance: levels,
    fibonacci,
    swingCount: swings.length,
    candidates,
  };
}
