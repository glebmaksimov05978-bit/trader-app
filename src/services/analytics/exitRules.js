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

export function defaultExitRules() {
  return {
    stopType: 'pct', stopPct: 2, stopAtrMult: 1.5, stopLevelSource: 'sr', stopLevelTolerancePct: 0.3,
    takeType: 'pct', takePct: 4, takeAtrMult: 3, takeLevelSource: 'sr', takeLevelTolerancePct: 0.3,
    onSignalLoss: false,
    maxBars: null,
  };
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

// Computes ONE stop-or-take price from a single rule slot. Returns null when that slot
// has no fixed price to offer — type 'none', or a level-based rule whose reference level
// doesn't exist yet (fresh ticker, no swing history) — never a guess.
function computeOne(direction, side, entryPrice, type, params, ctx) {
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
    // has run well past every known swing level. Without this fallback the position would
    // silently carry NO exit at all on that side (real backtest finding: a "У уровня" stop
    // that never got a level stayed open 730+ days, −31% to −36%, because nearestLevelPrice
    // kept returning null every single bar). ATR is volatility a real number, not a guess —
    // fall back to the same multipliers the ATR exit type already defaults to, so a
    // level-based rule always has SOME distance once ATR itself is available.
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
export function computeStopPrice(direction, entryPrice, exitRules, ctx) {
  return computeOne(direction, 'stop', entryPrice, exitRules.stopType, {
    pct: exitRules.stopPct, atrMult: exitRules.stopAtrMult,
    levelSource: exitRules.stopLevelSource, tolerancePct: exitRules.stopLevelTolerancePct,
  }, ctx);
}

export function computeTakePrice(direction, entryPrice, exitRules, ctx) {
  return computeOne(direction, 'take', entryPrice, exitRules.takeType, {
    pct: exitRules.takePct, atrMult: exitRules.takeAtrMult,
    levelSource: exitRules.takeLevelSource, tolerancePct: exitRules.takeLevelTolerancePct,
  }, ctx);
}

// Human-readable reason a stop/take field couldn't get a number — shown in the
// Calculator instead of silently leaving the field blank with no explanation.
export function exitTypeLabel(type, levelSource) {
  if (type === 'pct') return '% от входа';
  if (type === 'atr') return '×ATR';
  if (type === 'level') return levelSource === 'ema200' ? 'у EMA200' : 'у ближайшего уровня';
  return 'не задано';
}
