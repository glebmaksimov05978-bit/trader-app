// src/services/backtest/livePosition.js
//
// Состояние ЖИВОЙ сделки, посчитанное тем же кодом, что и бэктест. Никакой второй
// реализации правил выхода: берём createPosition + updateTrailAndCheckExit из engine.js
// и прогоняем по ним свежие свечи от бара входа до текущего.
//
// Две линии, о которых договорились:
//   • 'actual' — остаток и число фиксаций берутся из РЕАЛЬНЫХ операций трейдера
//     (из Т-Банка или введённых руками). Совет всегда относится к позиции, которая
//     действительно есть.
//   • 'shadow' — движок живёт сам по себе, как если бы трейдер выполнял все его сигналы.
//     Разница между линиями и есть цена принятых вручную решений.
import {
  createPosition,
  updateTrailAndCheckExit,
  checkIntrabarExit,
  computeProfitCaptureScore,
  computeLossScore,
} from './engine';

function returnPct(direction, entryPrice, price) {
  return direction === 'long'
    ? ((price - entryPrice) / entryPrice) * 100
    : ((entryPrice - price) / entryPrice) * 100;
}

/**
 * Прогоняет сделку по барам и возвращает её состояние на последнем баре.
 *
 * @param {object}  a
 * @param {Array}   a.candles      - свечи того же таймфрейма, на котором ведётся сделка
 * @param {number}  a.entryIndex   - индекс бара входа в этом массиве
 * @param {string}  a.direction    - 'long' | 'short'
 * @param {number}  a.entryPrice
 * @param {object}  a.rules        - exitRules активной стратегии (те же, что в бэктесте)
 * @param {number|null} [a.stopPrice]
 * @param {number|null} [a.takePrice]
 * @param {number|null} [a.entryRsi14]
 * @param {number|null} [a.atr]    - ATR на входе (нужен ATR-порогам трейлинга)
 * @param {Array}  [a.actualFills] - реальные фиксации: [{ index, fraction }], fraction 0..1
 * @param {'actual'|'shadow'} [a.mode]
 */
export function computeLiveState({
  candles, entryIndex, direction, entryPrice, rules = {},
  stopPrice = null, takePrice = null, entryRsi14 = null, atr = null,
  actualFills = null, mode = 'actual',
}) {
  if (!Array.isArray(candles) || candles.length === 0) throw new Error('Нет свечей');
  if (entryIndex == null || entryIndex < 0 || entryIndex >= candles.length) {
    throw new Error('Бар входа вне диапазона свечей');
  }

  const position = createPosition({
    direction, entryIndex, entryDate: candles[entryIndex].date, entryPrice,
    rules, stopPrice, takePrice, entryRsi14, atr,
  });

  const trace = [];   // по бару: что видел движок
  const fired = [];   // срабатывания правил (в режиме shadow — реальные, в actual — предложения)
  let exit = null;    // если движок закрыл бы позицию целиком

  const pending = mode === 'actual' && Array.isArray(actualFills)
    ? [...actualFills].sort((x, y) => x.index - y.index)
    : [];
  let applied = 0;

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const bar = candles[i];
    position.barsHeld += 1;

    const intrabar = checkIntrabarExit(position, bar);
    if (intrabar) { exit = { index: i, ...intrabar }; break; }

    const before = { remaining: position.remaining, profitCutsDone: position.profitCutsDone };
    const closeReturnPct = returnPct(direction, entryPrice, bar.close);
    const res = position.trailEnabled
      ? updateTrailAndCheckExit(position, bar, candles, i)
      : null;

    if (position.profitCutsDone > before.profitCutsDone || (res && res.reason)) {
      fired.push({
        index: i, date: bar.date, price: bar.close,
        reason: res?.reason ?? 'profit_score_partial',
        fraction: Math.max(0, before.remaining - position.remaining),
      });
    }

    trace.push({
      index: i, date: bar.date, close: bar.close, returnPct: closeReturnPct,
      peakPct: position.peakFavorablePct ?? 0,
      profitScore: computeProfitCaptureScore(position, bar, candles, i, closeReturnPct),
      lossScore: closeReturnPct < 0 ? computeLossScore(position, bar, candles, i, closeReturnPct) : null,
      remaining: position.remaining,
    });

    if (res) { exit = { index: i, ...res }; break; }

    // В режиме «как есть» реальность важнее прогноза: остаток и счётчик фиксаций
    // приводятся к тому, что трейдер действительно сделал на этом баре.
    while (applied < pending.length && pending[applied].index <= i) {
      const f = pending[applied++];
      position.remaining = Math.max(0, position.remaining - f.fraction);
      position.profitCutsDone += 1;
    }
  }

  const last = candles[candles.length - 1];
  const currentPct = returnPct(direction, entryPrice, last.close);

  // Куда идёт цена прямо сейчас — по трём последним барам в сторону сделки. Нужно, чтобы
  // уведомление говорило человеческим языком «пока ещё растёт» или «уже разворачивается»,
  // а не только сухие цифры.
  const lookback = candles.slice(-4);
  let momentum = null;
  if (lookback.length >= 2) {
    const change = returnPct(direction, lookback[0].close, last.close);
    momentum = {
      changePct: change,
      label: change > 0.15 ? 'идёт в нашу сторону'
        : change < -0.15 ? 'разворачивается против нас'
          : 'стоит на месте',
      bars: lookback.length - 1,
    };
  }

  return {
    position,
    mode,
    exit,                                   // null — сделка по мнению движка ещё жива
    fired,                                  // где сработали правила
    trace,                                  // побарная телеметрия для графика
    barsHeld: position.barsHeld,
    peakPct: position.peakFavorablePct ?? 0,
    givebackPct: (position.peakFavorablePct ?? 0) - currentPct,
    currentPct,
    momentum,
    price: last.close,
    remaining: position.remaining,
    profitCutsDone: position.profitCutsDone,
    // Когорта из исследования: сколько раз сработала профит-система.
    cohort: position.profitCutsDone >= 2 ? '2+' : String(position.profitCutsDone),
    // Что движок думает прямо сейчас, на последнем баре.
    now: trace.length ? trace[trace.length - 1] : null,
  };
}

/**
 * Обе линии сразу: реальная и теневая. Разница в процентах — цена ручных решений.
 */
export function computeBothLines(args) {
  const actual = computeLiveState({ ...args, mode: 'actual' });
  const shadow = computeLiveState({ ...args, mode: 'shadow', actualFills: null });
  return { actual, shadow, deltaPct: actual.currentPct - shadow.currentPct };
}
