// src/services/trainer/liveCandles.js
//
// Общая часть для пробных сделок на живых ценах (Тренажёр → Живые цены и «Вошёл пробно» в Сопровождении): загрузить
// свечи нужного таймфрейма с запасом от момента заявки и дочитать сделку по ним (liveSim.advanceLive).
import { fetchDailyCandles, TIMEFRAMES } from '../marketData/candles';
import { advanceLive } from './liveSim';

export const liveKeyOf = (d) => `${d.ticker}|${d.timeframe}`;
export const latestLiveStop = (d) => (d.stopSchedule?.length ? d.stopSchedule[d.stopSchedule.length - 1].price : d.stopPrice);
export const LIVE_EVENT_TEXT = {
  filled: 'исполнена по открытию свечи',
  stop: 'закрыта по стопу',
  take: 'закрыта по цели',
  cancelled: 'отменена: свеча открылась за стопом',
};

export async function loadLiveCandles({ ticker, instrumentType, timeframe, tinkoffToken, sinceMs }) {
  const tf = TIMEFRAMES[timeframe] || TIMEFRAMES.D1;
  const days = Math.max(tf.lookbackDays, sinceMs ? Math.ceil((Date.now() - sinceMs) / 86400000) + 10 : 0);
  return fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), tinkoffToken, timeframe, lookbackDays: days });
}

/**
 * Дочитать активные пробные сделки по свежим свечам. Записывает изменения через save(id, body).
 * @returns {Promise<{candles: Object<string, Array>, changed: Array<{doc, events}>, errors: string[]}>}
 */
export async function refreshLiveTrades(docs, { tinkoffToken, save, nowMs = Date.now() }) {
  const groups = new Map();
  for (const d of docs || []) {
    if (d.status !== 'pending' && d.status !== 'open') continue;
    const k = liveKeyOf(d);
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(d);
  }
  const candles = {};
  const changed = [];
  const errors = [];
  for (const [k, list] of groups) {
    const first = list[0];
    const since = Math.min(...list.map((d) => new Date(d.orderBarTime).getTime()));
    let bars;
    try {
      bars = await loadLiveCandles({ ticker: first.ticker, instrumentType: first.instrumentType, timeframe: first.timeframe, tinkoffToken, sinceMs: since });
    } catch (e) { errors.push(`${first.ticker}: ${e?.message || 'не удалось загрузить свечи'}`); continue; }
    candles[k] = bars;
    for (const d of list) {
      const r = advanceLive(d, bars, nowMs);
      if (!r.changed) continue;
      const { id, createdAt, updatedAt, ...body } = r.doc;
      try { await save(id, body); changed.push({ doc: r.doc, events: r.events }); } catch { errors.push(`${d.ticker}: не удалось сохранить`); }
    }
  }
  return { candles, changed, errors };
}
