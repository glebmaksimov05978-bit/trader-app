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
