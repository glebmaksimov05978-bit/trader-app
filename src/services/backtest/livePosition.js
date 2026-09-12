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
  let wouldExit = null; // в режиме actual: где движок вышел бы, хотя сделка ещё открыта

  const isActual = mode === 'actual';
  const pending = isActual && Array.isArray(actualFills)
    ? [...actualFills].sort((x, y) => x.index - y.index)
    : [];
  let applied = 0;
  // Зафиксированные куски с ценами — нужны, чтобы посчитать ИТОГ линии, а не только
  // текущее движение цены. Для «как есть» их наполняют реальные операции трейдера,
  // для теневой — собственные фиксации движка (position.fills).
  const realizedFills = [];

  for (let i = entryIndex + 1; i < candles.length; i++) {
    const bar = candles[i];
    position.barsHeld += 1;

    // Сработавший стоп/тейк закрывает позицию только в теневой линии. В линии «как есть»
    // сделка открыта до тех пор, пока трейдер сам её не закрыл в Журнале: приложение не
    // вправе объявить её закрытой за него — оно только отмечает, где это произошло бы.
    const intrabar = checkIntrabarExit(position, bar);
    if (intrabar) {
      if (!isActual) { exit = { index: i, ...intrabar }; break; }
      if (!wouldExit) wouldExit = { index: i, ...intrabar };
    }

    const before = {
      remaining: position.remaining,
      profitCutsDone: position.profitCutsDone,
      lossCutsDone: position.lossCutsDone,
      fillsLen: position.fills.length,
    };
    const closeReturnPct = returnPct(direction, entryPrice, bar.close);
    const res = position.trailEnabled
      ? updateTrailAndCheckExit(position, bar, candles, i)
      : null;

    if (position.profitCutsDone > before.profitCutsDone || (res && res.reason)) {
      fired.push({
        index: i, date: bar.date, price: bar.close,
        reason: res?.reason ?? 'profit_score_partial',
        fraction: Math.max(0, before.remaining - position.remaining),
        // В линии «как есть» это ПРЕДЛОЖЕНИЕ движка, а не свершившийся факт.
        suggested: isActual,
      });
    }

    // ГЛАВНОЕ отличие линии «как есть»: движок здесь только СМОТРИТ. Раньше он делал свои
    // частичные фиксации прямо в этой позиции — и вкладка показывала трейдеру «когорта: 2
    // фиксации», «в рынке 50%», хотя он не фиксировал ничего (реальная жалоба: «я нигде не
    // фиксировал, а система пишет, что зафиксировал»). Состояние трейлинга (пик, момент
    // взведения) при этом сохраняем — оно нужно, чтобы счёт на текущем баре был живым.
    if (isActual) {
      position.remaining = before.remaining;
      position.profitCutsDone = before.profitCutsDone;
      position.lossCutsDone = before.lossCutsDone;
      position.fills.length = before.fillsLen;
    }

    trace.push({
      index: i, date: bar.date, close: bar.close, returnPct: closeReturnPct,
      peakPct: position.peakFavorablePct ?? 0,
      profitScore: computeProfitCaptureScore(position, bar, candles, i, closeReturnPct),
      lossScore: closeReturnPct < 0 ? computeLossScore(position, bar, candles, i, closeReturnPct) : null,
      remaining: position.remaining,
    });

    if (res) {
      // Тот же принцип, что со стопом: теневая линия закрывается, реальная — идёт дальше
      // до последнего бара, иначе панели показывали бы счёт на старом баре и выглядели
      // бы «зависшими» (жалоба: «ничего не пересчитывается»).
      if (!isActual) { exit = { index: i, ...res }; break; }
      if (!wouldExit) wouldExit = { index: i, ...res };
    }

    // Реальные фиксации трейдера — единственное, что меняет остаток в линии «как есть».
    while (applied < pending.length && pending[applied].index <= i) {
      const f = pending[applied++];
      const take = Math.min(f.fraction, position.remaining);
      position.remaining = Math.max(0, position.remaining - f.fraction);
      position.profitCutsDone += 1;
      if (take > 0) realizedFills.push({ fraction: take, price: f.price ?? bar.close });
    }
  }

  const last = candles[candles.length - 1];
  const currentPct = returnPct(direction, entryPrice, last.close);

  // ИТОГ линии, а не просто движение цены. Раньше обе линии показывали одно и то же
  // число — цену последнего бара, — поэтому «Система» и «Факт · ты» всегда совпадали,
  // даже когда движок вышел бы намного раньше и с другим результатом. Теперь каждая
  // линия считается по своим фиксациям: закрытые куски по своим ценам плюс остаток по
  // текущей (а для вышедшей теневой линии — по цене её выхода).
  const closedParts = isActual ? realizedFills : (position.fills || []);
  const restPrice = exit ? exit.price : last.close;
  const resultPct = closedParts.reduce(
    (sum, f) => sum + f.fraction * returnPct(direction, entryPrice, f.price), 0,
  ) + position.remaining * returnPct(direction, entryPrice, restPrice);

  // Куда идёт цена прямо сейчас — по трём последним барам в сторону сделки. Нужно, чтобы
  // уведомление говорило человеческим языком «пока ещё растёт» или «уже разворачивается»,
  // а не только сухие цифры. ВАЖНО: не дальше бара входа — раньше брались последние 4 бара
  // ВСЕЙ загруженной истории, включая свечи ДО входа в сделку. На свежей позиции (например,
  // держим всего 1 бар) это писало «разворачивается против нас за 3 бара», хотя эти три
  // бара были ещё ДО того, как сделка вообще открылась (реальная жалоба: «наверху написано
  // держим 1 бар, а тут почему-то 3»).
  const lookback = candles.slice(Math.max(entryIndex, candles.length - 4));
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
    wouldExit,                              // actual: где движок вышел бы, но сделка открыта
    fired,                                  // где сработали правила
    trace,                                  // побарная телеметрия для графика
    barsHeld: position.barsHeld,
    peakPct: position.peakFavorablePct ?? 0,
    givebackPct: (position.peakFavorablePct ?? 0) - currentPct,
    currentPct,                             // движение цены от входа к последнему бару
    resultPct,                              // итог линии с учётом её собственных фиксаций
    realizedFills: closedParts,
    momentum,
    price: last.close,
    remaining: position.remaining,
    profitCutsDone: position.profitCutsDone,
    // Когорта из исследования: сколько раз сработала профит-система.
    cohort: position.profitCutsDone >= 2 ? '2+' : String(position.profitCutsDone),
    // Что движок думает прямо сейчас, на последнем баре. Сразу после входа, пока не
    // прошло ни одного нового бара (entryIndex — последняя свеча), trace пуст — но счёт
    // всё равно есть, просто нулевой на старте. Раньше в этот момент показывался прочерк
    // вместо «0 из 4» (реальная жалоба: «цифры нет, как будто тире»).
    now: trace.length ? trace[trace.length - 1] : {
      index: entryIndex, date: candles[entryIndex].date, close: last.close, returnPct: currentPct,
      peakPct: 0,
      profitScore: computeProfitCaptureScore(position, candles[entryIndex], candles, entryIndex, currentPct),
      // Как и в основном цикле выше: лосс-система вообще не считается, пока сделка не в
      // минусе — прочерк здесь означает "пока не актуально", а не "не посчитали". Но если
      // сделка ушла в минус ПРЯМО на баре входа (проскальзывание), считаем и здесь, а не
      // только в основном цикле — тот же баг с прочерком, только для лосс-системы.
      lossScore: currentPct < 0 ? computeLossScore(position, candles[entryIndex], candles, entryIndex, currentPct) : null,
      remaining: position.remaining,
    },
  };
}

/**
 * Обе линии сразу: реальная и теневая. Разница в процентах — цена ручных решений.
 */
export function computeBothLines(args) {
  const actual = computeLiveState({ ...args, mode: 'actual' });
  const shadow = computeLiveState({ ...args, mode: 'shadow', actualFills: null });
  // Сравниваем ИТОГИ линий, а не текущую цену: цена последнего бара у обеих одна и та же,
  // и на ней расхождение всегда выходило нулевым («решения совпали»), даже когда движок
  // вышел бы раньше и с совсем другим результатом.
  return { actual, shadow, deltaPct: actual.resultPct - shadow.resultPct };
}
