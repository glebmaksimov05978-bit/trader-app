// src/services/analytics/excursion.js
//
// «Какую часть хода забрала сделка». Для честного сравнения двух стратегий на одном таймфрейме
// мало итога в рублях: одна могла войти поздно и выйти рано, другая — поймать весь ход. Здесь
// считается ход цены, который сделка МОГЛА забрать (максимум в свою сторону с момента входа до
// выхода), и ход, который она реально забрала.
//
// Без импортов: модуль подключает и приложение, и робот бумажных сделок (он записывает максимум
// в закрытую сделку, чтобы потом не ходить за свечами).

/**
 * Максимальный благоприятный и неблагоприятный ход в % от цены входа на свечах [fromIndex..toIndex].
 * Свечи: { high, low } (open/close не нужны). Для лонга благоприятный ход — вверх, для шорта — вниз.
 * @returns {{ maxFavorablePct: number, maxAdversePct: number } | null}
 */
export function excursionPct({ candles, fromIndex, toIndex, direction, entryPrice }) {
  const entry = Number(entryPrice);
  if (!Array.isArray(candles) || !(entry > 0)) return null;
  const a = Math.max(0, Math.floor(fromIndex));
  const b = Math.min(candles.length - 1, Math.floor(toIndex));
  if (!(b >= a)) return null;
  let best = 0;
  let worst = 0;
  for (let i = a; i <= b; i++) {
    const hi = Number(candles[i]?.high);
    const lo = Number(candles[i]?.low);
    if (!Number.isFinite(hi) || !Number.isFinite(lo)) continue;
    if (direction === 'short') {
      best = Math.max(best, ((entry - lo) / entry) * 100);
      worst = Math.max(worst, ((hi - entry) / entry) * 100);
    } else {
      best = Math.max(best, ((hi - entry) / entry) * 100);
      worst = Math.max(worst, ((entry - lo) / entry) * 100);
    }
  }
  return { maxFavorablePct: round(best), maxAdversePct: round(worst) };
}

/**
 * Ход цены, который реально забрала сделка, в % от цены входа: средневзвешенный выход по закрывающим
 * ступеням (с учётом частичных фиксаций), со знаком по направлению. Нет ступеней — по exitPrice.
 * @returns {number|null}
 */
export function capturedMovePct(trade) {
  const entry = Number(trade?.entryPrice);
  if (!(entry > 0)) return null;
  const legs = (Array.isArray(trade?.legs) ? trade.legs : [])
    .filter((l) => l?.type === 'close' && Number(l.quantity) > 0 && Number.isFinite(Number(l.price)));
  let exit = null;
  if (legs.length) {
    const q = legs.reduce((s, l) => s + Number(l.quantity), 0);
    exit = legs.reduce((s, l) => s + Number(l.price) * Number(l.quantity), 0) / q;
  } else if (Number.isFinite(Number(trade?.exitPrice)) && trade.exitPrice != null) {
    exit = Number(trade.exitPrice);
  }
  if (exit == null) return null;
  const sign = trade.direction === 'short' ? -1 : 1;
  return round(((exit - entry) / entry) * 100 * sign);
}

function round(v) {
  return Math.round(v * 100) / 100;
}
