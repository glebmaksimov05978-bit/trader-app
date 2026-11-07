// src/services/tradeLegs.js
//
// Операции по сделке для показа человеку: вход, докупка, частичная фиксация, выход — с временем, объёмом и ценой.
// Чистая функция без графика и базы. Названия те же, что на метках графика (CandleChart: «Вход», «Докупка»,
// «Частичный выход», «Выход»), чтобы таблица под графиком и метки на нём читались одинаково.

/** Дата из Date, ISO-строки или Timestamp Firestore ({seconds}); иначе null. */
export function legDate(v) {
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v && typeof v === 'object' && v.seconds != null) return new Date(v.seconds * 1000);
  if (v == null || v === '') return null;
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

/**
 * @param {Array<{type:'open'|'close', quantity:number|string, price:number|string, timestampUtc:any}>} legs
 * @returns {Array<{date:Date|null, action:string, kind:'open'|'add'|'partial'|'exit', quantity:number, price:number|null}>}
 *   по возрастанию времени
 */
export function describeLegs(legs) {
  const rows = (Array.isArray(legs) ? legs : [])
    .filter((l) => l && (l.type === 'open' || l.type === 'close'))
    .map((l) => ({ type: l.type, date: legDate(l.timestampUtc), quantity: Number(l.quantity) || 0, price: Number.isFinite(Number(l.price)) ? Number(l.price) : null }))
    .sort((a, b) => (a.date?.getTime() ?? 0) - (b.date?.getTime() ?? 0));
  const opened = rows.filter((r) => r.type === 'open').reduce((s, r) => s + r.quantity, 0);
  let closed = 0;
  let firstOpenDone = false;
  let exitDone = false;
  return rows.map((r) => {
    if (r.type === 'open') {
      const kind = firstOpenDone ? 'add' : 'open';
      firstOpenDone = true;
      return { date: r.date, action: kind === 'open' ? 'Вход' : 'Докупка', kind, quantity: r.quantity, price: r.price };
    }
    closed += r.quantity;
    const isExit = !exitDone && opened > 0 && closed >= opened;
    if (isExit) exitDone = true;
    return { date: r.date, action: isExit ? 'Выход' : 'Частичный выход', kind: isExit ? 'exit' : 'partial', quantity: r.quantity, price: r.price };
  });
}

/** Средняя цена по набору операций одного вида (взвешенная по объёму) или null. */
export function weightedPrice(rows) {
  let q = 0; let s = 0;
  for (const r of rows || []) { if (r.price != null && r.quantity > 0) { q += r.quantity; s += r.price * r.quantity; } }
  return q > 0 ? s / q : null;
}
