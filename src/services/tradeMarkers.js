// src/services/tradeMarkers.js
//
// Метки сделки на графике: вход, докупка, частичная фиксация, выход. Чистые функции без графика и базы —
// один и тот же расчёт для Журнала, Сопровождения, окна «Посмотреть сделку» и Тренажёра, чтобы сделка
// выглядела одинаково везде.
//
// Как читать метки: зелёная стрелка вверх — купили, красная вниз — продали (как в терминале). Все одного размера;
// роль операции (вход, докупка, часть, выход) — в подписи, которую можно выключить.
import { legDate } from './tradeLegs';

const sec = (v) => { const d = legDate(v); return d ? Math.floor(d.getTime() / 1000) : null; };
const qty = (v) => { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : 0; };
const priceOf = (v) => { const n = Number(v); return v != null && v !== '' && Number.isFinite(n) ? n : null; };

/**
 * Дополняет историю операций недостающими концами. У сделки системы (бумажной) робот пишет только закрытия,
 * у сделки из Калькулятора операций нет вовсе — без этого вход на графике не был виден.
 * @param {Array} legs        trade.legs (может быть пустым)
 * @param {{date:any, price?:number, quantity?:number}|null} entry  когда и по какой цене открыта сделка
 * @param {{date:any, price?:number, quantity?:number}|null} exit   когда и по какой цене закрыта целиком
 */
export function normalizeLegs(legs, entry, exit) {
  const out = (Array.isArray(legs) ? legs : [])
    .filter((l) => l && (l.type === 'open' || l.type === 'close') && sec(l.timestampUtc) != null);
  const hasOpen = out.some((l) => l.type === 'open');
  const hasClose = out.some((l) => l.type === 'close');
  if (!hasOpen && entry && sec(entry.date) != null) {
    out.push({ type: 'open', price: priceOf(entry.price), quantity: qty(entry.quantity) || null, timestampUtc: entry.date });
  }
  if (!hasClose && exit && sec(exit.date) != null) {
    out.push({ type: 'close', price: priceOf(exit.price), quantity: qty(exit.quantity) || null, timestampUtc: exit.date });
  }
  return out;
}

// Свеча, в которую попала операция: последняя с временем начала не позже операции. Раньше первой свечи — null
// (метку на чужой свече лучше не ставить вовсе, чем поставить не туда).
function barFor(t, candleTimes) {
  if (!candleTimes.length || t < candleTimes[0]) return null;
  let lo = 0, hi = candleTimes.length - 1, ans = candleTimes[0];
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleTimes[mid] <= t) { ans = candleTimes[mid]; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * @param {object} a
 * @param {Array}   a.legs         операции (после normalizeLegs)
 * @param {'long'|'short'} a.direction
 * @param {number[]} a.candleTimes время начала свечей, unix-секунды, по возрастанию
 * @param {{green:string, red:string}} a.colors
 * @param {boolean} [a.closed]     сделка закрыта целиком (нужно, когда объём входа неизвестен)
 * @param {boolean} [a.showLabels] подписи словами; false — только значки
 * @returns {{markers:Array, fillsByBar:Map<number, Array<{t:number, action:string, kind:string, quantity:number|null, price:number|null}>>}}
 */
export function buildTradeMarks({ legs, direction, candleTimes, colors, closed = false, showLabels = true }) {
  const fillsByBar = new Map();
  if (!legs?.length || !candleTimes?.length) return { markers: [], fillsByBar };
  const short = direction === 'short';

  const sorted = legs
    .map((l) => ({ type: l.type, t: sec(l.timestampUtc), quantity: qty(l.quantity), price: priceOf(l.price) }))
    .filter((l) => l.t != null)
    // при одинаковом времени открытие раньше закрытия
    .sort((a, b) => a.t - b.t || (a.type === 'open' ? -1 : 1) - (b.type === 'open' ? -1 : 1));

  const totalOpened = sorted.filter((l) => l.type === 'open').reduce((s, l) => s + l.quantity, 0);
  const firstOpenIdx = sorted.findIndex((l) => l.type === 'open');
  // Какое закрытие — выход целиком: то, на котором закрытый объём догнал открытый. Если по объёмам этого
  // не видно (объём где-то не записан), а сделка закрыта — последнее закрытие.
  let finalCloseIdx = -1;
  if (totalOpened > 0) {
    let closedSoFar = 0;
    sorted.forEach((l, i) => {
      if (l.type !== 'close' || finalCloseIdx !== -1) return;
      closedSoFar += l.quantity;
      if (closedSoFar >= totalOpened - 1e-9) finalCloseIdx = i;
    });
  }
  if (finalCloseIdx === -1 && closed) {
    for (let i = sorted.length - 1; i >= 0; i--) { if (sorted[i].type === 'close') { finalCloseIdx = i; break; } }
  }

  // На одной свече — не больше одной метки входа и одной метки выхода («×N», если операций несколько).
  // Сделка, открытая и закрытая внутри одной свечи, даёт обе: стрелку входа с одной стороны, выхода с другой.
  const groups = new Map(); // `${bar}|open` / `${bar}|close` -> { bar, type, kinds:[], n }
  sorted.forEach((l, i) => {
    const bar = barFor(l.t, candleTimes);
    if (bar == null) return;
    const kind = l.type === 'open' ? (i === firstOpenIdx ? 'open' : 'add') : (i === finalCloseIdx ? 'exit' : 'partial');
    const action = { open: 'Вход', add: 'Докупка', partial: 'Частичный выход', exit: 'Выход' }[kind];
    if (!fillsByBar.has(bar)) fillsByBar.set(bar, []);
    fillsByBar.get(bar).push({ t: l.t, action, kind, quantity: l.quantity || null, price: l.price });
    const key = `${bar}|${l.type}`;
    if (!groups.has(key)) groups.set(key, { bar, type: l.type, kinds: [], n: 0 });
    const g = groups.get(key);
    g.kinds.push(kind); g.n += 1;
  });

  // Один вид для всех операций, как в терминале: купили — зелёная стрелка вверх под свечой, продали — красная вниз
  // над свечой. Чем операция была для сделки (вход, докупка, часть, выход), говорит подпись и подсказка при наведении.
  const markers = [];
  groups.forEach((g) => {
    const count = g.n > 1 ? ` ×${g.n}` : '';
    const buy = (g.type === 'open') !== short; // лонг: открытие — покупка; шорт: открытие — продажа
    const label = g.type === 'open'
      ? (g.kinds.includes('open') ? 'Вход' : 'Докупка')
      : (g.kinds.includes('exit') ? 'Выход' : 'Часть');
    markers.push({
      time: g.bar, position: buy ? 'belowBar' : 'aboveBar', shape: buy ? 'arrowUp' : 'arrowDown',
      color: buy ? colors.green : colors.red, size: 1,
      text: showLabels ? label + count : '',
    });
  });
  markers.sort((a, b) => a.time - b.time);
  return { markers, fillsByBar };
}
