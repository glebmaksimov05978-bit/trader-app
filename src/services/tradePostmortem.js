// src/services/tradePostmortem.js
//
// «Разбор» закрытой сделки: какой у неё был лучший момент, сколько от него отдано,
// сколько раз фиксировали часть и что на её месте сделал бы движок.
//
// Зачем отдельно и почему считается ОДИН раз при закрытии, а не на лету:
// восемь существующих детекторов в «Что стоит вам денег» работают мгновенно — это
// чистая арифметика по полям журнала. Новые выводы (отдача от пика, когорты по числу
// фиксаций, расхождение с системой) требуют проиграть сделку по свечам, а это сеть и
// расчёты. Если делать это при каждом открытии дашборда, он будет думать секундами.
// Поэтому: посчитали при закрытии, положили в саму сделку, дальше детекторы читают
// готовые числа.
//
// Важное свойство: расчёт НИКОГДА не должен мешать закрыть сделку. Нет связи с биржей,
// не хватило истории, инструмент не резолвится — возвращаем null, сделка закрывается
// как обычно, просто без разбора. Данные важнее аналитики.
import { fetchDailyCandles } from './marketData/candles';
import { computeBothLines } from './backtest/livePosition';

function indexAtOrBefore(candles, date) {
  if (!date) return -1;
  const t = new Date(date).getTime();
  let found = -1;
  for (let i = 0; i < candles.length; i++) {
    if (new Date(candles[i].date).getTime() <= t) found = i; else break;
  }
  return found;
}

/**
 * @param {object}  a
 * @param {object}  a.trade        - сделка из журнала (уже с финальными legs)
 * @param {Date}    a.openedAt     - когда открыта (resolveOpenedAt)
 * @param {Date}    a.closedAt     - когда закрыта
 * @param {object}  a.exitRules    - правила стратегии, по которой велась сделка
 * @param {string} [a.tinkoffToken]
 * @returns {Promise<object|null>} поля для записи в сделку, либо null
 */
export async function computeTradePostmortem({ trade, openedAt, closedAt, exitRules, tinkoffToken }) {
  try {
    if (!trade?.ticker || !trade?.entryPrice || !openedAt) return null;

    const timeframe = trade.entryTimeframe || 'D1';
    const candles = await fetchDailyCandles({
      ticker: trade.ticker,
      instrumentType: trade.instrumentType || 'stock',
      toDate: closedAt || new Date(),
      timeframe,
      tinkoffToken,
    });
    if (!candles?.length) return null;

    const entryIndex = indexAtOrBefore(candles, openedAt);
    const exitIndex = closedAt ? indexAtOrBefore(candles, closedAt) : candles.length - 1;
    // Нужен хотя бы один бар после входа, иначе проигрывать нечего.
    if (entryIndex < 0 || exitIndex <= entryIndex) return null;

    // Обрезаем историю ровно по бару выхода — «сейчас» для закрытой сделки это момент
    // её закрытия, а не сегодняшний день.
    const window = candles.slice(0, exitIndex + 1);
    const volume = parseFloat(trade.volume) || 1;
    const actualFills = (trade.legs || [])
      .filter((l) => l.type === 'close')
      .map((l) => ({
        index: Math.max(entryIndex + 1, indexAtOrBefore(window, l.timestampUtc)),
        fraction: (parseFloat(l.quantity) || 0) / volume,
      }))
      .filter((f) => f.fraction > 0 && f.index <= exitIndex);

    const { actual, shadow, deltaPct } = computeBothLines({
      candles: window,
      entryIndex,
      direction: trade.direction === 'short' ? 'short' : 'long',
      entryPrice: parseFloat(trade.entryPrice),
      rules: exitRules || {},
      stopPrice: trade.stopLoss ? parseFloat(trade.stopLoss) : null,
      takePrice: trade.takeProfit ? parseFloat(trade.takeProfit) : null,
      actualFills,
    });

    // Когорта считается по РЕАЛЬНЫМ фиксациям трейдера, а не по срабатываниям движка:
    // вопрос детектора — «сколько раз ТЫ снимал часть», а не «сколько раз система
    // предлагала». Последнее закрытие (выход из сделки) фиксацией не считается.
    const partialFixes = Math.max(0, actualFills.length - 1);

    return {
      peakPct: Math.round(actual.peakPct * 100) / 100,
      givebackPct: Math.round(actual.givebackPct * 100) / 100,
      partialFixes,
      cohort: partialFixes >= 2 ? '2+' : String(partialFixes),
      shadowPct: Math.round(shadow.currentPct * 100) / 100,
      shadowExitReason: shadow.exit?.reason || null,
      vsSystemPct: Math.round(deltaPct * 100) / 100,
      postmortemTimeframe: timeframe,
      postmortemAt: new Date().toISOString(),
    };
  } catch {
    // Разбор — необязательная надстройка. Молча пропускаем, сделка закрывается как есть.
    return null;
  }
}
