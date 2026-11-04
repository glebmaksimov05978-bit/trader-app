// src/services/marketData/brokerMargin.js
//
// Гарантийное обеспечение (ГО) и «плечо» фьючерса из ответа брокера (Т-Банк, метод FutureBy).
//
// Зачем отдельный модуль. У Т-Банка ГО РАЗНОЕ для покупки и для продажи (initial_margin_on_buy /
// initial_margin_on_sell) и меняется со временем (у Роснефти на 12.10.2026: лонг 7 439 ₽, шорт
// 9 455 ₽; у большинства контрактов разница около 3%). Биржа (MOEX ISS) отдаёт одно число без
// деления на стороны. Поэтому объём и загрузку капитала нужно считать по ГО СТОРОНЫ сделки, а
// одно «среднее» число — только запасной вариант.
//
// Модуль чистый и без зависимостей: его подгружают роботы (GitHub Actions) и тесты.

const money = (v) => (v ? Number(v.units || 0) + Number(v.nano || 0) / 1e9 : 0);

/**
 * @param {object} instrument - поле `instrument` из ответа InstrumentsService/FutureBy
 * @returns {{initialMarginBuy:number, initialMarginSell:number, dlongClient:number|null,
 *            dshortClient:number|null, shortEnabled:boolean|null, buyAvailable:boolean|null,
 *            sellAvailable:boolean|null}|null} — null, если брокер не прислал ни того, ни другого ГО
 */
export function parseBrokerFutureMargin(instrument) {
  if (!instrument) return null;
  const buy = money(instrument.initialMarginOnBuy);
  const sell = money(instrument.initialMarginOnSell);
  if (!(buy > 0) && !(sell > 0)) return null;
  return {
    // Если брокер прислал только одну сторону — вторую заполняем ею же (лучше, чем «ГО нет»).
    initialMarginBuy: buy > 0 ? buy : sell,
    initialMarginSell: sell > 0 ? sell : buy,
    dlongClient: money(instrument.dlongClient) || null,
    dshortClient: money(instrument.dshortClient) || null,
    shortEnabled: instrument.shortEnabledFlag ?? null,
    buyAvailable: instrument.buyAvailableFlag ?? null,
    sellAvailable: instrument.sellAvailableFlag ?? null,
  };
}

/** Плечо контракта по ГО стороны: стоимость контракта в рублях / ГО. 0, если считать не из чего. */
export function futuresLeverage(contractValueRub, marginRub) {
  const v = Number(contractValueRub);
  const m = Number(marginRub);
  return v > 0 && m > 0 ? v / m : 0;
}
