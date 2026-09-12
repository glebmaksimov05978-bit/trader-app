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
import { computeIndicatorsAtEntry, sma } from '../analytics/indicators';
import { computePatternsAtEntry } from '../analytics/patterns';
import { computeMarketContextAtEntry } from '../analytics/marketContext';
import { evaluateStrategy } from '../analytics/strategy';
import { computeStopPrice, computeTakePrice, resolveTrailGiveBackPct, resolveTrailMinPeakPct, resolveTrailAdverseThresholdPct, isConfirmedReversal, profitCaptureScore, lossNearBottomScore, profitCaptureBreakdown, lossNearBottomBreakdown } from '../analytics/exitRules';
import { calcTrade } from '../../utils/calculator';

// Market-regime filter (2026-08-17): the single strongest, most universal finding of the
// 2026-08-13/17 session — block new LONG entries while the index itself (IMOEXF, D1) is
// below its own SMA50 (i.e. the whole market is in a downtrend). Validated in
// scripts/marketRegimeTest.mjs / trailAdverseSweep2.mjs: portfolio -8.0% -> +14.9% on the
// base trail, and it held up on two OTHER strategies with no pattern logic at all
// (scripts/multiStrategyUniversality.mjs) — this isn't specific to one entry signal, it
// catches "the whole market is falling" regardless of what triggered this particular
// trade. Shorts are never touched (the finding only ever applied to longs).
// `indexCandles` is always the D1 index series regardless of the traded instrument's own
// timeframe — SMA50-on-D1 is the "regime", not something that needs recalculating per
// intraday bar.
export function buildMarketRegimeFilter(indexCandles) {
  if (!indexCandles || indexCandles.length < 50) return null;
  const closes = indexCandles.map((c) => c.close);
  const sma50 = sma(closes, 50);
  const dates = indexCandles.map((c) => new Date(c.date).getTime());
  return function isBelowSma50(date) {
    const t = new Date(date).getTime();
    let idx = -1;
    // dates are in ascending order — linear scan is fine at D1 series lengths (~1-2k bars)
    for (let i = 0; i < dates.length; i++) {
      if (dates[i] <= t) idx = i; else break;
    }
    if (idx < 0 || sma50[idx] == null) return null; // not enough index history yet — don't filter
    return closes[idx] < sma50[idx];
  };
}

// Real position sizing (optional — see runBacktest's `riskSizing` param). Reuses the
// EXACT same math the Calculator uses for a real trade (real user request: "зачем ты
// придумываешь, если это уже в стратегии указано" — риск% и загрузка депозита are
// strategy settings that already exist, not something to invent separately). Returns
// null when there's no stop distance to size against (exitRules.stopType === 'none'),
// since "risk % of deposit" is meaningless without a defined risk distance.
function sizePosition(entryPrice, stopPrice, riskSizing) {
  if (!riskSizing || stopPrice == null) return null;
  const sizing = calcTrade({
    entryPrice, stopLoss: stopPrice,
    depositSize: riskSizing.depositSize, riskPercent: riskSizing.riskPercent,
    lot: riskSizing.lot, minStep: riskSizing.minStep, minStepAmount: riskSizing.minStepAmount,
    initialMargin: riskSizing.initialMargin, commissionRate: riskSizing.commissionRate,
    maxMarginPercent: riskSizing.maxMarginPercent, instrumentType: riskSizing.instrumentType,
  });
  if (!sizing || !sizing.contracts) return null;
  // Rubles moved per 1 point of price, derived from calcTrade's own lossPerContract
  // rather than re-deriving the stock-vs-future branching a second time here.
  const rubPerPoint = sizing.lossPerContract / Math.abs(entryPrice - stopPrice);
  return { contracts: sizing.contracts, rubPerPoint, commission: sizing.commission };
}

// Bars needed before the first entry check — mostly so SMA200/ATR-average windows have
// real data instead of nulls flooding every condition as "na". Not a hard requirement
// (evaluateStrategy already excludes conditions it can't compute), just avoids wasting
// cycles on bars that can't possibly qualify.
const DEFAULT_WARMUP_BARS = 30;

// Экспортируются ради робота бумажных сделок: он должен открывать позицию ПО ТЕМ ЖЕ
// правилам, что и бэктест, иначе бумажная статистика будет отвечать на другой вопрос, чем
// исследование, и сравнивать их станет нельзя. Собственная копия этих трёх строк на
// стороне робота неизбежно разъехалась бы с этой при первой же правке здесь.
export function buildCtx(candles, atDate, direction, timeframeMinutes) {
  const indicators = computeIndicatorsAtEntry(candles, atDate);
  const patterns = computePatternsAtEntry(candles, atDate, { timeframeMinutes });
  const marketContext = computeMarketContextAtEntry(candles, atDate);
  return { direction, indicators, patterns, marketContext };
}

export function readinessPercent(strategy, ctx) {
  const { total, passed } = evaluateStrategy(strategy, ctx);
  return { total, passed, pct: total > 0 ? (passed / total) * 100 : 0 };
}

// Intrabar stop/take check using the bar's own high/low — the finest granularity daily/
// hourly OHLC gives us. If both levels sit inside the same bar's range, we can't know
// from OHLC alone which was actually touched first, so we conservatively assume the
// WORSE outcome (stop) hit first — never lets a lucky ordering assumption flatter the
// result.
//
// Gap-through fill: a stop/take price is only where you WANTED out, not necessarily where
// you actually got out. If the bar opened already past the level (a gap over a weekend, a
// news overnight move), the real fill is the bar's OPEN, not the stop/take price — for a
// stop that's worse than requested, for a take it's better. Real trader concern: assuming
// a perfect fill at the exact stop price on every gap silently flatters the backtest —
// this was previously always returning `stopPrice`/`takePrice` verbatim regardless of the
// bar's open, understating losses (and overstating gains) on any real gap.
function gapAwareFillPrice(level, barOpen, isStop, direction) {
  const gappedThrough = direction === 'long'
    ? (isStop ? barOpen <= level : barOpen >= level)
    : (isStop ? barOpen >= level : barOpen <= level);
  return gappedThrough ? barOpen : level;
}

export function checkIntrabarExit(position, bar) {
  const { direction, stopPrice, takePrice } = position;
  const stopHit = stopPrice != null && (direction === 'long' ? bar.low <= stopPrice : bar.high >= stopPrice);
  const takeHit = takePrice != null && (direction === 'long' ? bar.high >= takePrice : bar.low <= takePrice);
  if (stopHit) return { price: gapAwareFillPrice(stopPrice, bar.open, true, direction), reason: 'stop' };
  if (takeHit) return { price: gapAwareFillPrice(takePrice, bar.open, false, direction), reason: 'take' };
  return null;
}

// Trailing "movement exhausted" exit — see the long rationale in exitRules.js. Tracks the
// best excursion IN OUR FAVOUR so far and closes once price hands back `giveBackPct` of
// it. Deliberately evaluated on the bar's CLOSE, not its low/high: an intrabar wick
// dipping below the give-back line is exactly the noise this exit exists to survive, so
// exiting on it would reintroduce the very problem a fixed stop has.
// Profit-capture score, see exitRules.js profitCaptureScore for the calibration/rationale
// — trader's idea 2026-08-16: the symmetric counterpart to the reversal signal, replacing
// the blunt "give back 50% of peak" rule with a scored read of "is this move actually
// topping out" once the trail has armed. Revised 2026-08-17 after a wider 27-feature
// search (ADX + EMA13 + Bollinger10, threshold 4) beat both the blunt rule and the
// original 12-feature version in every market-regime segment tested — see exitRules.js.
// `favorableOverride` lets the caller feed the score a different "how far in profit are
// we" number than the bar's close return. Measured 2026-08-28: the score is evaluated on
// the CLOSE while the trail's peak tracks the HIGH, so a bar that spiked to +20% and
// closed at +2% is seen by the score as +2%. Only ONE of the score's seven components
// (`currentFavorablePct > 8`) reads this number at all, so the ceiling on this fix is a
// single point out of the threshold of 4 — worth measuring rather than assuming.
export function buildProfitScoreCtx(position, bar, candles, i, closeReturnPct, favorableOverride = null) {
  const dirSign = position.direction === 'long' ? 1 : -1;
  const ind = computeIndicatorsAtEntry(candles, bar.date);
  if (!ind) return null;
  const barsSinceArm = i - position.armIndex;
  const bollinger10PercentB = ind.bollinger10?.percentB != null
    ? (dirSign === 1 ? ind.bollinger10.percentB : 1 - ind.bollinger10.percentB)
    : null;
  return { dirSign, ctx: {
    currentRsi14: ind.rsi14,
    currentFavorablePct: favorableOverride != null ? favorableOverride : closeReturnPct,
    bollinger10PercentB, ema13DistancePct: ind.ema13Distance != null ? ind.ema13Distance * dirSign : null,
    volumeRatio: ind.volumeRatio, barsSinceArm, adx14: ind.adx14,
  } };
}

// Пороги по барам берутся из позиции (см. createPosition — по умолчанию исходные
// дневные 15/10/2/2), а не хардкодятся здесь — иначе калибровку под H1 негде было бы
// подключить, не трогая сами формулы score.
function profitScoreCfg(position) {
  return { armBars: position.profitArmBars, tooEarlyArmBars: position.profitTooEarlyArmBars };
}
function lossScoreCfg(position) {
  return { heldBars: position.lossHeldBars, tooEarlyHeldBars: position.lossTooEarlyHeldBars };
}

export function computeProfitCaptureScore(position, bar, candles, i, closeReturnPct, favorableOverride = null) {
  const built = buildProfitScoreCtx(position, bar, candles, i, closeReturnPct, favorableOverride);
  if (!built) return null;
  return profitCaptureScore(built.dirSign, built.ctx, profitScoreCfg(position));
}

// Разбор по признакам для панели «Сопровождения» — тот же контекст, что у самого score.
export function computeProfitBreakdown(position, bar, candles, i, closeReturnPct, favorableOverride = null) {
  const built = buildProfitScoreCtx(position, bar, candles, i, closeReturnPct, favorableOverride);
  if (!built) return null;
  return profitCaptureBreakdown(built.dirSign, built.ctx, profitScoreCfg(position));
}

// Which "favorable %" the score should read. 'close' is the shipped behaviour; 'peak'
// uses the raw intrabar high; 'confirmedPeak' uses the wick-filtered peak (only bars that
// closed near their own high count), which is the liquidity-safe version.
function resolveScoreFavorable(position, closeReturnPct) {
  const src = position.profitScoreFavorableSource ?? 'close';
  if (src === 'peak') return position.peakFavorablePct ?? closeReturnPct;
  if (src === 'confirmedPeak') return position.confirmedPeakPct ?? closeReturnPct;
  return null; // 'close' — no override, use the bar close as before
}

function avgVolume(candles, from, to) {
  let s = 0, n = 0;
  for (let k = from; k <= to && k < candles.length; k++) { s += candles[k].volume || 0; n++; }
  return n ? s / n : 0;
}

// Counts how many CONTINUATION signals were present at the peak. Each threshold is
// optional (null = don't test it), so one config object can express anything from a
// single-signal rule to "all five must agree" — which is what the combination sweep in
// scripts/holdRuleSweep.mjs exercises. Returns { count, tested }.
function countHoldSignals(position, cfg) {
  let count = 0, tested = 0;
  const check = (threshold, value, cmp) => {
    if (threshold == null) return;
    tested += 1;
    if (value != null && cmp(value, threshold)) count += 1;
  };
  const barsToPeak = position.peakBarIndex != null ? position.peakBarIndex - position.entryIndex : null;
  check(cfg.peakAgeMinBars, barsToPeak, (v, t) => v >= t);
  check(cfg.peakRsiMax, position.peakRsi14, (v, t) => v < t);
  check(cfg.bollMin, position.peakBollPercentB, (v, t) => v >= t);
  check(cfg.volSpikeMin, position.peakVolSpike, (v, t) => v >= t);
  check(cfg.volTrendMin, position.peakVolTrend, (v, t) => v >= t);
  const divergence = position.armRsi14 != null && position.peakRsi14 != null
    ? position.armRsi14 - position.peakRsi14
    : null;
  check(cfg.divergenceMin, divergence, (v, t) => v >= t);
  return { count, tested };
}

// True when the configured continuation evidence is strong enough to SKIP the loss-side
// cut and let the blunt trailAdverse threshold be the only exit — i.e. give the trade
// more room because the peak looked like a strong move pausing, not one exhausting.
function shouldHoldThroughPullback(position) {
  const cfg = position.holdRule;
  if (!cfg) return false;
  const { count, tested } = countHoldSignals(position, cfg);
  if (!tested) return false;
  const need = cfg.mode === 'any' ? 1 : cfg.mode === 'all' ? tested : (cfg.minSignals ?? tested);
  return count >= need;
}

// TRAJECTORY CLASSIFIER (2026-08-23). Five sweeps of "detect the breakdown at the moment
// of the pullback" topped out at 59% precision — too weak, because the trades wrongly cut
// are worth +10% each. This asks a different question: does the trade's PATH over its
// first N bars separate winners from leakers? Measured on 2810 trades it does, far more
// sharply than any indicator state: by day 10, price still negative → 77.4% leak rate,
// while +5% with 60%+ up-days → 10.0%.
//
// Deliberately NOT a reversal detector: it classifies the trade's character early, so the
// two populations can get different exit policies — 'sick' cut early, 'healthy' given more
// room. Honest caveat carried into the test: "still negative on day 10" partly restates
// the outcome rather than predicting it, which is exactly why it must earn its keep in a
// real engine run rather than in a correlation table.
function classifyTrajectory(position, candles, i) {
  const cfg = position.trajectoryRule;
  if (!cfg) return null;
  const barsHeld = i - position.entryIndex;
  const at = cfg.atBar ?? 10;
  if (barsHeld < at) return null; // too early to judge
  const isLong = position.direction === 'long';
  const entry = position.entryPrice;
  const end = position.entryIndex + at;
  if (end >= candles.length) return null;

  let upBars = 0;
  for (let k = position.entryIndex + 1; k <= end; k++) {
    const prev = isLong ? candles[k - 1].close : -candles[k - 1].close;
    const cur = isLong ? candles[k].close : -candles[k].close;
    if (cur > prev) upBars += 1;
  }
  const upShare = at > 0 ? (upBars / at) * 100 : 0;
  const netMove = isLong
    ? ((candles[end].close - entry) / entry) * 100
    : ((entry - candles[end].close) / entry) * 100;

  if (cfg.healthyNetMin != null && netMove >= cfg.healthyNetMin
    && (cfg.healthyUpShareMin == null || upShare >= cfg.healthyUpShareMin)) return 'healthy';
  if (cfg.sickNetMax != null && netMove < cfg.sickNetMax
    && (cfg.sickUpShareMax == null || upShare < cfg.sickUpShareMax)) return 'sick';
  return 'neutral';
}

export function updateTrailAndCheckExit(position, bar, candles, i, onTrace = null) {
  const { direction, entryPrice } = position;

  // EARLY MAE CUT (2026-08-28, trader's idea). Study on the 886 trades that eventually
  // got cut by the emergency stop: those that dug >2% against entry within their first 3
  // bars were "never profitable during their life" 59.2% of the time, vs 0% for trades
  // whose first-3-bar dip stayed shallower than -0.5%. Different question from the 89
  // failed "hold longer" attempts — this tries to recognize trades that were DEAD FROM
  // THE START, before the trail's own (much wider, ATR-scaled) arm/adverse thresholds
  // would ever engage. Runs on bars 1..earlyMaeCutBars only, checked before everything
  // else so it can fire ahead of arming. Off unless configured.
  const adv = direction === 'long'
    ? ((bar.low - entryPrice) / entryPrice) * 100
    : ((entryPrice - bar.high) / entryPrice) * 100;
  position.worstAdversePct = Math.min(position.worstAdversePct ?? 0, adv);
  if (position.earlyMaeCutBars && position.barsHeld <= position.earlyMaeCutBars
    && position.worstAdversePct <= position.earlyMaeCutThresholdPct) {
    return { price: bar.close, reason: 'early_mae_cut' };
  }

  const wasArmed = (position.peakFavorablePct ?? 0) >= position.trailMinPeakPct;
  const favorableHigh = direction === 'long'
    ? ((bar.high - entryPrice) / entryPrice) * 100
    : ((entryPrice - bar.low) / entryPrice) * 100;
  const isNewPeakBar = favorableHigh > (position.peakFavorablePct ?? 0);
  if (favorableHigh > (position.peakFavorablePct ?? 0)) {
    // Peak just moved — snapshot the "is this move exhausting or still strong" evidence
    // AT the peak, for the hold rule below. Recomputed only on bars that actually extend
    // the peak, so the cost is a fraction of doing it every bar.
    //
    // Counter-intuitive but measured (2026-08-22, 2465 trades): every classic exhaustion
    // signal here — volume climax, price outside the Bollinger band, RSI divergence —
    // was associated with MORE continuation, not less (74% vs 36% reaching +10%). These
    // are captured as CONTINUATION signals for that reason, not reversal ones.
    const dirSign = direction === 'long' ? 1 : -1;
    const ind = computeIndicatorsAtEntry(candles, bar.date);
    position.peakBarIndex = i;
    position.peakRsi14 = ind?.rsi14 ?? null;
    // CONFIRMED peak — trader's liquidity objection (2026-08-28): an intrabar high can be
    // a 3-second spike nobody could actually have sold into. Daily OHLC can't prove how
    // long a price held, but a bar that CLOSES near its high is evidence the move stuck,
    // while a long upper wick with a weak close is evidence it didn't. So the confirmed
    // peak only advances when the bar closed in the top `peakConfirmCloseFraction` of its
    // own range. Give-back is measured against THIS, not the raw high, so a wick alone
    // can never trigger a fixation the trader couldn't have executed.
    if (position.peakConfirmCloseFraction != null) {
      const range = bar.high - bar.low;
      const closePos = range > 0
        ? (direction === 'long' ? (bar.close - bar.low) / range : (bar.high - bar.close) / range)
        : 1;
      if (closePos >= position.peakConfirmCloseFraction) {
        position.confirmedPeakPct = Math.max(position.confirmedPeakPct ?? 0, favorableHigh);
      }
    } else {
      position.confirmedPeakPct = Math.max(position.confirmedPeakPct ?? 0, favorableHigh);
    }
    position.peakBollPercentB = ind?.bollinger?.percentB != null
      ? (dirSign === 1 ? ind.bollinger.percentB : 1 - ind.bollinger.percentB)
      : null;
    // Volume at the peak bar vs the average of the run-up, and whether volume was rising
    // into the peak (late 3 bars vs first 3 bars after entry).
    const runupAvg = avgVolume(candles, position.entryIndex, Math.max(position.entryIndex, i - 1));
    position.peakVolSpike = runupAvg > 0 ? (bar.volume || 0) / runupAvg : null;
    const lateAvg = avgVolume(candles, Math.max(position.entryIndex, i - 3), Math.max(position.entryIndex, i - 1));
    const earlyAvg = avgVolume(candles, position.entryIndex, Math.min(Math.max(position.entryIndex, i - 1), position.entryIndex + 2));
    position.peakVolTrend = earlyAvg > 0 ? lateAvg / earlyAvg : null;
  }
  position.peakFavorablePct = Math.max(position.peakFavorablePct ?? 0, favorableHigh);

  const closeReturnPct = direction === 'long'
    ? ((bar.close - entryPrice) / entryPrice) * 100
    : ((entryPrice - bar.close) / entryPrice) * 100;

  // Symmetric adverse-side check (see exitRules.js resolveTrailAdverseThresholdPct for the
  // full rationale) — evaluated on the bar's CLOSE, same discipline as the favorable side
  // below, so an intrabar wick doesn't trip it. Checked before the favorable branch: a
  // trade can only be adverse or favorable on a given bar, never both.
  if (position.trailAdverseEnabled && position.trailAdverseThresholdPct != null
    && -closeReturnPct >= position.trailAdverseThresholdPct) {
    return { price: bar.close, reason: 'trail_adverse' };
  }

  // PEAK MODEL RULE (2026-09-04). The first thing in this project to survive honest
  // out-of-sample validation: a multivariate model over ~17 features, evaluated at each bar
  // that sets a NEW peak, predicting whether a HIGHER peak comes later in this same trade.
  // Measured (scripts/peakRatingModel2.mjs, trained on the search half only): AUC 0.752 on the
  // untouched verify half vs 0.663 for the best single feature — a real +0.089 joint gain, and
  // the bottom decile drops continuation probability from the 81.7% base rate to 47.6%.
  // `predict` is supplied by the caller (the engine stays model-agnostic); it returns P(higher
  // peak later). Acting when that probability is LOW is the whole point. Off unless configured.
  // `fireState` selects WHICH cohort the rule is allowed to act on, by how many times the
  // profit system has already spoken for this trade: 'none' (it never fired — the population
  // where this rule was validated), 'once' (fired exactly once, then went quiet — the group
  // that peaks at +11.35% and still finishes at +0.95%), or 'any'. `requireNoProfitFire` is
  // the older boolean spelling of 'none', kept so existing configs keep working.
  const fireState = position.peakModelRule?.fireState
    ?? (position.peakModelRule?.requireNoProfitFire ? 'none' : 'any');
  const fireStateOk = fireState === 'any'
    || (fireState === 'none' && position.profitCutsDone === 0)
    || (fireState === 'once' && position.profitCutsDone === 1);
  if (position.peakModelRule && isNewPeakBar
    && position.peakFavorablePct >= (position.peakModelRule.minPeakPct ?? 0)
    && fireStateOk) {
    const p = position.peakModelRule.predict({ position, bar, candles, i, closeReturnPct,
      peakPct: position.peakFavorablePct, direction });
    if (p != null && p <= position.peakModelRule.threshold) {
      const frac = position.peakModelRule.fraction ?? 1;
      if (frac >= 1) return { price: bar.close, reason: 'peak_model' };
      if (position.modelCutsDone < (position.peakModelRule.maxTimes ?? 1)) {
        position.modelCutsDone += 1;
        recordFill(position, frac, bar.close, i, bar.date, 'peak_model_partial');
        if (position.remaining <= 0.001) return { price: bar.close, reason: 'peak_model' };
      }
    }
  }

  // MFE LADDER (2026-08-31). Every one of the ~128 rejected exit variants keyed off the
  // profit-capture SCORE (which fires at the peak and reaches its threshold on only 2.7% of
  // bars) or off a give-back from the peak (which by definition acts only after part of the
  // move is already gone). This one keys off the plain profit level instead, unconditionally.
  // Evidence: the conditional-continuation study (scripts/conditionalContinuation.mjs, time
  // split, 11/11 cells agreeing) measured P(give it all back) at 46% from +3%, 30% from +5%
  // and 17% from +7% — the danger zone is narrow and sits low, which is exactly where no
  // tested rule ever acted. Each rung fires at most once; off unless configured.
  if (position.mfeLadder && closeReturnPct > 0) {
    for (const step of position.mfeLadder) {
      if (position.ladderDone[step.atPct]) continue;
      if (closeReturnPct >= step.atPct) {
        position.ladderDone[step.atPct] = true;
        recordFill(position, step.fraction, bar.close, i, bar.date, 'mfe_ladder_partial');
        if (position.remaining <= 0.001) return { price: bar.close, reason: 'mfe_ladder' };
      }
    }
  }

  // Trajectory verdict, computed once and reused by both the profit and loss branches.
  const trajectory = position.trajectoryRule ? classifyTrajectory(position, candles, i) : null;
  // A trade whose first bars look sick gets closed at the next opportunity rather than
  // waiting for the trail's usual machinery — this is the "cut the bad handwriting early"
  // half of the policy split.
  if (trajectory === 'sick' && position.trajectoryRule.cutSick) {
    return { price: bar.close, reason: 'traj_sick' };
  }

  if (position.peakFavorablePct < position.trailMinPeakPct) return null;

  // First bar the trail arms (peak just crossed the noise threshold) — barsSinceArm below
  // is measured from here, same "arm point" the calibration used.
  if (!wasArmed) {
    position.armIndex = i;
    // RSI at the arming point is the baseline for the divergence check: comparing it with
    // RSI at the peak asks "did price keep extending while RSI weakened?" — computable
    // live, unlike the study's halfway-to-peak version which needs the peak known upfront.
    position.armRsi14 = computeIndicatorsAtEntry(candles, bar.date)?.rsi14 ?? null;
  }

  if (position.profitCaptureEnabled && closeReturnPct > 0) {
    const score = computeProfitCaptureScore(position, bar, candles, i, closeReturnPct,
      resolveScoreFavorable(position, closeReturnPct));
    // Research telemetry: what the score WOULD have been under each source, so a study can
    // count how many bars were exactly one point short purely because of the close/high gap.
    const scoreOnClose = onTrace ? computeProfitCaptureScore(position, bar, candles, i, closeReturnPct, null) : null;
    const scoreOnPeak = onTrace ? computeProfitCaptureScore(position, bar, candles, i, closeReturnPct, position.peakFavorablePct ?? closeReturnPct) : null;
    // Research telemetry only (null in normal use): every bar where the trade is in profit
    // and the score has been consulted. Lets a study compare the bars where the score
    // FIRES against the bars where it stays silent and the trade later decays into a loss
    // — i.e. what the score is failing to see. See scripts/decisionPointStudy.mjs.
    if (onTrace) {
      onTrace({
        entryIndex: position.entryIndex, barIndex: i, score, scoreOnClose, scoreOnPeak,
        closeReturnPct, peakPct: position.peakFavorablePct,
        confirmedPeakPct: position.confirmedPeakPct,
        threshold: position.profitCaptureThreshold,
        barsSinceArm: position.armIndex != null ? i - position.armIndex : null,
        direction: position.direction, date: bar.date,
      });
    }
    // SECOND-FIRE ASSIST (2026-09-04, trader's idea). Not a cut — the opposite: once the score
    // has already banked a slice, it has PROVEN it can read this trade, so make it easier for
    // it to speak again rather than deciding externally whether to exit. Motivated by the
    // firing-count table (0→-5.44%, 1→+0.95%, 2→+5.96%, ...): the money is in reaching a
    // SECOND firing, and every attempt this session to CUT the "fired once" cohort lost money.
    // Helping the same proven mechanism fire again is a different bet than judging it from
    // outside. Off unless configured; resets are not needed since profitCutsDone only grows.
    const effThreshold = (position.secondFireBonus != null && position.profitCutsDone >= 1)
      ? position.profitCaptureThreshold - position.secondFireBonus
      : position.profitCaptureThreshold;
    if (score != null && score >= effThreshold) {
      // Same scale-out option on the profit side: bank part at the score's signal and let
      // the rest ride, instead of betting the whole position on the score being right.
      // CONVICTION-SCALED EXIT: the score is not just a yes/no — a 6 is far more certain
      // than a bare 4. `profitCutByScore` maps the score to how much of the position to
      // bank, so a weak signal takes a slice and a strong one can close outright. Falls
      // back to the flat fraction when no map is given.
      const frac = position.profitCutByScore
        ? (position.profitCutByScore[Math.min(score, 8)] ?? position.profitCutFraction ?? 1)
        : (position.profitCutFraction ?? 1);
      if (frac >= 1) return { price: bar.close, reason: 'profit_score' };
      if (position.profitCutsDone < (position.profitCutMaxTimes ?? 1)) {
        position.profitCutsDone += 1;
        recordFill(position, frac, bar.close, i, bar.date, 'profit_score_partial');
        if (position.remaining <= 0.001) return { price: bar.close, reason: 'profit_score' };
        return null; // banked a slice this bar, let the remainder ride
      }
      // Scale-outs exhausted while part of the position is still open. Returning null here
      // would leave that remainder managed by NOTHING — it would ride until the emergency
      // stop or the end of history, holding the single slot and starving later entries.
      // (Measured before the fix: 640 trades instead of 2815 and -2.0 expectancy — an
      // artefact of the bug, not a property of scaling out.) Hand the remainder back to
      // the plain give-back rule below so it still has a trailing exit.
      position.profitCaptureExhausted = true;
    }
    // ORPHAN RULE (2026-08-31, trader's idea + measured gap). A trade whose peak was real but
    // whose profit score NEVER fired is currently managed by NOTHING while it bleeds back:
    // the give-back rule below is gated on profitCaptureExhausted, and a score that never
    // fired can never exhaust. So the whole path from +11% to zero happens unsupervised —
    // profit side silent (score under threshold), loss side not looking yet (still in profit).
    // Measured: 500 loss_score trades peaked at +10.97% on average and finished at +0.69%,
    // ≈51 млн₽ of the illustrative total. This rule watches exactly that state and nothing else.
    if (position.orphanRule && position.profitCutsDone === 0
      && position.peakFavorablePct >= position.orphanRule.minPeakPct) {
      const giveBack = position.peakFavorablePct * (1 - position.orphanRule.giveBackPct / 100);
      if (closeReturnPct <= giveBack) {
        const frac = position.orphanRule.fraction ?? 1;
        if (frac >= 1) return { price: bar.close, reason: 'orphan_giveback' };
        if (position.orphanCutsDone < (position.orphanRule.maxTimes ?? 1)) {
          position.orphanCutsDone += 1;
          recordFill(position, frac, bar.close, i, bar.date, 'orphan_giveback_partial');
          if (position.remaining <= 0.001) return { price: bar.close, reason: 'orphan_giveback' };
          return null;
        }
      }
    }

    // SAFETY NET (2026-08-23). Without this the branch returns null and the give-back rule
    // below is unreachable while in profit — so a trade that peaked at +10% can drift all
    // the way back to +0.01% with nothing firing, cross into the red, and get cut at a
    // LOSS by the underwater branch. Measured: 1245 of 2816 trades reached +2%+ and still
    // closed negative, averaging -4.61% while the market had offered +8.7%. That is the
    // single largest leak in the system, and it is a missing rule rather than a bad one.
    // Off unless configured, so existing strategies are unaffected until proven.
    if (position.profitGiveBackFallbackPct != null) {
      // Measured against the CONFIRMED peak (see above) when wick-filtering is on, so a
      // spike that never held can't arm this. Fill is always at the bar CLOSE — never at
      // the high — so the simulated exit price is one a human could actually have got.
      const refPeak = position.peakConfirmCloseFraction != null
        ? (position.confirmedPeakPct ?? 0)
        : position.peakFavorablePct;
      if (refPeak >= (position.profitFallbackMinPeakPct ?? 0)
        && closeReturnPct <= refPeak * (1 - position.profitGiveBackFallbackPct / 100)) {
        // Partial fixation instead of a full exit when a fraction is configured — the
        // trader's "bank part of it, let the rest run" idea applied to the peak give-back
        // specifically, which is where the biggest measured leak was (267 trades that
        // peaked 5%+ and closed at an average -7.26% with no fixation at all).
        const frac = position.profitGiveBackFraction ?? 1;
        if (frac >= 1) return { price: bar.close, reason: 'profit_giveback' };
        if (position.giveBackCutsDone < (position.profitGiveBackMaxTimes ?? 1)) {
          position.giveBackCutsDone += 1;
          recordFill(position, frac, bar.close, i, bar.date, 'profit_giveback_partial');
          if (position.remaining <= 0.001) return { price: bar.close, reason: 'profit_giveback' };
          return null;
        }
        return { price: bar.close, reason: 'profit_giveback' };
      }
    }
    // BREAKDOWN DETECTOR (2026-08-23). The give-back net above is blunt: it cuts healthy
    // trades and sick ones alike. The decision-point study (23405 points) showed the
    // profit score answers "is this move PEAKING?" — high score marks a HEALTHY trade
    // (15.7% leak rate at score>=3 vs 40.8% base), so it can never detect a breakdown.
    // These features do: price falling back through EMA13 against us (57.2% leak rate),
    // sitting low in the Bollinger range (57.9%), and a dead ADX (46.9%). Combined with
    // "we've already handed back a chunk of the peak", the pair hits 59.2%.
    // Requiring give-back AND a damage signal is what keeps a strong trend untouched.
    if (position.breakdownRule) {
      const cfg = position.breakdownRule;
      const givenBackShare = position.peakFavorablePct > 0
        ? (position.peakFavorablePct - closeReturnPct) / position.peakFavorablePct
        : 0;
      if (givenBackShare >= (cfg.minGiveBackShare ?? 0.4)
        && position.peakFavorablePct >= (cfg.minPeakPct ?? 0)) {
        const dirSign = direction === 'long' ? 1 : -1;
        const ind = computeIndicatorsAtEntry(candles, bar.date);
        if (ind) {
          let damage = 0, tested = 0;
          if (cfg.emaBreak) {
            tested += 1;
            const emaDist = ind.ema13Distance != null ? ind.ema13Distance * dirSign : null;
            if (emaDist != null && emaDist < (cfg.emaBreakBelow ?? 0)) damage += 1;
          }
          if (cfg.bollLow != null) {
            tested += 1;
            const pb = ind.bollinger?.percentB != null
              ? (dirSign === 1 ? ind.bollinger.percentB : 1 - ind.bollinger.percentB) : null;
            if (pb != null && pb < cfg.bollLow) damage += 1;
          }
          if (cfg.adxBelow != null) {
            tested += 1;
            if (ind.adx14 != null && ind.adx14 < cfg.adxBelow) damage += 1;
          }
          const need = cfg.mode === 'all' ? tested : (cfg.minSignals ?? 1);
          if (tested > 0 && damage >= need) {
            return { price: bar.close, reason: 'breakdown' };
          }
        }
      }
    }
    // Normally the score fully replaces the give-back rule while in profit. The one
    // exception is a remainder left over after the scale-outs ran out — see above.
    if (!position.profitCaptureExhausted) return null;
  }

  // DEAD-ZONE MODEL (2026-09-04). Single-feature signal ("still negative at bar N") was the
  // strongest AUC in the project (~0.80) but failed the money test on its own: cutting a
  // future +8.92% winner costs ~4x what cutting a future -5.71% loser early saves, so ~80%
  // accuracy is needed to break even and the raw feature alone only gets 68.5-76.9%. A
  // multivariate model (same recipe as peakModelRule) fit ONLY on the "still negative"
  // population pushed its top two deciles to 91-94% accuracy — scripts/deepDeadZoneModel.mjs
  // measured a positive EV there (+2.5..+2.6 п.п./trade) while deciles 4+ turn negative. Fires
  // ONCE, at the configured bar count, only while still non-positive — never re-evaluated.
  if (position.deadZoneRule && !position.deadZoneFired) {
    globalThis.__dzDiag ??= { atBarHit: 0, negAtBar: 0 };
    if (i - position.entryIndex === position.deadZoneRule.atBar) {
      globalThis.__dzDiag.atBarHit++;
      if (closeReturnPct <= 0) globalThis.__dzDiag.negAtBar++;
    }
  }
  if (position.deadZoneRule && !position.deadZoneFired && closeReturnPct <= 0
    && i - position.entryIndex === position.deadZoneRule.atBar) {
    position.deadZoneFired = true;
    const p = position.deadZoneRule.predict({ position, bar, candles, i, closeReturnPct, direction });
    if (p != null && p >= position.deadZoneRule.threshold) {
      const frac = position.deadZoneRule.fraction ?? 1;
      if (frac >= 1) return { price: bar.close, reason: 'dead_zone' };
      recordFill(position, frac, bar.close, i, bar.date, 'dead_zone_partial');
      if (position.remaining <= 0.001) return { price: bar.close, reason: 'dead_zone' };
    }
  }

  // Underwater branch. Real bug found 2026-08-20 by per-trade diagnostics: with
  // profitCaptureEnabled the block above only covers a trade that's IN PROFIT, so a trade
  // closing below entry fell straight through to the give-back rule below — and there
  // that rule is unconditionally true (closeReturnPct <= 0 is always <= a positive
  // fraction of a positive peak). The intended "give back 50% of the peak" silently
  // became "exit the moment price closes back at entry": 448 of 448 such exits closed at
  // a loss, none in profit, average -0.93% — while those same trades went on to offer
  // +9.7% on average. `trailLossRule` makes this an explicit, testable choice instead of
  // an accident:
  //   'breakeven' — the old accidental behaviour, kept only so it can be compared against
  //   'none'      — leave losses entirely to the blunt trailAdverse threshold
  //   'score'     — use the loss-dynamics score (see exitRules.lossNearBottomScore)
  if (closeReturnPct <= 0) {
    // The "give the good handwriting more room" half: a trade classified healthy skips the
    // loss-side cut entirely and is left to the blunt trailAdverse threshold.
    if (trajectory === 'healthy' && position.trajectoryRule.freeHealthy) return null;
    const rule = position.trailLossRule ?? 'breakeven';
    if (rule === 'none') return null;
    // Hold veto sits in front of every loss-side rule so any of them can be combined with
    // it — the sweep tests it both standalone and layered on 'breakeven'/'score'.
    if (shouldHoldThroughPullback(position)) return null;
    if (rule === 'score') {
      const s = computeLossScore(position, bar, candles, i, closeReturnPct);
      if (s == null) return null;
      // `lossScoreMode` picks which reading of the score triggers the cut — see the long
      // comment on lossNearBottomScore for why the original direction is suspect.
      // CROSS-SYSTEM LINK (2026-08-31, trader's idea). The two sides never talked to each
      // other: the loss side closes a remainder near zero knowing nothing about the profit
      // side having already VALIDATED this trade. Measured: 128 trades where the score fired
      // exactly once peaked at +11.35%, and 80% of them then died via loss_score at +0.95%.
      // `lossAfterProfitFire` makes the loss side demand more evidence once the profit system
      // has spoken. Off unless configured.
      const link = position.lossAfterProfitFire;
      const firedBefore = position.profitCutsDone > 0;
      const effThreshold = (link && firedBefore)
        ? position.lossScoreThreshold + (link.thresholdBonus ?? 0)
        : position.lossScoreThreshold;
      const cut = position.lossScoreMode === 'nearBottom'
        ? s >= effThreshold                     // original п.23 reading
        : s <= effThreshold;                    // "no bottom in sight, still worsening"
      // `lossCutFraction` < 1 scales OUT instead of closing: bank part now, leave the rest
      // to the trail. Fires at most `lossCutMaxTimes` so a chopping market can't shave the
      // position to nothing one slice at a time.
      if (!cut) return null;
      let frac = position.lossCutByScore
        ? (position.lossCutByScore[Math.min(Math.max(s, 0), 8)] ?? position.lossCutFraction ?? 1)
        : (position.lossCutFraction ?? 1);
      // Second half of the cross-system link: take a SMALLER slice out of a trade the profit
      // system already validated, instead of the same slice as out of one it never liked.
      if (link && firedBefore && link.fractionScale != null) frac = frac * link.fractionScale;
      if (frac >= 1) return { price: bar.close, reason: 'loss_score' };
      // Same reasoning as the profit side: once the scale-outs are used up, close the
      // remainder rather than leaving it unmanaged until the emergency stop.
      if (position.lossCutsDone >= (position.lossCutMaxTimes ?? 1)) {
        return { price: bar.close, reason: 'loss_score' };
      }
      position.lossCutsDone += 1;
      recordFill(position, frac, bar.close, i, bar.date, 'loss_score_partial');
      return position.remaining <= 0.001 ? { price: bar.close, reason: 'loss_score' } : null;
    }
    if (rule === 'peakAge') {
      // Trader's finding: a peak that took 10+ bars to form is more likely a real trend
      // pausing than one that spiked in 1-3 bars and immediately exhausted itself. When
      // that's true (and RSI wasn't already overbought/oversold AT the peak), skip the
      // score cut and let the blunt trailAdverse threshold be the only exit — i.e. give
      // it more room. Otherwise fall back to the normal score rule.
      const barsToPeak = position.peakBarIndex != null ? position.peakBarIndex - position.entryIndex : 0;
      const slowMature = barsToPeak >= position.peakAgeMinBars
        && (position.peakRsi14 == null || position.peakRsi14 < position.peakAgeRsiMax);
      if (slowMature) return null;
      const s = computeLossScore(position, bar, candles, i, closeReturnPct);
      if (s == null) return null;
      const cut = position.lossScoreMode === 'nearBottom'
        ? s >= position.lossScoreThreshold
        : s <= position.lossScoreThreshold;
      return cut ? { price: bar.close, reason: 'loss_score' } : null;
    }
    // 'breakeven' falls through to the give-back comparison below, which in this branch
    // always fires — that IS the old behaviour, reproduced deliberately.
  }

  const keepFraction = 1 - position.trailGiveBackPct / 100;
  if (closeReturnPct <= position.peakFavorablePct * keepFraction) {
    return { price: bar.close, reason: 'trail' };
  }
  return null;
}

export function buildLossScoreCtx(position, bar, candles, i, closeReturnPct) {
  const dirSign = position.direction === 'long' ? 1 : -1;
  const ind = computeIndicatorsAtEntry(candles, bar.date);
  if (!ind || ind.rsi14 == null) return null;
  // Signed so "against us" is positive regardless of long/short.
  const ema21Against = ind.ema13Distance != null ? -ind.ema13Distance * dirSign : null;
  const farBand = ind.bollinger?.percentB != null
    && (dirSign === 1 ? ind.bollinger.percentB < 0.15 : ind.bollinger.percentB > 0.85);
  // "Candles slowed": last 3 bars barely moved compared with the instrument's own ATR.
  let candlesSlowed = false;
  if (i >= 3 && ind.atr14) {
    const recent = candles.slice(i - 2, i + 1);
    const avgRange = recent.reduce((s, c) => s + (c.high - c.low), 0) / recent.length;
    candlesSlowed = avgRange < ind.atr14 * 0.6;
  }
  return { dirSign, ctx: {
    currentRsi14: ind.rsi14,
    rsiChangeAgainst: position.entryRsi14 != null ? (ind.rsi14 - position.entryRsi14) * dirSign : null,
    ema21DistanceAgainstPct: ema21Against,
    bollingerFarBand: farBand,
    currentLossPct: -closeReturnPct,
    barsHeld: position.barsHeld,
    candlesSlowed,
  } };
}

export function computeLossScore(position, bar, candles, i, closeReturnPct) {
  const built = buildLossScoreCtx(position, bar, candles, i, closeReturnPct);
  if (!built) return null;
  return lossNearBottomScore(built.dirSign, built.ctx, lossScoreCfg(position));
}

export function computeLossBreakdown(position, bar, candles, i, closeReturnPct) {
  const built = buildLossScoreCtx(position, bar, candles, i, closeReturnPct);
  if (!built) return null;
  return lossNearBottomBreakdown(built.dirSign, built.ctx, lossScoreCfg(position));
}

// PARTIAL EXITS (2026-08-24, trader's idea). Every one of the 89 exit variants tested so
// far was binary — cut or hold — and every one died on the same symmetry: a signal that
// saves 59 losers destroys 41 winners, and the trade cancels out. Scaling out breaks that
// symmetry: banking part of the position at a warning keeps the rest working, so the rule
// no longer has to be RIGHT, only better than a coin flip. `fills` records every partial
// close; the trade's pnlPct is their fraction-weighted sum, so downstream stats
// (calcStats, equity curves) keep working unchanged on a single number per trade.
function recordFill(position, fraction, price, index, date, reason) {
  const take = Math.min(fraction, position.remaining);
  if (take <= 0) return;
  position.fills.push({ fraction: take, price, index, date, reason });
  position.remaining -= take;
}

function finalizeTrade(position, exitIndex, exitDate, exitPrice, exitReason) {
  const sign = position.direction === 'long' ? 1 : -1;
  // Close whatever is still open at the final price, then average every fill by weight.
  recordFill(position, position.remaining, exitPrice, exitIndex, exitDate, exitReason);
  const pnlPct = position.fills.reduce(
    (s, f) => s + f.fraction * (((f.price - position.entryPrice) * sign) / position.entryPrice) * 100, 0);
  const pnlPoints = (pnlPct / 100) * position.entryPrice;
  // Real ruble P&L, only when the caller asked for risk-based sizing (see sizePosition
  // above) — null otherwise, so callers that don't care about this can keep using pnlPct
  // exactly as before, untouched.
  const pnlRub = position.sizing ? pnlPoints * position.sizing.contracts * position.sizing.rubPerPoint - position.sizing.commission : null;
  return {
    direction: position.direction,
    entryIndex: position.entryIndex, entryDate: position.entryDate, entryPrice: position.entryPrice,
    entryPercent: position.entryPercent,
    exitIndex, exitDate, exitPrice, exitReason,
    barsHeld: position.barsHeld,
    fills: position.fills,
    peakFavorablePct: position.peakFavorablePct,
    pnlPoints, pnlPct,
    pnlRub, contracts: position.sizing?.contracts ?? null,
    status: 'closed',
    pnl: pnlPct, // calcStats() only needs a numeric `pnl` + `date` + status:'closed' — we
    // feed it % return per trade by default (no real position sizing unless riskSizing
    // was given), so profit factor / win-loss averages come out scale-invariant and
    // honest without pretending we've modeled contract size or ruble risk.
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
 * @param {object} params.strategy - one saved strategy (conditions, customConditions, readinessThreshold, exitRules — see exitRules.js).
 * @param {number|null} [params.timeframeMinutes] - gates swing-pattern detectors, same as the live app.
 * @param {object} [params.exitRules] - overrides strategy.exitRules for this run (see services/analytics/exitRules.js:defaultExitRules) — lets the Бэктест page experiment without saving.
 * @param {boolean} [params.exitRules.onSignalLoss] - exit when the strategy's own readiness % drops below its threshold.
 * @param {number|null} [params.exitRules.maxBars] - exit after N bars regardless of anything else.
 * @param {number} [params.warmupBars]
 * @param {object} [params.riskSizing] - real position sizing (real user request — "зачем
 *   придумывать, если это уже в стратегии указано"). When given, each trade also gets a
 *   real pnlRub computed via the same calcTrade() the Calculator uses for a live trade,
 *   using the trader's OWN max_risk_percent/max_margin_usage strategy settings — not a
 *   separate invented number. Trades whose stop type is 'none' (no risk distance to size
 *   against) get pnlRub: null, same as when riskSizing isn't given at all.
 * @param {number} [params.riskSizing.depositSize]
 * @param {number} [params.riskSizing.riskPercent]
 * @param {number} [params.riskSizing.maxMarginPercent]
 * @param {'future'|'stock'} [params.riskSizing.instrumentType]
 * @param {number} [params.riskSizing.lot]
 * @param {number} [params.riskSizing.minStep]
 * @param {number} [params.riskSizing.minStepAmount]
 * @param {number} [params.riskSizing.initialMargin]
 * @param {number} [params.riskSizing.commissionRate]
 * @param {function} [params.entryFilter] - ({ index, direction, candles }) => boolean.
 *   Veto on a qualifying signal, checked per direction, where `index` is the SIGNAL bar
 *   (entry executes at candles[index + 1].open). Unlike marketRegimeFilter — which only
 *   ever blocks longs — this gates both directions, so it can express entry-quality rules
 *   like "only take this when price is near its recent high". Returning false skips the
 *   signal entirely; the slot stays free for the next one.
 * @returns {{ trades: object[], hadCustomConditions: boolean, barsEvaluated: number, ambiguousBars: number }}
 */
/**
 * Собирает объект позиции — весь набор состояния и настроек, с которым дальше работает
 * updateTrailAndCheckExit. Вынесено из runBacktest наружу, чтобы «Сопровождение» могло
 * прогонять ЖИВУЮ сделку тем же кодом, а не заводить вторую реализацию правил выхода.
 * Поведение бэктеста при этом не меняется: runBacktest вызывает ровно эту же фабрику.
 */
export function createPosition({
  direction, entryIndex, entryDate, entryPrice, entryPercent = null,
  stopPrice = null, takePrice = null, rules = {}, riskSizing = null,
  entryRsi14 = null, drivingPattern = null, atr = null,
}) {
  return {
    direction, entryIndex, entryDate, entryPrice, entryPercent,
    stopPrice, takePrice, barsHeld: 0,
    signalExitEnabled: !!rules.signalExitEnabled,
    entryRsi14,
    sizing: sizePosition(entryPrice, stopPrice, riskSizing),
    trailEnabled: !!rules.trailEnabled,
    trailGiveBackPct: resolveTrailGiveBackPct(rules, drivingPattern),
    trailMinPeakPct: resolveTrailMinPeakPct(rules, entryPrice, atr),
      peakFavorablePct: 0,
      trailAdverseEnabled: !!rules.trailEnabled && rules.trailAdverseEnabled !== false,
      trailAdverseThresholdPct: resolveTrailAdverseThresholdPct(rules, entryPrice, atr),
      profitCaptureEnabled: !!rules.profitCaptureEnabled,
      profitCaptureThreshold: rules.profitCaptureThreshold ?? 2,
      // Пороги по барам внутри профит-/лосс-score — по умолчанию исходные дневные
      // значения (15/2 и 10/2). Калибровка под H1 (2026-09-10) передаёт свои через
      // rules, не трогая формулы в exitRules.js и не меняя поведение старых стратегий.
      profitArmBars: rules.profitArmBars ?? 15,
      profitTooEarlyArmBars: rules.profitTooEarlyArmBars ?? 2,
      lossHeldBars: rules.lossHeldBars ?? 10,
      lossTooEarlyHeldBars: rules.lossTooEarlyHeldBars ?? 2,
      secondFireBonus: rules.secondFireBonus ?? null,
      // Loss-side handling — see updateTrailAndCheckExit's underwater branch. Defaults to
      // 'breakeven' so existing saved strategies keep behaving exactly as before until a
      // better rule is proven and made the default deliberately.
      trailLossRule: rules.trailLossRule ?? 'breakeven',
      lossScoreMode: rules.lossScoreMode ?? 'worsening',
      lossScoreThreshold: rules.lossScoreThreshold ?? 0,
      armIndex: null,
      // Trader's finding 2026-08-22 (study on 1274 "recovered then lost" trades): how
      // LONG it took to reach the peak predicts whether holding through the pullback
      // would have paid off (10+ bars to peak: 47% eventually reach +10%, vs 8-10% for a
      // fast 1-10 bar spike). peakBarIndex/peakRsi14 captured the first time the peak
      // updates each bar — see updateTrailAndCheckExit — so 'peakAge' below can use them.
      peakBarIndex: null,
      peakRsi14: null,
      peakBollPercentB: null,
      peakVolSpike: null,
      peakVolTrend: null,
      armRsi14: null,
      // Params for trailLossRule: 'peakAge' (the first, narrower version of this idea).
      peakAgeMinBars: rules.peakAgeMinBars ?? 10,
      peakAgeRsiMax: rules.peakAgeRsiMax ?? 50,
      // General continuation-evidence veto — see shouldHoldThroughPullback. Off unless
      // the caller supplies a config, so saved strategies are unaffected.
      holdRule: rules.holdRule ?? null,
      // Profit-side safety net — see the branch in updateTrailAndCheckExit.
      profitGiveBackFallbackPct: rules.profitGiveBackFallbackPct ?? null,
      profitFallbackMinPeakPct: rules.profitFallbackMinPeakPct ?? null,
      profitGiveBackFraction: rules.profitGiveBackFraction ?? 1,
      profitGiveBackMaxTimes: rules.profitGiveBackMaxTimes ?? 1,
      giveBackCutsDone: 0,
      peakConfirmCloseFraction: rules.peakConfirmCloseFraction ?? null,
      confirmedPeakPct: 0,
      profitScoreFavorableSource: rules.profitScoreFavorableSource ?? 'close',
      breakdownRule: rules.breakdownRule ?? null,
      trajectoryRule: rules.trajectoryRule ?? null,
      worstAdversePct: 0,
      earlyMaeCutBars: rules.earlyMaeCutBars ?? null, earlyMaeCutThresholdPct: rules.earlyMaeCutThresholdPct ?? null,
      // Scale-out state — see recordFill. remaining=1 means the full position is open.
      fills: [], remaining: 1,
      lossCutFraction: rules.lossCutFraction ?? 1, lossCutMaxTimes: rules.lossCutMaxTimes ?? 1, lossCutsDone: 0,
      profitCutFraction: rules.profitCutFraction ?? 1, profitCutMaxTimes: rules.profitCutMaxTimes ?? 1, profitCutsDone: 0,
      profitCutByScore: rules.profitCutByScore ?? null, lossCutByScore: rules.lossCutByScore ?? null,
      // MFE ladder — see the branch in updateTrailAndCheckExit. Sorted ascending so a bar
      // that jumps past several rungs at once fires them in order, smallest first.
      mfeLadder: rules.mfeLadder ? [...rules.mfeLadder].sort((a, b) => a.atPct - b.atPct) : null,
      ladderDone: {},
      // Orphan rule + cross-system link — see their branches in updateTrailAndCheckExit.
      orphanRule: rules.orphanRule ?? null,
      orphanCutsDone: 0,
      lossAfterProfitFire: rules.lossAfterProfitFire ?? null,
      // Peak model — see its branch in updateTrailAndCheckExit. `predict` is the caller's.
      peakModelRule: rules.peakModelRule ?? null,
      modelCutsDone: 0,
      // Dead-zone model — see its branch in updateTrailAndCheckExit.
      deadZoneRule: rules.deadZoneRule ?? null,
      deadZoneFired: false,
  };
}

export function runBacktest({
  candles,
  strategy,
  timeframeMinutes = null,
  exitRules = null, // defaults to strategy.exitRules if not given an explicit override
  warmupBars = DEFAULT_WARMUP_BARS,
  riskSizing = null,
  marketRegimeFilter = null, // (date) => true|false|null — see buildMarketRegimeFilter
  entryFilter = null,        // ({ index, direction, candles }) => boolean — see above
  onTrace = null,            // research telemetry, see the profit branch of updateTrailAndCheckExit
}) {
  const { strategy: backtestStrategy, hadCustom } = stripCustomConditions(strategy);
  const threshold = backtestStrategy.readinessThreshold ?? 60;
  const rules = exitRules || strategy.exitRules || {};
  const { onSignalLoss = false, maxBars = null } = rules;

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

      // Post-entry indicator dynamics ("откат vs разворот", trader's idea 2026-08-14,
      // validated on D1+H1 holdout — see exitRules.js isConfirmedReversal). Checked before
      // the blunt trailAdverse fallback so it can fire EARLIER when the strongest
      // confirmed combo (RSI dropped sharply + price below EMA100/200) is already present,
      // rather than waiting for the cruder ×3 threshold. Gated on the same noise-unit
      // (`trailMinPeakPct`) used to arm the favorable trail — matches exactly how the
      // calibration script measured it (only evaluated once genuine noise is exceeded).
      if (position.signalExitEnabled) {
        const closeReturnPct = position.direction === 'long'
          ? ((bar.close - position.entryPrice) / position.entryPrice) * 100
          : ((position.entryPrice - bar.close) / position.entryPrice) * 100;
        if (-closeReturnPct >= position.trailMinPeakPct) {
          const nowIndicators = computeIndicatorsAtEntry(candles, bar.date);
          const dirSign = position.direction === 'long' ? 1 : -1;
          if (isConfirmedReversal(dirSign, position.entryRsi14, nowIndicators?.rsi14, nowIndicators?.ema100Distance, nowIndicators?.ema200Distance)) {
            trades.push(finalizeTrade(position, i, bar.date, bar.close, 'signal_reversal'));
            position = null;
            continue;
          }
        }
      }

      // Checked AFTER stop/take so a hard stop still wins on the same bar — the trail is
      // meant to bank a fading move, never to override the trader's own risk limit.
      if (position.trailEnabled) {
        const trailExit = updateTrailAndCheckExit(position, bar, candles, i, onTrace);
        if (trailExit) {
          trades.push(finalizeTrade(position, i, bar.date, trailExit.price, trailExit.reason));
          position = null;
          continue;
        }
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
    const marketBearish = marketRegimeFilter ? marketRegimeFilter(bar.date) === true : false;
    const allowLong = entryFilter ? entryFilter({ index: i, direction: 'long', candles }) !== false : true;
    const allowShort = entryFilter ? entryFilter({ index: i, direction: 'short', candles }) !== false : true;
    const qualifiesLong = long.total > 0 && long.pct >= threshold && !marketBearish && allowLong;
    const qualifiesShort = short.total > 0 && short.pct >= threshold && allowShort;

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
    const priceCtx = { atr: baseCtx.indicators.atr14 ?? null, patterns: baseCtx.patterns };
    const stopPrice = computeStopPrice(direction, entryPrice, rules, priceCtx);
    const takePrice = computeTakePrice(direction, entryPrice, rules, priceCtx);
    // Which pattern (if any) is behind this entry — only used to pick a per-pattern trail
    // give-back when the trader opted into that. Highest-confidence confirmed candidate,
    // matching how `pattern_confirmed` picks the one it reports.
    const drivingPattern = baseCtx.patterns?.candidates
      ?.find((c) => c.status !== 'forming')?.pattern ?? null;
    position = createPosition({
      direction, entryIndex: i + 1, entryDate: nextBar.date, entryPrice, entryPercent,
      stopPrice, takePrice, rules, riskSizing,
      entryRsi14: baseCtx.indicators.rsi14 ?? null,
      drivingPattern, atr: priceCtx.atr,
    });
  }

  // A position still open when history runs out isn't a loss or a win — it's simply
  // unfinished. Closed at the last candle's close purely so the trader can see it on the
  // chart/list; excluded from calcStats by tagging status 'open' instead of 'closed'.
  if (position) {
    const last = candles[n - 1];
    const sign = position.direction === 'long' ? 1 : -1;
    const pnlPoints = (last.close - position.entryPrice) * sign;
    const pnlRub = position.sizing ? pnlPoints * position.sizing.contracts * position.sizing.rubPerPoint - position.sizing.commission : null;
    trades.push({
      direction: position.direction,
      entryIndex: position.entryIndex, entryDate: position.entryDate, entryPrice: position.entryPrice,
      entryPercent: position.entryPercent,
      exitIndex: n - 1, exitDate: last.date, exitPrice: last.close, exitReason: 'end_of_data',
      barsHeld: position.barsHeld,
      pnlPoints, pnlPct: (pnlPoints / position.entryPrice) * 100,
      pnlRub, contracts: position.sizing?.contracts ?? null,
      status: 'open',
    });
  }

  return { trades, hadCustomConditions: hadCustom, barsEvaluated, ambiguousBars };
}
