// src/services/strategyBuilder/journalData.js
//
// Загрузка свечей для сверки правила с журналом: по каждой бумаге — один кусок истории от «самой ранней сделки минус
// разгон индикаторов» до «самой поздней сделки плюс день». Загрузчик свечей передаётся снаружи (в приложении —
// marketData/candles.fetchDailyCandles), поэтому модуль чистый и проверяется тестами без сети.
import { resolveOpenedAt } from '../tradeDates';
import { tradeEligibility } from './journalMatch';
import { prepareData } from './evaluate';

const DAY = 86400000;

// Сколько календарных дней истории нужно ДО первой сделки, чтобы самые длинные индикаторы (EMA200, уровни) успели
// «разогнаться»: ≈ 260 свечей таймфрейма с запасом на выходные и короткие сессии.
export const WARMUP_DAYS = { M5: 8, M10: 12, M15: 14, H1: 45, D1: 420 };

/** Какие таймфреймы нужны стратегии: свой + старшие из условий. */
export function timeframesOf(spec) {
  const out = new Set([spec.timeframe]);
  for (const c of spec.entry?.conditions || []) {
    if (c.feature?.tf) out.add(c.feature.tf);
    if (c.right?.tf) out.add(c.right.tf);
  }
  return [...out];
}

/**
 * План загрузки: какие бумаги и за какой период. Сделки, которые всё равно не участвуют (другой класс, сторона,
 * открытые), свечей не требуют.
 * @returns {Array<{ticker, instrumentType, from: Date, to: Date, trades: number}>}
 */
export function planJournalLoad(spec, trades, now = Date.now()) {
  const byTicker = new Map();
  for (const t of trades || []) {
    if (t?.status !== 'closed' || typeof t.pnl !== 'number') continue;
    if (!tradeEligibility(spec, t).ok) continue;
    const at = resolveOpenedAt(t);
    if (!at || Number.isNaN(at.getTime())) continue;
    const key = String(t.ticker || '').toUpperCase();
    const cur = byTicker.get(key) || { ticker: t.ticker, instrumentType: spec.instrumentClass === 'future' ? 'future' : spec.instrumentClass === 'currency' ? 'currency' : 'stock', min: at, max: at, trades: 0 };
    if (at < cur.min) cur.min = at;
    if (at > cur.max) cur.max = at;
    cur.trades += 1;
    byTicker.set(key, cur);
  }
  return [...byTicker.values()]
    .map((x) => ({ ticker: x.ticker, instrumentType: x.instrumentType, from: x.min, to: new Date(Math.min(now, x.max.getTime() + DAY)), trades: x.trades }))
    .sort((a, b) => b.trades - a.trades);
}

/**
 * Загрузить свечи по плану. fetchCandles({ticker, instrumentType, toDate, timeframe, lookbackDays}) → свечи.
 * Ошибка по одной бумаге не роняет остальные — бумага попадёт в «нет данных».
 * @returns {Promise<{data: Map<string, object>, failed: Array<{ticker, error}>}>}
 */
export async function loadJournalData(spec, plan, fetchCandles, { onProgress, isCancelled, concurrency = 2 } = {}) {
  const tfs = timeframesOf(spec);
  const data = new Map();
  const failed = [];
  let done = 0;
  const queue = [...plan];
  const worker = async () => {
    while (queue.length) {
      if (isCancelled?.()) return;
      const item = queue.shift();
      try {
        const series = {};
        for (const tf of tfs) {
          const span = Math.ceil((item.to - item.from) / DAY) + (WARMUP_DAYS[tf] ?? 60);
          // eslint-disable-next-line no-await-in-loop
          series[tf] = await fetchCandles({ ticker: item.ticker, instrumentType: item.instrumentType, toDate: item.to, timeframe: tf, lookbackDays: span });
        }
        const base = series[spec.timeframe] || [];
        if (base.length) {
          const htf = {};
          for (const tf of tfs) if (tf !== spec.timeframe) htf[tf] = series[tf] || [];
          data.set(String(item.ticker).toUpperCase(), prepareData({ timeframe: spec.timeframe, candles: base, htf }));
        } else failed.push({ ticker: item.ticker, error: 'свечей нет' });
      } catch (e) {
        failed.push({ ticker: item.ticker, error: e?.message || 'не загрузились' });
      }
      done += 1;
      onProgress?.({ done, total: plan.length, ticker: item.ticker });
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, plan.length)) }, worker));
  return { data, failed };
}
