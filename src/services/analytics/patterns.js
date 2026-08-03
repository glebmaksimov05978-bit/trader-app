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

// Shared date formatter for pattern detail text — real, repeated user feedback across
// many reviewed trades ("нужна дата и точная координата второго дна... глаза мозолишь")
// that price-only descriptions left the trader hunting the chart for which candle a
// pattern point actually was. Every multi-point detector below now names dates, not just
// prices, for each key point.
function fmtSwingDate(swing) {
  return swing?.date instanceof Date
    ? swing.date.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: '2-digit' })
    : null;
}

export const PATTERN_LABELS = {
  double_top: 'Двойная вершина',
  double_bottom: 'Двойное дно',
  breakout_up: 'Пробой вверх',
  breakout_down: 'Пробой вниз',
  triangle_symmetric: 'Симметричный треугольник',
  triangle_ascending: 'Восходящий треугольник',
  triangle_descending: 'Нисходящий треугольник',
  wedge_rising: 'Восходящий клин',
  wedge_falling: 'Нисходящий клин',
  flag_ascending: 'Флаг восходящий',
  flag_descending: 'Флаг нисходящий',
  flag_horizontal: 'Флаг горизонтальный',
  pennant_bullish: 'Вымпел (бычий)',
  pennant_bearish: 'Вымпел (медвежий)',
  head_shoulders_top: 'Голова-плечи',
  head_shoulders_bottom: 'Перевёрнутые голова-плечи',
  pin_bar_bullish: 'Пин-бар (бычий)',
  pin_bar_bearish: 'Пин-бар (медвежий)',
  engulfing_bullish: 'Поглощение (бычье)',
  engulfing_bearish: 'Поглощение (медвежье)',
  impulse_up_5wave: '5-волновая структура вверх (упрощённо)',
  impulse_down_5wave: '5-волновая структура вниз (упрощённо)',
};

export const STATUS_LABELS = { confirmed: 'сформирована', forming: 'формируется', invalidated: 'отменилась' };

// Textbook direction of each detectable figure. Classification follows the common
// convention: falling wedge and ascending triangle are bullish, their mirrors bearish;
// symmetric triangle and horizontal flag break either way. Flags/pennants are named here
// by the direction of the move they continue (восходящий флаг = бычий).
//
// Lives here (not in the UI component that first needed it) because strategy.js's
// `pattern_confirmed` condition needs it too, to fix a real bug caught live: the
// condition used to count ANY confirmed pattern ≥ threshold toward BOTH long and short
// readiness, regardless of which way that specific pattern actually points — a bullish
// double_bottom could satisfy a SHORT entry just as easily as a long one. See
// evaluate() in strategy.js.
export const PATTERN_DIRECTIONS = {
  bullish: ['double_bottom', 'head_shoulders_bottom', 'triangle_ascending', 'wedge_falling', 'breakout_up', 'flag_ascending', 'pennant_bullish', 'pin_bar_bullish', 'engulfing_bullish', 'impulse_up_5wave'],
  bearish: ['double_top', 'head_shoulders_top', 'triangle_descending', 'wedge_rising', 'breakout_down', 'flag_descending', 'pennant_bearish', 'pin_bar_bearish', 'engulfing_bearish', 'impulse_down_5wave'],
  neutral: ['triangle_symmetric', 'flag_horizontal'],
};

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
// at least 2 different swings landed within `toleranceRatio` of each other.
//
// Each touch also records `amplitudePct` — how far price moved before reversing (to the
// next swing in the zig-zag, or the previous one if it's the last point) — used by
// markStrongestLevel below as a modest bonus on top of the touch count, not a
// replacement for it. An earlier version summed amplitudes directly into the main score
// (`touchWeight`) and that broke the balance the OTHER way: a level with several
// percent-scale touches could rack up 20-30 points from amplitude alone, completely
// burying the +3 EMA200 or +2 golden-Fibonacci bonuses that used to actually matter
// (real user question: "не будет ли ошибки из-за того что за это присуждается намного
// больше очков чем за EMA200"). Correct, caught before shipping to more users.
// A touch only counts toward a level if the reversal off it reached at least this
// fraction of the ticker's own average swing amplitude — below that it's market noise,
// not a defended level, and it shouldn't inflate the touch count at all (real user
// concern: "касаний может быть уйма... не брать у кого был маленький отскок").
// Relative to the ticker's own average (not a fixed %) so the same rule adapts to a
// quiet blue chip and a swingy futures contract alike. First-guess threshold like every
// other number in this file — to be revisited against real outcomes (see backlog).
const MIN_TOUCH_AMPLITUDE_RATIO = 0.5;

export function findSupportResistance(swings, currentPrice, toleranceRatio = 0.006) {
  const withAmplitude = swings.map((s, i) => {
    const next = swings[i + 1];
    const prev = swings[i - 1];
    const move = next ? Math.abs(next.price - s.price) : prev ? Math.abs(s.price - prev.price) : 0;
    return { ...s, amplitudePct: s.price > 0 ? (move / s.price) * 100 : 0 };
  });

  // Noise gate: drop swings whose reversal was well below this ticker's typical swing —
  // they never enter clustering, so they can't pad touch counts OR spawn phantom levels.
  const avgAmplitude = withAmplitude.length
    ? withAmplitude.reduce((sum, s) => sum + s.amplitudePct, 0) / withAmplitude.length
    : 0;
  const significant = avgAmplitude > 0
    ? withAmplitude.filter((s) => s.amplitudePct >= avgAmplitude * MIN_TOUCH_AMPLITUDE_RATIO)
    : withAmplitude;

  const sorted = [...significant].sort((a, b) => a.price - b.price);
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
      avgTouchAmplitudePct: c.touches.reduce((sum, t) => sum + t.amplitudePct, 0) / c.touches.length,
      type: c.price > currentPrice ? 'resistance' : 'support',
      lastTouchDate: c.touches[c.touches.length - 1].date,
    }))
    .sort((a, b) => Math.abs(a.price - currentPrice) - Math.abs(b.price - currentPrice));
}

// Weights for "which level is the strongest right now" — a static S/R level earns 1
// point per touch (each touch is the SAME detection method repeating, so it's a weak
// signal on its own), plus bonus points when an independently-computed level (EMA,
// Fibonacci) sits within `tolerancePct` of it — agreement between methods that don't
// share math is worth more than one more touch of the same swing detector. Weights
// follow common trading convention (longer-period MAs and the "golden" Fibonacci
// ratios are widely treated as more significant), not a statistically proven ranking —
// same as everything else in this app, meant to be revisited once real outcome data
// exists to check it against.
const LEVEL_STRENGTH_WEIGHTS = {
  ema9: 1, ema100: 2, ema200: 3,
  fibGolden: 2,      // 38.2% / 50% / 61.8% — the most-watched Fibonacci ratios
  fibOuter: 1,       // 23.6% / 78.6% — considered the weaker Fibonacci levels
  bollingerBand: 1,  // upper/lower band — recomputed every bar from current volatility,
                      // not a stable structural price the way EMA200/Fibonacci are, so a
                      // coincidence with it today doesn't carry the same weight (real user
                      // question: confirmed intentional, not an oversight).
  bollingerMid: 1,    // middle band (SMA20) — same reasoning, same weight as the outer bands.
  reversalStrength: 3, // max bonus for touches with well-above-average reversal amplitude
                        // — deliberately capped at the SAME size as the EMA200 bonus, not
                        // summed per-touch, so a level with strong reversals stands out
                        // without burying the confluence bonuses (real user question about
                        // exactly this — see markStrongestLevel).
};

// Marks the strongest RESISTANCE and the strongest SUPPORT separately — a global single
// winner across both types (the old behavior) meant a strong support level never got
// starred whenever some resistance happened to outscore it (real user report). Everything
// stays visible either way; this only adds a ranking on top of what's already shown, never
// hides or merges the independent calculations (see findSupportResistance,
// computeEmaLevelsAtIndex, computeFibonacciLevels — all still computed separately).
//
// Note on what "confluence" actually measures: EMA/Fibonacci/Bollinger bonuses check
// whether that indicator sits near the level RIGHT NOW (at the reference date), not how
// many times it has touched there historically — only `touchCount` (from the swing
// detector) is a genuine historical count. The weights reward independent methods
// agreeing at this moment, not repeated history.
export function markStrongestLevel(levels, emaLevels, fibonacci, bollinger, tolerancePct = 0.3) {
  if (!levels?.length) return levels;
  const near = (a, b) => a != null && b != null && (Math.abs(a - b) / b) * 100 <= tolerancePct;

  // Reversal-amplitude bonus is RELATIVE to the other levels being ranked right now (a
  // fixed percentage threshold would mean something completely different on a
  // low-volatility blue chip vs. a swingy futures contract) — the level with the single
  // highest average touch amplitude gets the full +3, everything else gets a
  // proportional share, zero at the low end. This is deliberately a small bonus added
  // ON TOP of touchCount, not a replacement for it (see findSupportResistance).
  const amplitudes = levels.map((l) => l.avgTouchAmplitudePct || 0);
  const maxAmplitude = Math.max(...amplitudes, 0);

  // `reasons` records WHICH factors actually contributed to this level's score, in
  // plain Russian — the ★ badge used to point at one shared legend for the whole panel,
  // leaving the trader unable to tell whether THIS particular level won on touches
  // alone or genuine multi-method confluence (real user report: "непонятно конкретно
  // этот по каким критериям отобран"). Rendered per-badge via InfoTip.
  const scored = levels.map((lvl) => {
    let score = lvl.touchCount;
    const reasons = [`${lvl.touchCount} касани${lvl.touchCount === 1 ? 'е' : lvl.touchCount < 5 ? 'я' : 'й'} свечами`];
    if (maxAmplitude > 0 && lvl.avgTouchAmplitudePct > 0) {
      const bonus = (lvl.avgTouchAmplitudePct / maxAmplitude) * LEVEL_STRENGTH_WEIGHTS.reversalStrength;
      if (bonus >= 0.5) {
        score += bonus;
        reasons.push(`сильный разворот после касаний (в среднем ${lvl.avgTouchAmplitudePct.toFixed(1)}% хода)`);
      }
    }
    if (near(emaLevels?.ema9?.value, lvl.price)) { score += LEVEL_STRENGTH_WEIGHTS.ema9; reasons.push('рядом EMA9'); }
    if (near(emaLevels?.ema100?.value, lvl.price)) { score += LEVEL_STRENGTH_WEIGHTS.ema100; reasons.push('рядом EMA100'); }
    if (near(emaLevels?.ema200?.value, lvl.price)) { score += LEVEL_STRENGTH_WEIGHTS.ema200; reasons.push('рядом EMA200'); }
    for (const f of fibonacci?.levels || []) {
      if (!near(f.price, lvl.price)) continue;
      const golden = f.ratio !== 0.236 && f.ratio !== 0.786;
      score += golden ? LEVEL_STRENGTH_WEIGHTS.fibGolden : LEVEL_STRENGTH_WEIGHTS.fibOuter;
      reasons.push(`рядом Фибо ${(f.ratio * 100).toFixed(1)}%`);
    }
    if (near(bollinger?.upper, lvl.price) || near(bollinger?.lower, lvl.price)) { score += LEVEL_STRENGTH_WEIGHTS.bollingerBand; reasons.push('рядом полоса Боллинджера'); }
    if (near(bollinger?.mid, lvl.price)) { score += LEVEL_STRENGTH_WEIGHTS.bollingerMid; reasons.push('рядом средняя Боллинджера'); }
    return { ...lvl, strengthScore: score, strengthReasons: reasons };
  });

  // Only worth flagging if it stands out within its own type — tied-for-first isn't
  // "the strongest," it's just noise from a coarse scoring scheme. Touches alone are a
  // perfectly valid way to win (a level with far more touches than anything else IS
  // the strongest one), same as winning purely on confluence with no extra touches.
  const markLeaderWithinType = (type) => {
    const ofType = scored.filter((l) => l.type === type);
    if (!ofType.length) return;
    const maxScore = Math.max(...ofType.map((l) => l.strengthScore));
    const leaders = ofType.filter((l) => l.strengthScore === maxScore);
    if (leaders.length === 1) leaders[0].isStrongest = true;
  };
  scored.forEach((l) => { l.isStrongest = false; });
  markLeaderWithinType('resistance');
  markLeaderWithinType('support');

  return scored;
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

// Double-top/bottom candidates whose SECOND point (swing C) is this many bars old
// relative to the entry bar no longer count. Real bug, caught live: `sinceSwingIndex`
// below windows by SWING COUNT ("last 15 swings"), which was meant as a recency filter
// ("otherwise a year of history throws off dozens of coincidental matches") — but in a
// quiet stretch where few new swings form, "the last 15 swings" can still span many
// MONTHS, so a single high-confidence pair never ages out and keeps winning the
// readiness score against far fresher setups. Confirmed via the trader's own trade-by-
// trade review: a 90%-confidence double-bottom/double-top pair from ~July 2024 kept
// getting cited as the deciding pattern all the way through March 2025 — 7+ months after
// its own move had already played out — simply because too few swings had formed since
// to push it out of the count-based window. Bar-age and swing-count are complementary,
// not redundant: swing-count keeps the scan cheap, bar-age is what actually bounds
// staleness in calendar time.
const MAX_DOUBLE_PATTERN_AGE_BARS = 60;

// Has the pattern's own implied move already played out? Real user idea, and the
// principled way to retire a pattern instead of just aging it out by bar count: once
// price (any time after point C) has traded back to point B's level, the formation is
// done its job — a double-top's bearish signal stops mattering once price has already
// fallen to the base between the two peaks; a double-bottom's bullish signal stops
// mattering once price has already risen back to the peak between the two troughs. The
// trader's own example: "видит две вершины, входит в шорт, потом видит сигнал когда
// цена дошла до основания этой фигуры" — this is exactly that check, scoped to double
// top/bottom for now (a full per-pattern lifecycle tracker for every figure type is a
// bigger, separate project, agreed as a later step).
function doubleTopBottomTargetReached(a, b, c, candles, upToIndex) {
  const after = candles.slice(c.index + 1, upToIndex + 1);
  return after.some((bar) => (a.type === 'high' ? bar.low <= b.price : bar.high >= b.price));
}

// Double top/bottom: swing A and C are the same type and close in price (within
// `matchTolerancePct`), with swing B between them retracing at least `minDepthPct`.
// `sinceSwingIndex` restricts the scan to recent swings only — otherwise a year of
// history throws off dozens of coincidental matches nobody was actually looking at.
// `currentIndex` (the entry bar's own index) additionally gates on real calendar/bar
// recency — see MAX_DOUBLE_PATTERN_AGE_BARS above for why both are needed.
// `visibleCandles`, when given, also excludes a pattern whose target already hit — see
// doubleTopBottomTargetReached above.
function detectDoubleTopBottom(swings, matchTolerancePct = 2, minDepthPct = 2, sinceSwingIndex = 0, currentIndex = null, visibleCandles = null) {
  const out = [];
  for (let i = Math.max(0, sinceSwingIndex); i + 2 < swings.length; i++) {
    const [a, b, c] = swings.slice(i, i + 3);
    if (a.type !== c.type || a.type === b.type) continue;
    if (currentIndex != null && (currentIndex - c.index) > MAX_DOUBLE_PATTERN_AGE_BARS) continue;
    if (visibleCandles && currentIndex != null && doubleTopBottomTargetReached(a, b, c, visibleCandles, currentIndex)) continue;
    const diffPct = (Math.abs(a.price - c.price) / a.price) * 100;
    const depthPct = (Math.abs(a.price - b.price) / a.price) * 100;
    if (diffPct <= matchTolerancePct && depthPct >= minDepthPct) {
      const baseConfidence = Math.round(Math.max(0, 100 - diffPct * 25) * Math.min(1, depthPct / 5));
      // Size bonus — repeated, explicit user feedback ("фигура из всего 11 свечей...
      // фигуры из гораздо большего количества свечей с большой амплитудой явно имеют
      // силу") that a tiny, barely-there pattern scored the same as a large, clearly
      // meaningful one. Same spirit as markStrongestLevel's reversal-amplitude bonus — a
      // modest bonus ON TOP of the geometry score, not a replacement for it. +1 per 5
      // bars the pattern spans (A to C), capped so it can't dominate the base score.
      const barsSpan = c.index - a.index;
      const sizeBonus = Math.min(10, Math.round(barsSpan / 5));
      out.push({
        pattern: a.type === 'high' ? 'double_top' : 'double_bottom',
        confidence: Math.min(90, baseConfidence + sizeBonus),
        points: [a, b, c],
        levelPrice: a.price, // same identity field detectFormingDoubleTopBottom uses — lets a caller match "this forming setup confirmed"
        detail: `${a.type === 'high' ? 'Два пика' : 'Два дна'} на уровне ~${a.price.toFixed(2)}: `
          + `первая точка ${a.price.toFixed(2)}${fmtSwingDate(a) ? ` (${fmtSwingDate(a)})` : ''}, `
          + `${a.type === 'high' ? 'впадина' : 'вершина'} между ними ${b.price.toFixed(2)}${fmtSwingDate(b) ? ` (${fmtSwingDate(b)})` : ''}, `
          + `вторая точка ${c.price.toFixed(2)}${fmtSwingDate(c) ? ` (${fmtSwingDate(c)})` : ''} `
          + `(расхождение ${diffPct.toFixed(1)}%), между ними откат ${depthPct.toFixed(1)}%, фигура на ${barsSpan} свечах.`,
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

  // Size bonus — same reasoning as detectDoubleTopBottom's (repeated user feedback that
  // a small, barely-there consolidation was scored the same as a large, clearly
  // meaningful one): +1 confidence per 5 bars the 5-swing window spans, capped so it
  // can't dominate the base geometry score.
  const barsSpan = last5[last5.length - 1].index - last5[0].index;
  const sizeBonus = Math.min(10, Math.round(barsSpan / 5));
  // "from date → to date" of the whole 5-swing window — real user feedback: descriptions
  // gave a % move or a shape but never said WHEN, leaving the trader to guess which part
  // of the chart was meant ("непонятно от какого момента он считает").
  const fromDate = fmtSwingDate(last5[0]), toDate = fmtSwingDate(last5[last5.length - 1]);
  const dateRange = fromDate && toDate ? ` (${fromDate} → ${toDate})` : '';

  if (highSlopePct < -1 && lowSlopePct > 1 && isNarrowing) {
    if (hasPole) {
      return {
        pattern: poleDirection === 'up' ? 'pennant_bullish' : 'pennant_bearish', confidence: 55 + sizeBonus, points: last5,
        detail: `Вымпел после ${poleLabel} на ${poleMovePct.toFixed(1)}% — небольшой симметрично сужающийся диапазон, ${barsSpan} свечей${dateRange}.`,
      };
    }
    return {
      pattern: 'triangle_symmetric', confidence: 50 + sizeBonus, points: last5,
      detail: `Симметричный треугольник — максимумы понижаются, минимумы повышаются, без выраженного импульса перед этим, ${barsSpan} свечей${dateRange}.`,
    };
  }
  if (flat(highSlopePct) && lowSlopePct > 1) {
    return {
      pattern: 'triangle_ascending', confidence: 55 + sizeBonus, points: last5,
      detail: `Восходящий треугольник — сопротивление держится на месте, поддержка последовательно растёт, ${barsSpan} свечей${dateRange}.`,
    };
  }
  if (flat(lowSlopePct) && highSlopePct < -1) {
    return {
      pattern: 'triangle_descending', confidence: 55 + sizeBonus, points: last5,
      detail: `Нисходящий треугольник — поддержка держится на месте, сопротивление последовательно снижается, ${barsSpan} свечей${dateRange}.`,
    };
  }
  if (highSlopePct > 1 && lowSlopePct > 1 && isNarrowing) {
    return {
      pattern: 'wedge_rising', confidence: 50 + sizeBonus, points: last5,
      detail: `Восходящий клин — обе границы растут, но диапазон сужается. Чаще медвежий разворотный сигнал, не продолжение, ${barsSpan} свечей${dateRange}.`,
    };
  }
  if (highSlopePct < -1 && lowSlopePct < -1 && isNarrowing) {
    return {
      pattern: 'wedge_falling', confidence: 50 + sizeBonus, points: last5,
      detail: `Нисходящий клин — обе границы падают, но диапазон сужается. Чаще бычий разворотный сигнал, не продолжение, ${barsSpan} свечей${dateRange}.`,
    };
  }
  if (hasPole && !isNarrowing) {
    const channelDirection = (highSlopePct > 1 && lowSlopePct > 1) ? 'ascending'
      : (highSlopePct < -1 && lowSlopePct < -1) ? 'descending' : 'horizontal';
    const labels = { ascending: 'восходящий', descending: 'нисходящий', horizontal: 'горизонтальный' };
    return {
      pattern: `flag_${channelDirection}`, confidence: 50 + sizeBonus, points: last5,
      detail: `Флаг (${labels[channelDirection]}) после ${poleLabel} на ${poleMovePct.toFixed(1)}% `
        + `(флагшток от ${fmtSwingDate(pole) || '?'}), сам флаг ${barsSpan} свечей${dateRange}.`,
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
  // Size bonus — same reasoning as the other swing-based detectors: a tiny H&S squeezed
  // into a few candles isn't as meaningful as one spanning a real stretch of the chart
  // (repeated user feedback). +1 per 5 bars the whole 5-swing span covers, capped at +5
  // here (smaller than the other detectors' +10 since this one already caps at 85).
  const barsSpan = rightShoulder.index - leftShoulder.index;
  const sizeBonus = Math.min(5, Math.round(barsSpan / 8));
  const confidence = Math.min(85, Math.round(Math.max(0, 80 - shoulderDiffPct * 6)) + sizeBonus);

  return {
    pattern: isTop ? 'head_shoulders_top' : 'head_shoulders_bottom',
    confidence, points: last5, neckline,
    detail: `${isTop ? 'Голова-плечи' : 'Перевёрнутые голова-плечи'}: `
      + `левое плечо ${leftShoulder.price.toFixed(2)}${fmtSwingDate(leftShoulder) ? ` (${fmtSwingDate(leftShoulder)})` : ''}, `
      + `голова ${head.price.toFixed(2)}${fmtSwingDate(head) ? ` (${fmtSwingDate(head)})` : ''}, `
      + `правое плечо ${rightShoulder.price.toFixed(2)}${fmtSwingDate(rightShoulder) ? ` (${fmtSwingDate(rightShoulder)})` : ''} `
      + `(расхождение плеч ${shoulderDiffPct.toFixed(1)}%), линия шеи ~${neckline.toFixed(2)}, фигура на ${barsSpan} свечах.`,
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
  // throws off dozens of coincidental matches nobody was actually watching form. Also
  // gated on real bar-age (see MAX_DOUBLE_PATTERN_AGE_BARS) so a stale pair can't keep
  // winning just because too few new swings have formed to push it out of the count window.
  const recentDoubles = swingsAllowed
    ? detectDoubleTopBottom(swings, 2, 2, swings.length - 15, visibleCandles.length - 1, visibleCandles)
    : [];

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
