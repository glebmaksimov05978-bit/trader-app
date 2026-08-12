// src/services/analytics/exitRules.js
//
// Exit-rule config lives alongside a saved strategy's entry conditions (see strategy.js)
// — same "one engine" principle: both the backtest (services/backtest/engine.js) and the
// Calculator's "Подставить по стратегии" button compute stop/take from the EXACT SAME
// functions here, so a number the trader sees live is provably the same number the
// backtest already validated.
//
// Stop and take each pick their OWN mechanism independently — a trader might want a
// fixed % stop but a take at the next resistance level. Two extra exits aren't price
// targets at all: closing when the strategy's own checklist readiness drops below its
// threshold ("сигнал пропал"), and closing after a fixed number of bars regardless.

// Fallback distance for a 'level' exit when no support/resistance/EMA200 exists on the
// right side of price — matches the ATR-type exit's own defaults (stopAtrMult: 1.5,
// takeAtrMult: 3 below) so the fallback isn't an arbitrary new number.
const LEVEL_FALLBACK_STOP_ATR_MULT = 1.5;
const LEVEL_FALLBACK_TAKE_ATR_MULT = 3;

// --- Trailing "movement exhausted" exit ------------------------------------------------
//
// The one idea out of many tested in the 2026-08 calibration that measurably worked. The
// problem it solves: patterns call DIRECTION correctly 76-90% of the time, but a fixed 2%
// stop only wins ~49% — because price routinely dips against the trade (ordinary noise)
// and trips the stop before the move it predicted actually starts. Measured over ~2600
// real instances on 6 tickers: exiting when price gives back a fraction of its PEAK
// favorable excursion (instead of at a fixed price) moved average expectancy from −0.03%
// to +0.08% per trade and the share of profitable trades from 49.3% to 56.7%.
//
// Unlike stop/take, this has no price at entry time — it's a running rule the engine
// evaluates bar by bar against the best level reached so far, so it lives here as config
// and is applied in services/backtest/engine.js.
export const DEFAULT_TRAIL_GIVE_BACK_PCT = 50;

// Per-pattern give-back fractions. The optimum genuinely differs by shape (trader's own
// hypothesis, confirmed): flags/double bottoms do best with lots of room (70%+), while
// 5-wave impulses and bullish pennants do better cut short (30%).
//
// ⚠️ HONESTY CAVEAT: these were picked as the best of {30,50,70} on the SAME data they
// were measured on, with per-pattern samples of only 37-464. That is textbook selection
// bias — several of the gaps are well inside noise. Treat as a starting hint, not proven
// truth: they're opt-in (see `trailPerPattern`), the global default stays the primary
// path, and they need out-of-sample confirmation before being trusted.
export const PATTERN_TRAIL_GIVE_BACK_PCT = {
  flag_ascending: 70, double_bottom: 70, engulfing_bullish: 70, triangle_descending: 70,
  head_shoulders_top: 70, pin_bar_bullish: 70, pin_bar_bearish: 70, double_top: 70,
  wedge_rising: 70, wedge_falling: 70,
  triangle_ascending: 50, head_shoulders_bottom: 50, pennant_bearish: 50,
  impulse_up_5wave: 30, flag_descending: 30, engulfing_bearish: 30,
  impulse_down_5wave: 30, pennant_bullish: 30,
};

/**
 * Give-back % this trade should use. Falls back to the strategy's single number whenever
 * per-pattern mode is off or the pattern isn't in the table.
 * @param {object} exitRules
 * @param {string|null} patternName - the pattern that triggered the entry, if any
 */
export function resolveTrailGiveBackPct(exitRules, patternName) {
  const base = exitRules?.trailGiveBackPct ?? DEFAULT_TRAIL_GIVE_BACK_PCT;
  if (!exitRules?.trailPerPattern || !patternName) return base;
  return PATTERN_TRAIL_GIVE_BACK_PCT[patternName] ?? base;
}

// Real bug found live-testing H1 (2026-08-12): `trailMinPeakPct` was a flat 1% no matter
// the timeframe, calibrated implicitly on daily bars (where 1% is an ordinary few-day
// move). On an hourly chart the SAME 1% can take far longer to accumulate — a position
// can sit open for hundreds of bars never even starting to be tracked (no stop/take to
// close it either), and once it finally crosses 1% by a hair, the trail immediately fires
// on the very next small pullback, locking in a barely-there profit. Both symptoms the
// trader saw (one position stuck 2341 bars, several trades closing at +0.03%/+0.36%/
// +0.65%) trace to this one flat threshold.
//
// Fix: default to ATR-based — the minimum move required scales with how much this
// instrument/timeframe actually moves per bar, instead of a number tuned for daily
// candles. `trailMinPeakMode: 'pct'` is kept for backward compatibility / manual override
// (e.g. a trader who wants an exact %, knows what they're doing).
export const DEFAULT_TRAIL_MIN_PEAK_ATR_MULT = 0.5;

export function defaultExitRules() {
  return {
    stopType: 'pct', stopPct: 2, stopAtrMult: 1.5, stopLevelSource: 'sr', stopLevelTolerancePct: 0.3, stopLevelFallbackPct: 2,
    takeType: 'pct', takePct: 4, takeAtrMult: 3, takeLevelSource: 'sr', takeLevelTolerancePct: 0.3, takeLevelFallbackPct: 4,
    onSignalLoss: false,
    maxBars: null,
    // Off by default: it changes exit behaviour substantially, and every existing saved
    // strategy was tuned without it. Opt-in, same as the other non-price exits.
    trailEnabled: false,
    trailGiveBackPct: DEFAULT_TRAIL_GIVE_BACK_PCT,
    trailMinPeakMode: 'atr',                                  // 'atr' (scales with volatility) or 'pct' (fixed number)
    trailMinPeakAtrMult: DEFAULT_TRAIL_MIN_PEAK_ATR_MULT,      // "at least half an ATR of favorable move before tracking give-back"
    trailMinPeakPct: 1,   // used only when trailMinPeakMode === 'pct', or as ATR fallback when ATR isn't available yet
    trailPerPattern: false,
  };
}

// Resolves the actual minimum-peak threshold (in % of entry price) this trade should use
// — ATR-scaled when possible and requested, falling back to the flat % otherwise (no ATR
// yet this early in history, or the trader explicitly chose 'pct' mode).
export function resolveTrailMinPeakPct(exitRules, entryPrice, atr) {
  const mode = exitRules?.trailMinPeakMode ?? 'atr';
  if (mode === 'atr' && atr != null && entryPrice > 0) {
    const mult = exitRules?.trailMinPeakAtrMult ?? DEFAULT_TRAIL_MIN_PEAK_ATR_MULT;
    return (atr * mult / entryPrice) * 100;
  }
  return exitRules?.trailMinPeakPct ?? 1;
}

// Whether the stop/take side sits BELOW or ABOVE entry, expressed as ±1 — a stop and a
// take always sit on opposite sides of entry for the same direction, and long/short
// mirror each other. `stop+long` and `take+short` are both "below"; `take+long` and
// `stop+short` are both "above". Same XNOR relationship drives which S/R type
// ("support" below vs "resistance" above) a level-based rule should look for.
function directionalSign(direction, side) {
  return (side === 'stop') === (direction === 'long') ? -1 : 1;
}

// Nearest support/resistance PRICE on the correct side. `patterns.supportResistance` is
// already sorted nearest-to-current-price-first (see findSupportResistance), so the
// first match of the wanted type is the one we want. Returns null if no such level
// exists — callers fall back to "no number" rather than guessing the wrong side.
function nearestLevelPrice(patterns, wantType) {
  return patterns?.supportResistance?.find((l) => l.type === wantType)?.price ?? null;
}

function levelPrice(direction, side, source, patterns) {
  if (source === 'ema200') return patterns?.emaLevels?.ema200?.value ?? null;
  const wantType = directionalSign(direction, side) < 0 ? 'support' : 'resistance';
  return nearestLevelPrice(patterns, wantType);
}

// A stop sits a little BEYOND the level (further from entry, past it) — normal noise
// touching the level shouldn't stop you out. A take sits a little BEFORE it (pulled back
// toward entry) — requiring price to blow straight through resistance/support to hit the
// target would rarely fill. `tolerancePct` is the trader's own "±N points" buffer.
function applyTolerance(direction, side, price, tolerancePct) {
  if (price == null) return null;
  const sign = directionalSign(direction, side);
  const beyond = side === 'stop' ? sign : -sign;
  return price * (1 + (beyond * tolerancePct) / 100);
}

// Stop distance beyond which "за структуру фигуры" is no longer practical — a formation
// spanning 15% of price would demand a risk nobody sizes for. Matches the cap used when
// this was validated in scripts/patternCalibration.mjs.
const STRUCTURE_STOP_MAX_PCT = 8;

// ...and the floor. Real bug found in live testing (2026-08-11): the pattern's extreme is
// read from the SIGNAL bar, but entry fills at the NEXT bar's open. When price moved
// overnight, that extreme can end up level with — or on the wrong side of — the entry
// price, producing a stop that is instantly touched. The trader saw exactly this: a wall
// of trades opening and closing on the same candle at ±0%, win rate collapsing to 5.3%,
// and in real-money mode "28 trades found, none could be sized" (calcTrade refuses a stop
// that isn't strictly on the losing side of entry, so every position sized to zero).
// Anything closer than this is treated as "no usable structural stop" and falls back.
const STRUCTURE_STOP_MIN_PCT = 0.5;

// The pattern actually behind this entry — same "highest-confidence confirmed candidate"
// rule the backtest engine already uses to pick a per-pattern trail give-back, so a
// structural stop and a per-pattern trail agree on which formation they're talking about.
function drivingPattern(patterns) {
  return patterns?.candidates
    ?.filter((c) => c.status !== 'forming' && Array.isArray(c.points) && c.points.length)
    .sort((a, b) => b.confidence - a.confidence)[0] ?? null;
}

// Stop just beyond the formation's own extreme — under a double bottom's low, over a
// double top's high, etc. Real trader idea: place the stop where the PATTERN would be
// invalidated, not at an arbitrary distance, so ordinary noise inside the formation can't
// trip it. Measured in the 2026-08 calibration: lower win rate (fewer, farther take-profits
// reached) but better average result per trade (+0.18% vs −0.05% for a fixed 2%/2%) — the
// classic "fewer, bigger wins" trade-off, not a free lunch.
function structuralStopPrice(direction, entryPrice, patterns) {
  const pattern = drivingPattern(patterns);
  if (!pattern) return null;
  const prices = pattern.points.map((p) => p.price);
  const raw = direction === 'long' ? Math.min(...prices) : Math.max(...prices);
  // Must sit on the LOSING side of entry — a long's stop below it, a short's above. If
  // price gapped past the formation's extreme overnight this comes out backwards, and a
  // "stop" on the winning side is not a stop at all (see STRUCTURE_STOP_MIN_PCT).
  const onLosingSide = direction === 'long' ? raw < entryPrice : raw > entryPrice;
  if (!onLosingSide) return null;
  const distPct = (Math.abs(entryPrice - raw) / entryPrice) * 100;
  if (distPct < STRUCTURE_STOP_MIN_PCT || distPct > STRUCTURE_STOP_MAX_PCT) return null;
  return raw;
}

// Computes ONE stop-or-take price from a single rule slot. Returns null when that slot
// has no fixed price to offer — type 'none', or a level-based rule whose reference level
// doesn't exist yet (fresh ticker, no swing history) — never a guess.
function computeOne(direction, side, entryPrice, type, params, ctx) {
  if (type === 'structure') {
    // Only validated for the STOP side — the calibration measured "stop under/over the
    // pattern's own extreme", never a matching take-profit rule. Offering it for take
    // would present an untested guess as if it were the same proven thing.
    if (side === 'stop') {
      const raw = structuralStopPrice(direction, entryPrice, ctx.patterns);
      if (raw != null) return raw;
    }
    // No confirmed pattern with points right now (or its extreme is too far away) — same
    // fallback chain as the 'level' type below, reusing the trader's own configured
    // number rather than silently leaving the position with no stop at all.
    if (params.levelFallbackPct != null) {
      return entryPrice * (1 + (directionalSign(direction, side) * params.levelFallbackPct) / 100);
    }
    if (ctx.atr != null) {
      return entryPrice + directionalSign(direction, side) * ctx.atr * LEVEL_FALLBACK_STOP_ATR_MULT;
    }
    return null;
  }
  if (type === 'pct') {
    if (params.pct == null) return null;
    return entryPrice * (1 + (directionalSign(direction, side) * params.pct) / 100);
  }
  if (type === 'atr') {
    if (params.atrMult == null || ctx.atr == null) return null;
    return entryPrice + directionalSign(direction, side) * ctx.atr * params.atrMult;
  }
  if (type === 'level') {
    const raw = levelPrice(direction, side, params.levelSource, ctx.patterns);
    const withTolerance = applyTolerance(direction, side, raw, params.tolerancePct ?? 0.3);
    if (withTolerance != null) return withTolerance;
    // No support/resistance (or EMA200) on the right side of price right now — e.g. price
    // has run well past every known swing level. Without a fallback the position would
    // silently carry NO exit at all on that side (real backtest finding: a "У уровня" stop
    // that never got a level stayed open 730+ days, −31% to −36%, because nearestLevelPrice
    // kept returning null every single bar).
    // Primary fallback: the trader's own "если уровня нет — запасной %" number (real user
    // request — visible/editable in Capital.js's ExitRulesEditor, not a hidden number).
    if (params.levelFallbackPct != null) {
      return entryPrice * (1 + (directionalSign(direction, side) * params.levelFallbackPct) / 100);
    }
    // Secondary fallback for strategies SAVED BEFORE this field existed (their exitRules
    // has no stopLevelFallbackPct/takeLevelFallbackPct at all) — same ATR multipliers the
    // ATR exit type itself defaults to, so old strategies don't regress back to "no exit".
    if (ctx.atr != null) {
      const fallbackMult = side === 'stop' ? LEVEL_FALLBACK_STOP_ATR_MULT : LEVEL_FALLBACK_TAKE_ATR_MULT;
      return entryPrice + directionalSign(direction, side) * ctx.atr * fallbackMult;
    }
    return null;
  }
  return null; // type === 'none'
}

/**
 * @param {'long'|'short'} direction
 * @param {number} entryPrice
 * @param {object} exitRules - see defaultExitRules()
 * @param {{atr?: number|null, patterns?: object|null}} ctx - atr14 and patterns.* as
 *   already computed by computeIndicatorsAtEntry/computePatternsAtEntry — callers already
 *   have these (Calculator's checklist, or the backtest engine's per-bar ctx).
 * @returns {number|null}
 */
// Any stop that isn't strictly on the losing side of entry is not a stop — it would be
// touched the instant the position opens. Level- and structure-based stops can land there
// legitimately (their reference price comes from the SIGNAL bar while the fill happens at
// the NEXT bar's open, so an overnight move can put entry on the wrong side of it), which
// is exactly the bug live testing surfaced on 2026-08-11: same-candle exits at ±0% and
// positions that couldn't be sized at all. Rather than silently emitting a broken stop,
// fall back to the trader's own configured distance.
function usableStop(price, direction, entryPrice) {
  if (price == null) return false;
  const distPct = (Math.abs(entryPrice - price) / entryPrice) * 100;
  if (distPct < STRUCTURE_STOP_MIN_PCT) return false;
  return direction === 'long' ? price < entryPrice : price > entryPrice;
}

export function computeStopPrice(direction, entryPrice, exitRules, ctx) {
  const params = {
    pct: exitRules.stopPct, atrMult: exitRules.stopAtrMult,
    levelSource: exitRules.stopLevelSource, tolerancePct: exitRules.stopLevelTolerancePct,
    levelFallbackPct: exitRules.stopLevelFallbackPct,
  };
  // "Нет" means NO STOP — a deliberate choice (e.g. running the trailing exit as the only
  // way out), not a missing value to be filled in. Regression caught in live testing:
  // the salvage chain below fired even for stopType 'none', silently reinstating a 2%
  // stop and producing "Стоп" exits in a run the trader had explicitly set to stopless.
  if (exitRules.stopType === 'none') return null;
  const price = computeOne(direction, 'stop', entryPrice, exitRules.stopType, params, ctx);
  if (usableStop(price, direction, entryPrice)) return price;
  // Same fallback chain the level/structure branches use internally, applied here so it
  // also covers a stop that came back on the wrong side rather than merely missing.
  if (params.levelFallbackPct != null) {
    const fallback = entryPrice * (1 - (direction === 'long' ? 1 : -1) * params.levelFallbackPct / 100);
    if (usableStop(fallback, direction, entryPrice)) return fallback;
  }
  if (ctx?.atr != null) {
    const fallback = entryPrice - (direction === 'long' ? 1 : -1) * ctx.atr * LEVEL_FALLBACK_STOP_ATR_MULT;
    if (usableStop(fallback, direction, entryPrice)) return fallback;
  }
  return null;
}

export function computeTakePrice(direction, entryPrice, exitRules, ctx) {
  return computeOne(direction, 'take', entryPrice, exitRules.takeType, {
    pct: exitRules.takePct, atrMult: exitRules.takeAtrMult,
    levelSource: exitRules.takeLevelSource, tolerancePct: exitRules.takeLevelTolerancePct,
    levelFallbackPct: exitRules.takeLevelFallbackPct,
  }, ctx);
}

// Human-readable reason a stop/take field couldn't get a number — shown in the
// Calculator instead of silently leaving the field blank with no explanation.
export function exitTypeLabel(type, levelSource) {
  if (type === 'pct') return '% от входа';
  if (type === 'atr') return '×ATR';
  if (type === 'level') return levelSource === 'ema200' ? 'у EMA200' : 'у ближайшего уровня';
  if (type === 'structure') return 'за структурой фигуры';
  return 'не задано';
}
