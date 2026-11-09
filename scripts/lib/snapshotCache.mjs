// scripts/lib/snapshotCache.mjs
//
// Когда снимок для меню Telegram можно собрать, не перечитывая всю историю сделок.
//
// Снимок состоит из «живой» части (открытые позиции, радар — читается дёшево, каждый проход) и «исторической»
// (итоги закрытых бумажных сделок по стратегиям, список последних закрытых) — её раньше строили, читая ВСЕ бумажные
// сделки и 120 записей журнала при каждом проходе, и по два раза за проход. На бесплатном тарифе Firebase (50 000 чтений
// в сутки) это было основным расходом. Теперь историческая часть берётся из прошлого снимка (он лежит в Cloudflare KV),
// пока не изменились количества документов (их считает дешёвый запрос count() — одно чтение на тысячу документов)
// и пока снимок не старше MAX_AGE_MS. Новая закрытая/открытая сделка меняет количество — тогда история пересчитывается.
//
// Чистые функции без зависимостей.

export const MAX_AGE_MS = 3 * 60 * 60 * 1000;

/**
 * @param {object|null} prev    прошлый снимок (с полем hist) или null
 * @param {{paperAll:number, paperOpen:number, real:number, realOpen:number}} counts  текущие количества документов
 * @param {number} nowMs
 * @param {number} [maxAgeMs]
 * @returns {boolean}
 */
export function canReuseHist(prev, counts, nowMs, maxAgeMs = MAX_AGE_MS) {
  const h = prev && prev.hist;
  if (!h || !h.at || !h.counts) return false;
  const age = nowMs - Date.parse(h.at);
  if (!Number.isFinite(age) || age < 0 || age > maxAgeMs) return false;
  for (const k of ['paperAll', 'paperOpen', 'real', 'realOpen']) {
    if (!Number.isFinite(counts?.[k]) || counts[k] !== h.counts[k]) return false;
  }
  // Без самих данных истории переиспользовать нечего.
  return ['paperClosed', 'paperByStrategy', 'realByStrategy', 'paperClosedList', 'realClosedList'].every((k) => prev[k] !== undefined);
}

/** Историческая часть снимка — то, что переносится из прошлого снимка. */
export function histPart(snapshot) {
  return {
    paperClosed: snapshot.paperClosed,
    paperByStrategy: snapshot.paperByStrategy,
    realByStrategy: snapshot.realByStrategy,
    paperClosedList: snapshot.paperClosedList,
    realClosedList: snapshot.realClosedList,
  };
}
