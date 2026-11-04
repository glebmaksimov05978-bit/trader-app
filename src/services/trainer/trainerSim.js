// src/services/trainer/trainerSim.js
//
// Учебная (бумажная) позиция в тренажёре: открыть, двигать стоп, проверять стоп/тейк по каждой новой свече, закрыть.
// Чистые функции без зависимостей — работают одинаково на исторических свечах («переигровка») и на живых
// (бумага на реальных ценах), тестируются в node (scripts/trainerSimTests.mjs).
//
// Главная мера результата — R: сколько своих первоначальных рисков заработано/потеряно. Она не зависит от размера
// счёта, лота и множителя контракта, поэтому одинаково честна для акций и фьючерсов. Деньги (`pnlVirtual`) —
// только условные: риск на сделку × R. Реальным деньгам и реальной статистике они не принадлежат: у записи всегда
// стоит `kind: 'trainer'`.
//
// Правила исполнения (консервативные, чтобы бумага не выглядела лучше реальности):
//  • стоп и тейк проверяются по максимуму/минимуму свечи;
//  • если в одной свече достижимы и стоп, и тейк — считаем, что сработал СТОП (порядок внутри свечи неизвестен);
//  • если свеча открылась за стопом (гэп) — выход по цене открытия, а не по стопу: убыток может быть больше 1R;
//  • комиссия берётся с обеих сторон от цены входа и вычитается из R.

export const DEFAULT_FEE_PCT_PER_SIDE = 0.05; // % от цены, с каждой стороны сделки

const dirOf = (side) => (side === 'long' ? 1 : -1);
const clone = (o) => JSON.parse(JSON.stringify(o));
const toIso = (d) => (d instanceof Date ? d.toISOString() : d);

/** Условный размер позиции под заданный риск (в штуках, дробный — лоты и множители не учитываются). */
export function positionSize({ riskMoney, entry, stop }) {
  const per = Math.abs(entry - stop);
  if (!(riskMoney > 0) || !(per > 0)) return 0;
  return riskMoney / per;
}

/**
 * Открыть позицию. Бросает Error с понятным текстом, если стоп/тейк стоят не с той стороны от цены входа.
 * @param {{side:'long'|'short', price:number, stop:number, take?:number|null, date:Date|string, bar:number,
 *          riskMoney?:number, feePctPerSide?:number, meta?:object}} o
 */
export function openPosition({ side, price, stop, take = null, date, bar, riskMoney = 1000, feePctPerSide = DEFAULT_FEE_PCT_PER_SIDE, meta = {} }) {
  if (side !== 'long' && side !== 'short') throw new Error('Направление — long или short');
  if (!(price > 0)) throw new Error('Цена входа должна быть больше нуля');
  if (!(stop > 0)) throw new Error('Укажите стоп — без стопа сделка не открывается');
  const d = dirOf(side);
  if ((price - stop) * d <= 0) throw new Error(side === 'long' ? 'Для покупки стоп должен быть НИЖЕ цены входа' : 'Для продажи стоп должен быть ВЫШЕ цены входа');
  if (take != null && take !== '' && (take - price) * d <= 0) throw new Error(side === 'long' ? 'Для покупки тейк должен быть ВЫШЕ цены входа' : 'Для продажи тейк должен быть НИЖЕ цены входа');
  const riskPerUnit = Math.abs(price - stop);
  const qty = positionSize({ riskMoney, entry: price, stop });
  return {
    status: 'open',
    side, entryPrice: price, entryDate: toIso(date), entryBar: bar,
    initialStop: stop, stopPrice: stop,
    takePrice: take == null || take === '' ? null : Number(take),
    riskPerUnit, riskMoney, qty, feePctPerSide,
    plannedRR: take == null || take === '' ? null : Math.abs(Number(take) - price) / riskPerUnit,
    barsHeld: 0, mfeR: 0, maeR: 0,
    stopMoves: [],
    ...meta,
  };
}

/** Нереализованный результат по текущей цене (позиция не меняется). */
export function unrealized(position, lastPrice) {
  const d = dirOf(position.side);
  const rGross = ((lastPrice - position.entryPrice) * d) / position.riskPerUnit;
  const costR = costInR(position);
  return { r: rGross - costR, rGross, costR, pct: ((lastPrice - position.entryPrice) * d / position.entryPrice) * 100, pnlVirtual: (rGross - costR) * position.riskMoney };
}

function costInR(position) {
  // комиссия: от цены входа, с обеих сторон, переведена в R
  return ((position.feePctPerSide / 100) * position.entryPrice * 2) / position.riskPerUnit;
}

/**
 * Передвинуть стоп. Стоп всегда должен остаться на «убыточной» стороне от последней цены.
 * Записывает движение: 'tighten' — подтянули ближе к цене (защита прибыли), 'widen' — отодвинули (риск вырос).
 */
export function moveStop(position, newStop, bar, lastPrice) {
  if (position.status !== 'open') throw new Error('Позиция уже закрыта');
  const d = dirOf(position.side);
  if (!(newStop > 0)) throw new Error('Стоп должен быть больше нуля');
  if (lastPrice != null && (lastPrice - newStop) * d <= 0) throw new Error(position.side === 'long' ? 'Стоп должен быть ниже текущей цены' : 'Стоп должен быть выше текущей цены');
  if (newStop === position.stopPrice) return position;
  const p = clone(position);
  const direction = (newStop - position.stopPrice) * d > 0 ? 'tighten' : 'widen';
  p.stopMoves.push({ bar, from: position.stopPrice, to: newStop, direction });
  p.stopPrice = newStop;
  return p;
}

/** Передвинуть тейк (или убрать, если null). */
export function moveTake(position, newTake, lastPrice) {
  if (position.status !== 'open') throw new Error('Позиция уже закрыта');
  const d = dirOf(position.side);
  if (newTake == null || newTake === '') { const p = clone(position); p.takePrice = null; p.plannedRR = null; return p; }
  if (lastPrice != null && (newTake - lastPrice) * d <= 0) throw new Error(position.side === 'long' ? 'Тейк должен быть выше текущей цены' : 'Тейк должен быть ниже текущей цены');
  const p = clone(position);
  p.takePrice = Number(newTake);
  p.plannedRR = Math.abs(p.takePrice - position.entryPrice) / position.riskPerUnit;
  return p;
}

function finalize(position, exitPrice, exitDate, exitBar, reason, extra = {}) {
  const d = dirOf(position.side);
  const rGross = ((exitPrice - position.entryPrice) * d) / position.riskPerUnit;
  const costR = costInR(position);
  const r = rGross - costR;
  return {
    ...position,
    status: 'closed',
    exitPrice, exitDate: toIso(exitDate), exitBar, exitReason: reason,
    rGross, costR, r,
    pct: ((exitPrice - position.entryPrice) * d / position.entryPrice) * 100,
    pnlVirtual: r * position.riskMoney,
    ...extra,
  };
}

/**
 * Обработать новую свечу: обновить лучший/худший ход за время сделки и проверить стоп/тейк.
 * Первая свеча после входа обрабатывается как обычная (вход происходит по цене, которую игрок выбрал на предыдущей).
 * @returns {{position:object, closed:boolean}} позиция (закрытая или нет) и признак закрытия
 */
export function onBar(position, bar, barIndex) {
  if (position.status !== 'open') return { position, closed: false };
  const d = dirOf(position.side);
  const p = clone(position);
  p.barsHeld += 1;
  const favorable = (d === 1 ? bar.high - p.entryPrice : p.entryPrice - bar.low) / p.riskPerUnit;
  const adverse = (d === 1 ? p.entryPrice - bar.low : bar.high - p.entryPrice) / p.riskPerUnit;
  p.mfeR = Math.max(p.mfeR, favorable);
  p.maeR = Math.max(p.maeR, adverse);

  const stopHit = d === 1 ? bar.low <= p.stopPrice : bar.high >= p.stopPrice;
  const takeHit = p.takePrice != null && (d === 1 ? bar.high >= p.takePrice : bar.low <= p.takePrice);
  const gapThroughStop = d === 1 ? bar.open <= p.stopPrice : bar.open >= p.stopPrice;
  const gapThroughTake = p.takePrice != null && (d === 1 ? bar.open >= p.takePrice : bar.open <= p.takePrice);

  if (stopHit) {
    const price = gapThroughStop ? bar.open : p.stopPrice;
    return { position: finalize(p, price, bar.date, barIndex, 'stop', { gap: gapThroughStop, ambiguous: takeHit && !gapThroughStop }), closed: true };
  }
  if (takeHit) {
    const price = gapThroughTake ? bar.open : p.takePrice;
    return { position: finalize(p, price, bar.date, barIndex, 'take', { gap: gapThroughTake }), closed: true };
  }
  return { position: p, closed: false };
}

/** Закрыть вручную по заданной цене (обычно — по закрытию последней показанной свечи). */
export function closePosition(position, price, date, bar, reason = 'manual') {
  if (position.status !== 'open') return position;
  return finalize(clone(position), price, date, bar, reason);
}

/**
 * Прогнать позицию по списку следующих свечей до срабатывания стопа/тейка или конца данных.
 * Нужна для тестов и для режима «быстро показать, чем закончилось».
 */
export function runToEnd(position, bars, startIndex = 0) {
  let p = position;
  for (let i = 0; i < bars.length; i++) {
    const r = onBar(p, bars[i], startIndex + i);
    p = r.position;
    if (r.closed) return p;
  }
  return p;
}
