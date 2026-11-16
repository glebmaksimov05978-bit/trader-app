// src/services/analytics/exitReplay.js
//
// Переигровка выхода: «а если бы я вышел здесь?» по свечам после входа — и до фактического выхода, и после него.
// Как в журналах трейдера (разбор выхода): двигаешь точку выхода по графику и видишь рубли, R и разницу с тем, что
// получилось на деле; рядом — лучшая и худшая цена, пока сделка была открыта, сработал ли бы стоп и что цена сделала
// после выхода.
//
// Рубли считаются от ФАКТИЧЕСКОГО результата сделки, а не заново по спецификации контракта: коэффициент «рубли за
// единицу хода цены» выводится из самой сделки (результат до комиссии / ход цены × объём). Так одинаково верно и для
// акций (лоты/штуки), и для фьючерсов (стоимость шага, в том числе долларовая на день сделки). Если ход цены нулевой и
// вывести нельзя — берётся спецификация (contractMath.rubPerPoint).
//
// Условность честно названа: выход «по закрытию свечи» таймфрейма графика, внутри свечи пути цены не видно; стоп
// проверяется по минимуму/максимуму свечи и исполняется по цене стопа (или по открытию, если свеча открылась за ним).
// Чистые функции.
import { rubPerPoint } from '../contractMath.js';

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : null; };
const ms = (v) => {
  if (v == null) return NaN;
  if (v instanceof Date) return v.getTime();
  if (v.seconds != null) return v.seconds * 1000;
  return new Date(v).getTime();
};

/** Номер свечи, внутри которой момент t (последняя свеча, начавшаяся не позже t). -1 — раньше всех свечей. */
export function barIndexAt(candles, t) {
  const x = ms(t);
  if (!Number.isFinite(x)) return -1;
  let lo = 0, hi = candles.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (ms(candles[mid].date) <= x) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

/**
 * Рубли за единицу хода цены на весь объём сделки (знак направления не входит).
 * Из факта: (результат + комиссия − поправка по марже брокера) / ((выход − вход) × направление). Иначе — спецификация × объём.
 */
export function rubPerUnitMove(trade) {
  const entry = num(trade.entryPrice), exit = num(trade.exitPrice), vol = num(trade.volume);
  const dir = trade.direction === 'short' ? -1 : 1;
  const pnl = num(trade.pnl);
  if (entry > 0 && exit > 0 && pnl != null && trade.status === 'closed') {
    const move = (exit - entry) * dir;
    if (Math.abs(move) >= entry * 0.0005) {
      const gross = pnl + (num(trade.commission) || 0) - (num(trade.brokerAdjustment) || 0);
      const k = gross / move;
      if (k > 0 && Number.isFinite(k)) return { k, source: 'fact' };
    }
  }
  if (vol > 0) return { k: rubPerPoint(trade) * vol, source: 'spec' };
  return { k: null, source: null };
}

/**
 * @param {object} a
 * @param {object} a.trade     сделка (реальная или системы): entryPrice, exitPrice, stopLoss, direction, volume, pnl, commission…
 * @param {Array}  a.candles   свечи графика, по возрастанию времени
 * @param {Date}   a.openedAt
 * @param {Date}   [a.closedAt] нет — сделка ещё открыта (тогда «фактического выхода» нет)
 */
export function buildExitReplay({ trade, candles, openedAt, closedAt }) {
  const bars = Array.isArray(candles) ? candles : [];
  const entry = num(trade?.entryPrice);
  if (!bars.length || !(entry > 0)) return null;
  const dir = trade.direction === 'short' ? -1 : 1;
  const entryIdx = barIndexAt(bars, openedAt);
  if (entryIdx < 0) return null;
  const lastIdx = bars.length - 1;
  const exitIdxRaw = closedAt ? barIndexAt(bars, closedAt) : -1;
  const exitIdx = exitIdxRaw >= entryIdx ? exitIdxRaw : null;
  const exitPrice = num(trade.exitPrice);
  const stop = num(trade.stopLoss);
  const riskPerUnit = stop > 0 && Math.abs(entry - stop) > 0 && (entry - stop) * dir > 0 ? Math.abs(entry - stop) : null;
  const { k, source } = rubPerUnitMove(trade);
  const comm = num(trade.commission) || 0;
  const actualExitForComm = exitPrice > 0 ? exitPrice : entry;
  const adj = num(trade.brokerAdjustment) || 0;

  // Результат выхода по цене p: ход × рубли за ход − комиссия (пересчитанная под цену выхода: доля выхода в обороте меняется).
  const at = (p) => {
    const move = (p - entry) * dir;
    const rub = k != null ? move * k - comm * ((entry + p) / (entry + actualExitForComm)) : null;
    return {
      price: p,
      pct: (move / entry) * 100,
      r: riskPerUnit ? move / riskPerUnit : null,
      rub: rub != null ? Math.round(rub * 100) / 100 : null,
    };
  };

  // Лучшая и худшая цена за время в сделке (по максимумам/минимумам свечей) и после выхода.
  const extreme = (from, to) => {
    if (from == null || to == null || to < from) return null;
    let best = null, worst = null;
    for (let i = from; i <= to; i += 1) {
      const c = bars[i];
      const fav = dir > 0 ? num(c.high) : num(c.low);
      const adv = dir > 0 ? num(c.low) : num(c.high);
      if (fav != null && (best == null || (fav - best.price) * dir > 0)) best = { idx: i, price: fav };
      if (adv != null && (worst == null || (adv - worst.price) * dir < 0)) worst = { idx: i, price: adv };
    }
    return { best: best && { ...best, ...at(best.price), date: bars[best.idx].date }, worst: worst && { ...worst, ...at(worst.price), date: bars[worst.idx].date } };
  };
  const holdEnd = exitIdx != null ? exitIdx : lastIdx;
  const inTrade = extreme(entryIdx, holdEnd);
  const afterExit = exitIdx != null && exitIdx < lastIdx ? extreme(exitIdx + 1, lastIdx) : null;

  // Где сработал бы стоп (первая свеча ПОСЛЕ свечи входа, задевшая стоп).
  let stopHit = null;
  if (stop > 0 && riskPerUnit) {
    for (let i = entryIdx + 1; i <= lastIdx; i += 1) {
      const c = bars[i];
      const touched = dir > 0 ? num(c.low) <= stop : num(c.high) >= stop;
      if (touched) {
        const gap = dir > 0 ? num(c.open) < stop : num(c.open) > stop;
        const p = gap ? num(c.open) : stop;
        stopHit = { idx: i, date: c.date, gap, ...at(p) };
        break;
      }
    }
  }

  const actualRub = num(trade.pnl);
  const actual = exitIdx != null && exitPrice > 0 ? { idx: exitIdx, date: closedAt, ...at(exitPrice), rub: actualRub != null ? actualRub - adj : at(exitPrice).rub } : null;
  // Какая доля лучшего хода за время сделки забрана выходом.
  const captured = actual && inTrade?.best && (inTrade.best.price - entry) * dir > 0
    ? ((exitPrice - entry) * dir) / ((inTrade.best.price - entry) * dir) : null;

  // «Держать до стопа или цели»: первая свеча после входа, задевшая стоп или цель. Обе в одной свече — считаем стоп
  // (порядок внутри свечи неизвестен, консервативно). Ничего не задето до конца данных — выход по последнему закрытию.
  const holdUntil = (target) => {
    if (!(stop > 0) || !riskPerUnit) return null;
    for (let i = entryIdx + 1; i <= lastIdx; i += 1) {
      const c = bars[i];
      const hitStop = dir > 0 ? num(c.low) <= stop : num(c.high) >= stop;
      const hitTake = target > 0 && (dir > 0 ? num(c.high) >= target : num(c.low) <= target);
      if (hitStop) {
        const gap = dir > 0 ? num(c.open) < stop : num(c.open) > stop;
        return { idx: i, date: c.date, how: 'stop', ...at(gap ? num(c.open) : stop) };
      }
      if (hitTake) {
        const gap = dir > 0 ? num(c.open) > target : num(c.open) < target;
        return { idx: i, date: c.date, how: 'take', ...at(gap ? num(c.open) : target) };
      }
    }
    const c = bars[lastIdx];
    return { idx: lastIdx, date: c.date, how: 'end', ...at(num(c.close)) };
  };

  return {
    entryIdx, exitIdx, lastIdx, entry, dir, stop, riskPerUnit, k, kSource: source, brokerAdjustment: adj,
    /** Выход по правилу «стоп или цель»: цель — цена (null — только стоп и конец данных). */
    holdUntil,
    /** Цель на N R от входа (по исходному стопу). */
    targetAtR: (n) => (riskPerUnit ? entry + dir * riskPerUnit * n : null),
    /** Выход по закрытию свечи i. */
    exitAtBar: (i) => {
      const j = Math.max(entryIdx, Math.min(lastIdx, i));
      return { idx: j, date: bars[j].date, ...at(num(bars[j].close)) };
    },
    exitAtPrice: at,
    actual, inTrade, afterExit, stopHit, captured,
    barsAfterExit: exitIdx != null ? lastIdx - exitIdx : 0,
  };
}
