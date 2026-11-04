// src/services/trainer/liveSim.js
//
// Бумажные сделки тренажёра на ЖИВЫХ ценах: заявка ставится сегодня, а дальше сделка «доигрывается» по настоящим свечам,
// которые появляются после неё. Фоновый робот для этого не нужен: при каждом открытии страницы (и раз в минуту, пока она
// открыта) мы берём свежие свечи и дочитываем сделку с того места, где остановились. Чистые функции без зависимостей,
// тесты — scripts/liveSimTests.mjs.
//
// Правила (те же, что в переигровке, плюс живые особенности):
//  • заявка исполняется по ОТКРЫТИЮ первой свечи, которая началась после заявки;
//  • стоп/тейк проверяются только по ЗАКРЫТЫМ свечам (недозакрытая свеча ещё может измениться) — поэтому результат может
//    «приходить» с задержкой до конца свечи, зато не подгоняется под промежуточные максимумы и минимумы;
//  • передвинутый стоп действует только со свечей, которые НАЧАЛИСЬ после передвижения (иначе по итогам уже начатой свечи
//    можно было бы «задним числом» узнать, что стоп надо было подтянуть);
//  • данные MOEX без подписки идут с задержкой около 15 минут — это учебная модель, не торговая система.
import { openPosition, onBar, closePosition, moveStop, DEFAULT_FEE_PCT_PER_SIDE } from './trainerSim.js';

const clone = (o) => JSON.parse(JSON.stringify(o));
const ms = (v) => (v instanceof Date ? v.getTime() : new Date(v).getTime());

/** Номер свечи от начала эпохи для данного таймфрейма — одинаков у всех живых сделок, пригоден для сравнения «рядом ли по времени». */
export const barNumber = (date, tfMinutes) => Math.floor(ms(date) / (tfMinutes * 60000));

/** Свеча закрыта, если её период уже закончился. */
export const isClosedBar = (c, tfMinutes, nowMs) => ms(c.date) + tfMinutes * 60000 <= nowMs;

/**
 * Новая живая заявка (запись для коллекции trainerTrades, пока в статусе 'pending').
 * @param {{side, stop, take?, riskMoney, ticker, instrumentType?, timeframe, tfMinutes, lastCandleDate, lastPrice, strategyId?, strategyName?, feePctPerSide?}} o
 *   lastCandleDate — начало последней известной свечи (в том числе ещё не закрытой): исполнится по открытию следующей;
 *   lastPrice — её последняя цена (по ней проверяется, что стоп и тейк стоят с нужной стороны).
 */
export function createLiveOrder(o) {
  const d = o.side === 'long' ? 1 : -1;
  if (o.side !== 'long' && o.side !== 'short') throw new Error('Направление — long или short');
  if (!(o.stop > 0)) throw new Error('Укажите стоп — без стопа заявка не ставится');
  if (!(o.lastPrice > 0)) throw new Error('Нет текущей цены');
  if ((o.lastPrice - o.stop) * d <= 0) throw new Error(o.side === 'long' ? 'Для покупки стоп должен быть ниже текущей цены' : 'Для продажи стоп должен быть выше текущей цены');
  const take = o.take == null || o.take === '' ? null : Number(o.take);
  if (take != null && (take - o.lastPrice) * d <= 0) throw new Error(o.side === 'long' ? 'Для покупки тейк должен быть выше текущей цены' : 'Для продажи тейк должен быть ниже текущей цены');
  if (!(o.riskMoney > 0)) throw new Error('Укажите риск на сделку');
  return {
    kind: 'trainer', dataMode: 'live', status: 'pending',
    ticker: o.ticker, instrumentType: o.instrumentType || 'stock', timeframe: o.timeframe, tfMinutes: o.tfMinutes,
    side: o.side, orderStop: o.stop, orderTake: take, riskMoney: o.riskMoney,
    feePctPerSide: o.feePctPerSide ?? DEFAULT_FEE_PCT_PER_SIDE,
    orderPrice: o.lastPrice,
    orderBarTime: new Date(ms(o.lastCandleDate)).toISOString(),
    lastBarTime: new Date(ms(o.lastCandleDate)).toISOString(),
    stopSchedule: [{ afterMs: 0, price: o.stop }],
    strategyId: o.strategyId || null, strategyName: o.strategyName || null,
    stopMoves: [],
  };
}

/** Стоп, который действует на свече `bar`: последний из тех, что были переданы ДО начала этой свечи. */
export function stopFor(doc, bar) {
  const t = ms(bar.date);
  let price = doc.stopSchedule?.[0]?.price ?? doc.stopPrice;
  for (const s of doc.stopSchedule || []) if (s.afterMs < t) price = s.price;
  return price;
}

const latestStop = (doc) => (doc.stopSchedule?.length ? doc.stopSchedule[doc.stopSchedule.length - 1].price : doc.stopPrice);

/**
 * Дочитать сделку по свежим свечам. Не меняет исходный объект.
 * @returns {{doc:object, changed:boolean, events:string[]}} events: 'filled' | 'cancelled' | 'stop' | 'take'
 */
export function advanceLive(doc, candles, nowMs = Date.now()) {
  let d = clone(doc);
  const events = [];
  const tf = d.tfMinutes;
  const bars = (candles || []).slice().sort((a, b) => ms(a.date) - ms(b.date));
  let changed = false;

  if (d.status === 'pending') {
    const fillBar = bars.find((c) => ms(c.date) > ms(d.orderBarTime));
    if (!fillBar) return { doc: d, changed: false, events };
    try {
      const pos = openPosition({
        side: d.side, price: fillBar.open, stop: stopFor(d, fillBar), take: d.orderTake, date: fillBar.date,
        bar: barNumber(fillBar.date, tf), riskMoney: d.riskMoney, feePctPerSide: d.feePctPerSide,
      });
      d = { ...d, ...pos, status: 'open', filledAt: new Date(ms(fillBar.date)).toISOString(), fillPrice: fillBar.open };
      events.push('filled');
    } catch (e) {
      d.status = 'cancelled';
      d.cancelReason = `Цена открытия ${fillBar.open} оказалась за стопом: ${e.message}`;
      events.push('cancelled');
      return { doc: d, changed: true, events };
    }
    changed = true;
  }

  if (d.status === 'open') {
    const todo = bars.filter((c) => ms(c.date) > ms(d.lastBarTime) && isClosedBar(c, tf, nowMs));
    for (const bar of todo) {
      d.stopPrice = stopFor(d, bar);
      const r = onBar(d, bar, barNumber(bar.date, tf));
      d = { ...d, ...r.position };
      d.lastBarTime = new Date(ms(bar.date)).toISOString();
      changed = true;
      if (r.closed) { events.push(d.exitReason); return { doc: d, changed: true, events }; }
    }
    if (d.status === 'open') d.stopPrice = latestStop(d);
  }
  return { doc: d, changed, events };
}

/** Передвинуть стоп живой позиции: вступает в силу со свечей, которые начнутся после этого момента. */
export function moveLiveStop(doc, newStop, nowMs, lastPrice) {
  if (doc.status !== 'open') throw new Error('Стоп можно двигать только у открытой позиции');
  const current = latestStop(doc);
  const moved = moveStop({ ...clone(doc), stopPrice: current }, newStop, doc.barsHeld ?? 0, lastPrice);
  if (moved.stopPrice === current) return doc;
  const out = { ...moved, stopSchedule: [...(doc.stopSchedule || []), { afterMs: nowMs, price: newStop }] };
  return out;
}

/** Закрыть вручную по цене последней известной свечи. */
export function closeLive(doc, lastCandle) {
  if (doc.status !== 'open') throw new Error('Закрыть можно только открытую позицию');
  const p = closePosition({ ...clone(doc), stopPrice: latestStop(doc) }, lastCandle.close, lastCandle.date, barNumber(lastCandle.date, doc.tfMinutes), 'manual');
  return { ...doc, ...p };
}
