// src/services/backtest/engine.js
//
// The backtest engine — "one engine" principle: entry signals come straight from
// evaluateStrategy(), the exact function the Calculator/Radar/Journal already call.
// Add a new condition to the constructor in Capital.js and it's backtestable for free,
// with no changes here. This module owns only the mechanical part: walking candles bar
// by bar, deciding when the strategy's readiness crosses the threshold, and simulating
// fills/exits without ever looking at data from the future.
//
// Admin-only tool for now (see AdminRoute in App.js) — this is the "internal instrument"
// phase agreed with the trader: prove the numbers are honest on real history before any
// client ever sees a backtest result.
import { computeIndicatorsAtEntry } from '../analytics/indicators';
import { computePatternsAtEntry } from '../analytics/patterns';
import { computeMarketContextAtEntry } from '../analytics/marketContext';
import { evaluateStrategy } from '../analytics/strategy';

// Bars needed before the first entry check — mostly so SMA200/ATR-average windows have
// real data instead of nulls flooding every condition as "na". Not a hard requirement
// (evaluateStrategy already excludes conditions it can't compute), just avoids wasting
// cycles on bars that can't possibly qualify.
const DEFAULT_WARMUP_BARS = 30;

function buildCtx(candles, atDate, direction, timeframeMinutes) {
  const indicators = computeIndicatorsAtEntry(candles, atDate);
  const patterns = computePatternsAtEntry(candles, atDate, { timeframeMinutes });
  const marketContext = computeMarketContextAtEntry(candles, atDate);
  return { direction, indicators, patterns, marketContext };
}

function readinessPercent(strategy, ctx) {
  const { total, passed } = evaluateStrategy(strategy, ctx);
  return { total, passed, pct: total > 0 ? (passed / total) * 100 : 0 };
}

function computeStopPrice(direction, entryPrice, { stopPct, stopAtrMult, atr }) {
  if (stopAtrMult != null && atr != null) {
    return direction === 'long' ? entryPrice - atr * stopAtrMult : entryPrice + atr * stopAtrMult;
  }
  if (stopPct != null) {
    return direction === 'long' ? entryPrice * (1 - stopPct / 100) : entryPrice * (1 + stopPct / 100);
  }
  return null;
}

function computeTakePrice(direction, entryPrice, { takePct, takeAtrMult, atr }) {
  if (takeAtrMult != null && atr != null) {
    return direction === 'long' ? entryPrice + atr * takeAtrMult : entryPrice - atr * takeAtrMult;
  }
  if (takePct != null) {
    return direction === 'long' ? entryPrice * (1 + takePct / 100) : entryPrice * (1 - takePct / 100);
  }
  return null;
}

// Intrabar stop/take check using the bar's own high/low — the finest granularity daily/
// hourly OHLC gives us. If both levels sit inside the same bar's range, we can't know
// from OHLC alone which was actually touched first, so we conservatively assume the
// WORSE outcome (stop) hit first — never lets a lucky ordering assumption flatter the
// result.
function checkIntrabarExit(position, bar) {
  const { direction, stopPrice, takePrice } = position;
  const stopHit = stopPrice != null && (direction === 'long' ? bar.low <= stopPrice : bar.high >= stopPrice);
  const takeHit = takePrice != null && (direction === 'long' ? bar.high >= takePrice : bar.low <= takePrice);
  if (stopHit) return { price: stopPrice, reason: 'stop' };
  if (takeHit) return { price: takePrice, reason: 'take' };
  return null;
}

function finalizeTrade(position, exitIndex, exitDate, exitPrice, exitReason) {
  const sign = position.direction === 'long' ? 1 : -1;
  const pnlPoints = (exitPrice - position.entryPrice) * sign;
  const pnlPct = (pnlPoints / position.entryPrice) * 100;
  return {
    direction: position.direction,
    entryIndex: position.entryIndex, entryDate: position.entryDate, entryPrice: position.entryPrice,
    entryPercent: position.entryPercent,
    exitIndex, exitDate, exitPrice, exitReason,
    barsHeld: position.barsHeld,
    pnlPoints, pnlPct,
    status: 'closed',
    pnl: pnlPct, // calcStats() only needs a numeric `pnl` + `date` + status:'closed' — we
    // feed it % return per trade (no real position sizing in v1), so profit factor /
    // win-loss averages come out scale-invariant and honest without pretending we've
    // modeled contract size or ruble risk.
    date: exitDate,
  };
}

// `strategy.customConditions` are manually-ticked checkboxes ("Отмечено вручную —
// приложение это не проверяет") — there's no human in a mechanical backtest to tick
// them, so every enabled custom condition would silently evaluate `passed: false` and
// drag the readiness percent down for no honest reason. Stripped before backtesting;
// flagged in the result so the caller can tell the trader their custom conditions were
// skipped, not silently ignored.
function stripCustomConditions(strategy) {
  const hadCustom = (strategy?.customConditions?.length || 0) > 0;
  return { strategy: { ...strategy, customConditions: [] }, hadCustom };
}

/**
 * Runs a single-position, long-or-short mechanical backtest of `strategy` over `candles`.
 *
 * @param {object} params
 * @param {Array<{date:Date,open:number,high:number,low:number,close:number,volume:number}>} params.candles
 *   Ascending by date. Must be REAL candles only — never include synthetic/future bars.
 * @param {object} params.strategy - same shape as userProfile.strategy (conditions, customConditions, readinessThreshold).
 * @param {number|null} [params.timeframeMinutes] - gates swing-pattern detectors, same as the live app.
 * @param {object} [params.exitRules]
 * @param {number|null} [params.exitRules.stopPct] - fixed stop distance, % of entry price.
 * @param {number|null} [params.exitRules.takePct] - fixed take distance, % of entry price.
 * @param {number|null} [params.exitRules.stopAtrMult] - stop distance as a multiple of ATR(14) at entry. Takes priority over stopPct if both set.
 * @param {number|null} [params.exitRules.takeAtrMult] - take distance as a multiple of ATR(14) at entry. Takes priority over takePct if both set.
 * @param {boolean} [params.exitRules.onSignalLoss] - exit when the strategy's own readiness % drops below its threshold.
 * @param {number|null} [params.exitRules.maxBars] - exit after N bars regardless of anything else.
 * @param {number} [params.warmupBars]
 * @returns {{ trades: object[], hadCustomConditions: boolean, barsEvaluated: number, ambiguousBars: number }}
 */
export function runBacktest({
  candles,
  strategy,
  timeframeMinutes = null,
  exitRules = {},
  warmupBars = DEFAULT_WARMUP_BARS,
}) {
  const { strategy: backtestStrategy, hadCustom } = stripCustomConditions(strategy);
  const threshold = backtestStrategy.readinessThreshold ?? 60;
  const { stopPct = null, takePct = null, stopAtrMult = null, takeAtrMult = null, onSignalLoss = false, maxBars = null } = exitRules;

  const trades = [];
  let position = null;
  let ambiguousBars = 0;
  let barsEvaluated = 0;
  const n = candles.length;

  for (let i = warmupBars; i < n; i++) {
    const bar = candles[i];

    if (position) {
      position.barsHeld += 1;

      const intrabar = checkIntrabarExit(position, bar);
      if (intrabar) {
        trades.push(finalizeTrade(position, i, bar.date, intrabar.price, intrabar.reason));
        position = null;
        continue;
      }

      let deferredExit = null; // { reason } — executed at NEXT bar's open, same lag as entry
      if (onSignalLoss) {
        const ctx = buildCtx(candles, bar.date, position.direction, timeframeMinutes);
        const { total, pct } = readinessPercent(backtestStrategy, ctx);
        if (total > 0 && pct < threshold) deferredExit = { reason: 'signal' };
      }
      if (!deferredExit && maxBars != null && position.barsHeld >= maxBars) {
        deferredExit = { reason: 'time' };
      }
      if (deferredExit) {
        const nextBar = candles[i + 1];
        if (nextBar) {
          trades.push(finalizeTrade(position, i + 1, nextBar.date, nextBar.open, deferredExit.reason));
          position = null;
        }
      }
      continue;
    }

    // No open position — check both directions. Conditions carry their own long/short
    // binding (see strategy.js), so evaluating both sides is how a mechanical backtest
    // discovers direction, the same way a trader reads their own checklist for either
    // side of the market.
    barsEvaluated += 1;
    const baseCtx = buildCtx(candles, bar.date, undefined, timeframeMinutes);
    if (!baseCtx.indicators) continue; // shouldn't happen after warmup, defensive only

    const long = readinessPercent(backtestStrategy, { ...baseCtx, direction: 'long' });
    const short = readinessPercent(backtestStrategy, { ...baseCtx, direction: 'short' });
    const qualifiesLong = long.total > 0 && long.pct >= threshold;
    const qualifiesShort = short.total > 0 && short.pct >= threshold;

    let direction = null, entryPercent = null;
    if (qualifiesLong && qualifiesShort) {
      ambiguousBars += 1;
      direction = long.pct >= short.pct ? 'long' : 'short';
      entryPercent = Math.max(long.pct, short.pct);
    } else if (qualifiesLong) { direction = 'long'; entryPercent = long.pct; }
    else if (qualifiesShort) { direction = 'short'; entryPercent = short.pct; }

    if (!direction) continue;
    const nextBar = candles[i + 1];
    if (!nextBar) continue; // signal on the last bar — nothing left to execute into

    const entryPrice = nextBar.open;
    const atr = baseCtx.indicators.atr14 ?? null;
    const stopPrice = computeStopPrice(direction, entryPrice, { stopPct, stopAtrMult, atr });
    const takePrice = computeTakePrice(direction, entryPrice, { takePct, takeAtrMult, atr });
    position = {
      direction, entryIndex: i + 1, entryDate: nextBar.date, entryPrice, entryPercent,
      stopPrice, takePrice, barsHeld: 0,
    };
  }

  // A position still open when history runs out isn't a loss or a win — it's simply
  // unfinished. Closed at the last candle's close purely so the trader can see it on the
  // chart/list; excluded from calcStats by tagging status 'open' instead of 'closed'.
  if (position) {
    const last = candles[n - 1];
    const sign = position.direction === 'long' ? 1 : -1;
    const pnlPoints = (last.close - position.entryPrice) * sign;
    trades.push({
      direction: position.direction,
      entryIndex: position.entryIndex, entryDate: position.entryDate, entryPrice: position.entryPrice,
      entryPercent: position.entryPercent,
      exitIndex: n - 1, exitDate: last.date, exitPrice: last.close, exitReason: 'end_of_data',
      barsHeld: position.barsHeld,
      pnlPoints, pnlPct: (pnlPoints / position.entryPrice) * 100,
      status: 'open',
    });
  }

  return { trades, hadCustomConditions: hadCustom, barsEvaluated, ambiguousBars };
}
