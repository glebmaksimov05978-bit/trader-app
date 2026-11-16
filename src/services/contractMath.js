// src/services/contractMath.js
//
// Сколько рублей стоит движение цены на 1 пункт для ОДНОЙ единицы объёма сделки (лот акций или
// один фьючерсный контракт). Одна формула для результата, комиссии, риска и оборота — раньше их
// было несколько, и они разошлись.
//
// Главная тонкость — фьючерсы. Биржа даёт «стоимость шага цены» (STEPPRICE, у Т-Банка
// minPriceIncrementAmount) — это рубли за один минимальный шаг для ВСЕГО контракта, лот уже внутри.
// Проверено на спецификациях: Brent — шаг 0,01 $, лот 10 баррелей, стоимость шага ≈7,4 ₽ = 0,01×10×курс;
// Si — шаг 1, лот 1000 $, стоимость шага 1 ₽; фьючерс на Газпром — шаг 0,01, лот 100, стоимость 1 ₽.
// Поэтому рубли за пункт = стоимость шага / шаг, и умножать ещё раз на лот НЕЛЬЗЯ — раньше это
// завышало результат по фьючерсам с лотом больше единицы в «лот» раз (Brent ×10, Газпром ×100).
//
// Акции: рубли за пункт = лот (цена за одну акцию × акций в лоте).
//
// Чистые функции без зависимостей.

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : 0;
};

/** Фьючерс ли это: явная пометка, иначе — есть стоимость шага и это не акция. */
export function isFutureLike(t) {
  if (!t) return false;
  if (t.instrumentType === 'future' || t.isFuture === true) return true;
  if (t.instrumentType === 'stock' || t.instrumentType === 'currency') return false;
  return num(t.minStepAmount) > 0 && num(t.minStep) > 0;
}

/** Рубли за 1,0 пункта цены на одну единицу объёма (лот / контракт). */
export function rubPerPoint(t) {
  const lot = num(t?.lot) || 1;
  const step = num(t?.minStep);
  const stepAmt = num(t?.minStepAmount);
  if (isFutureLike(t) && step > 0 && stepAmt > 0) return stepAmt / step;
  return lot;
}

/** Стоимость позиции в рублях по цене price для qty единиц объёма — база для комиссии и оборота. */
export function positionValueRub(t, price, qty) {
  return num(price) * rubPerPoint(t) * num(qty);
}

/** Результат движения цены от entry до exit для qty единиц, в рублях, со знаком по направлению. */
export function moveRub(t, entry, exit, qty) {
  const dir = t?.direction === 'short' ? -1 : 1;
  return (num(exit) - num(entry)) * dir * rubPerPoint(t) * num(qty);
}

/** Комиссия «туда и обратно» по ставке rate (доля за сторону). */
export function roundTripCommission(t, price, qty, rate) {
  return positionValueRub(t, price, qty) * num(rate) * 2;
}

/**
 * Комиссия, которая относится к уже ЗАКРЫТОЙ части импортированной позиции: все комиссии закрытий + доля комиссии
 * входа на закрытый объём. У частично закрытого фьючерса раньше вычиталась комиссия входа за ВСЮ позицию — результат
 * был занижен, а при закрытии остатка вручную комиссия входа этой части учитывалась второй раз. У закрытой целиком
 * сделки число то же, что и раньше.
 */
export function realizedCommission(t) {
  const total = num(t?.commission);
  return Math.max(0, total - num(t?.openCommissionPerUnit) * num(t?.remainingVolume));
}

/** Результат импортированного фьючерса в рублях: накопленные «пункты × объём» × рубли за пункт − комиссия закрытой части. До копеек. */
export function pointsPnlRub(t, rubPerPt) {
  return Math.round((num(t?.pnlPoints) * num(rubPerPt) - realizedCommission(t)) * 100) / 100;
}

/**
 * Комиссия ОДНОЙ стороны сделки (вход или выход) в рублях, до копеек: стоимость позиции по этой цене × ставка.
 * При открытии сделки в неё пишется только комиссия входа (с пометкой entryCommissionIncluded) — комиссию выхода
 * добавляет закрытие. Раньше при открытии писалась комиссия «за круг», а закрытие прибавляло её ещё раз.
 */
export function sideCommission(t, price, qty, rate) {
  return Math.round(positionValueRub(t, price, qty) * num(rate) * 100) / 100;
}

/**
 * Итог сделки по истории операций брокера (кнопка «Синхронизировать с Т-Банком» в Журнале): объём, остаток, средние
 * цены входа и выхода, результат и комиссия — той же формулой, что и обычное закрытие. Раньше синхронизация меняла
 * только статус и остаток: сделка становилась «закрыта», а результат оставался пустым или старым.
 *
 * Брокер отдаёт акции в штуках, а Журнал ведёт объём в лотах: у акции с лотом больше 1 количество делится на лот
 * (если делится нацело; иначе операции оставляются как есть и units = 'shares' — такую сделку надо проверить руками).
 *
 * @param {object} trade  сделка журнала (instrumentType, direction, lot, minStep, minStepAmount)
 * @param {Array<{type:'open'|'close', price:number, quantity:number, timestampUtc:any}>} legs
 * @param {number} rate   ставка комиссии за сторону
 */
export function summarizeLegs(trade, legs, rate) {
  const r2 = (v) => Math.round(v * 100) / 100;
  const lot = num(trade?.lot) || 1;
  let list = (Array.isArray(legs) ? legs : []).filter((l) => l && (l.type === 'open' || l.type === 'close') && num(l.quantity) > 0);
  let units = 'lots';
  if (!isFutureLike(trade) && lot > 1) {
    if (list.every((l) => Number.isInteger(num(l.quantity) / lot))) list = list.map((l) => ({ ...l, quantity: num(l.quantity) / lot }));
    else units = 'shares';
  }
  const opens = list.filter((l) => l.type === 'open');
  const closes = list.filter((l) => l.type === 'close');
  const opened = opens.reduce((s, l) => s + num(l.quantity), 0);
  const closed = closes.reduce((s, l) => s + num(l.quantity), 0);
  if (!(opened > 0)) return null;
  const entryPrice = opens.reduce((s, l) => s + num(l.price) * num(l.quantity), 0) / opened;
  const exitPrice = closed > 0 ? closes.reduce((s, l) => s + num(l.price) * num(l.quantity), 0) / closed : null;
  let pnl = 0;
  let exitCommission = 0;
  for (const l of closes) {
    const q = num(l.quantity), px = num(l.price);
    const commission = (positionValueRub(trade, entryPrice, q) + positionValueRub(trade, px, q)) * num(rate);
    pnl += r2(moveRub(trade, entryPrice, px, q) - commission);
    exitCommission += r2(positionValueRub(trade, px, q) * num(rate));
  }
  const remaining = Math.max(0, opened - closed);
  const lastClose = closes.length ? closes[closes.length - 1].timestampUtc : null;
  return {
    legs: list, units,
    volume: opened, remainingVolume: remaining,
    status: remaining <= 1e-9 ? 'closed' : (closed > 0 ? 'partial' : 'open'),
    entryPrice, exitPrice,
    pnl: closed > 0 ? r2(pnl) : null,
    commission: r2(sideCommission(trade, entryPrice, opened, rate) + exitCommission),
    closedAt: remaining <= 1e-9 ? lastClose : null,
  };
}
