// src/services/leverageMath.js
//
// Плечо фьючерса и «что можно купить на мои деньги» — одни и те же формулы для радара, Калькулятора, Журнала, Сопровождения и линейки на графике.
//
// Зачем отдельный модуль. ГО у контракта меняется постоянно, и смотреть на ГО в рублях неудобно: цифра «прыгает» и ничего не говорит о риске.
// Плечо — стоимость контракта ÷ ГО — это то, что реально нужно знать: на сколько процентов от замороженных под ГО денег сдвигает счёт
// движение цены на 1 %. Движение цены на 1 % при плече 9× — это ≈9 % от ГО. Поэтому:
//   • плечо — главное число, ГО в рублях рядом, вторым;
//   • НИЧЕГО НЕ ОКРУГЛЯЕТСЯ до целых: плечо показывается с двумя знаками (8,97×), ГО — с копейками, если они есть. Решение владельца
//     2026-11-10: при десятках контрактов округление до целого плеча или рубля даёт заметную ошибку в общей сумме;
//   • числа берутся ГО БРОКЕРА (Т-Банка), через которого идут сделки; биржевое ГО — только запасной вариант и подписывается «биржа»;
//   • «сколько можно купить» считается по ГО СТОРОНЫ сделки (лонг и шорт у брокера разные) и по лимиту доли депозита под ГО (по умолчанию 30 %).
//
// Чистые функции, без зависимостей.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Плечо для показа — всегда с двумя знаками, без округления до целого: «8,97×». Нет плеча — пустая строка. */
export function leverageText(l) {
  const v = num(l);
  if (!(v > 0)) return '';
  return `${v.toLocaleString('ru-RU', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}×`;
}

/** Плечо числом для сохранения в сделке: точное (до 4 знаков — только чтобы убрать хвост двоичной дроби), без округления до целого. */
export function leverageValue(l) {
  const v = num(l);
  if (!(v > 0)) return null;
  return Math.round(v * 10000) / 10000;
}

/** Рубли для ГО и итоговых сумм: копейки показываются, если они есть (2 750,56 ₽), иначе целые (3 300 ₽). Ничего не теряется на округлении. */
export function rubText(v) {
  const n = Number(v);
  if (!Number.isFinite(n)) return '';
  const r = Math.round(n * 100) / 100;
  return `${r.toLocaleString('ru-RU', { minimumFractionDigits: Number.isInteger(r) ? 0 : 2, maximumFractionDigits: 2 })} ₽`;
}

/** Плечо = стоимость контракта в рублях / ГО (на одну сторону). 0 — считать не из чего. */
export function leverageOf(valueRub, marginRub) {
  const v = num(valueRub), m = num(marginRub);
  return v > 0 && m > 0 ? v / m : 0;
}

/**
 * Что можно купить на мои деньги по одному контракту — отдельно лонг и шорт.
 * @param {object} a
 * @param {number} a.deposit           сумма, с которой считаем (депозит или капитал стратегии), ₽
 * @param {number} [a.maxMarginPercent=30]  какую долю депозита разрешено держать под ГО, %
 * @param {number} a.marginBuy         ГО на покупку (лонг), ₽ за контракт
 * @param {number} [a.marginSell]      ГО на продажу (шорт); нет — берётся как у лонга
 * @param {number} a.valueRub          стоимость одного контракта, ₽ (цена / шаг × стоимость шага)
 * @returns {null|{long:object, short:object, valueRub:number, depositUsed:number, maxMarginPercent:number}}
 */
export function capacityByDirection({ deposit, maxMarginPercent = 30, marginBuy, marginSell, valueRub }) {
  const dep = num(deposit), pct = num(maxMarginPercent) > 0 ? num(maxMarginPercent) : 30;
  const buy = num(marginBuy), sell = num(marginSell) > 0 ? num(marginSell) : buy;
  if (!(dep > 0) || !(buy > 0)) return null;
  const side = (margin) => {
    const byLimit = Math.floor((dep * pct / 100) / margin);   // по лимиту доли депозита под ГО
    const physical = Math.floor(dep / margin);                  // предел, когда под ГО уходит весь депозит
    return {
      margin, maxByLimit: byLimit, maxPhysical: physical,
      leverage: leverageOf(valueRub, margin),
      // сколько процентов депозита займёт один контракт и все разрешённые
      oneUsesPct: (margin / dep) * 100,
      limitUsesPct: byLimit > 0 ? ((byLimit * margin) / dep) * 100 : 0,
    };
  };
  return { long: side(buy), short: side(sell), valueRub: num(valueRub), depositUsed: dep, maxMarginPercent: pct };
}

/** Одна строка «на ваши деньги»: «лонг до 3 контр. · шорт до 2 контр.» (в пределах лимита ГО). */
export function capacityLine(cap, { unit = 'контр.' } = {}) {
  if (!cap) return '';
  const part = (name, s) => (s.maxByLimit > 0 ? `${name} до ${s.maxByLimit} ${unit}` : `${name}: не хватает денег`);
  return `${part('лонг', cap.long)} · ${part('шорт', cap.short)}`;
}

/** Результат сделки в процентах от замороженного под ГО (доходность на ГО). null — ГО неизвестно. */
export function returnOnMarginPct(pnlRub, marginRubTotal) {
  const m = num(marginRubTotal);
  return m > 0 && Number.isFinite(Number(pnlRub)) ? (Number(pnlRub) / m) * 100 : null;
}

/** Сколько % от ГО даёт ход цены на pricePct % при плече leverage (линейка и подсказки). */
export function movePctOnMargin(pricePct, leverage) {
  const l = num(leverage);
  return l > 0 && Number.isFinite(Number(pricePct)) ? Number(pricePct) * l : null;
}

/**
 * Плечо и ГО по сохранённой сделке журнала. Берёт записанное при открытии (leverageAtEntry, marginPerContract); если сделка старая —
 * восстанавливает по цене входа, шагу цены, стоимости шага и ГО, если они в ней есть.
 * @returns {null|{leverage:number, margin:number, marginTotal:number, source:string|null, stored:boolean}}
 */
export function tradeLeverage(t) {
  if (!t || !(t.instrumentType === 'future' || t.isFuture === true)) return null;
  const vol = num(t.volume);
  const margin = num(t.marginPerContract);
  const stored = num(t.leverageAtEntry);
  if (stored > 0 && margin > 0) return { leverage: stored, margin, marginTotal: margin * vol, source: t.marginSource || null, stored: true };
  if (stored > 0) return { leverage: stored, margin: 0, marginTotal: 0, source: t.marginSource || null, stored: true };
  const entry = num(t.entryPrice), step = num(t.minStep), stepAmt = num(t.minStepAmount);
  if (margin > 0 && entry > 0 && step > 0 && stepAmt > 0) {
    return { leverage: leverageOf((entry / step) * stepAmt, margin), margin, marginTotal: margin * vol, source: t.marginSource || null, stored: false };
  }
  return null;
}

/**
 * Подпись линейки для фьючерса: во сколько рублей обходится ход на один контракт и сколько это от ГО.
 * Ход вверх меряется ГО на покупку (лонг), ход вниз — ГО на продажу (шорт): «сколько % от СВОЕГО ГО дала бы позиция по ходу линейки».
 * @param {{delta:number, pct:number|null}} stats  из rulerStats
 * @param {{rubPerPoint:number, margin:number, marginSell?:number, startPrice?:number, src?:string}} contract
 *   margin — ГО на покупку, marginSell — на продажу (нет — как у покупки), src — 'tbank' | 'moex'
 * @returns {string} — например «≈ +520 ₽ на контракт · +19,25 % от ГО (плечо 9,03×)»; пустая строка, если данных нет
 */
export function rulerContractText(stats, contract) {
  if (!stats || !contract) return '';
  const rpp = num(contract.rubPerPoint);
  if (!(rpp > 0)) return '';
  const margin = stats.delta >= 0 ? num(contract.margin) : (num(contract.marginSell) || num(contract.margin));
  const rub = stats.delta * rpp;
  const sign = rub >= 0 ? '+' : '−';
  const fmt = (v) => Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: 2 });
  const parts = [`≈ ${sign}${fmt(rub)} ₽ на контракт`];
  if (margin > 0) {
    const onMargin = (rub / margin) * 100;
    const lev = contract.startPrice > 0 ? leverageText(leverageOf(contract.startPrice * rpp, margin)) : '';
    parts.push(`${sign}${fmt(onMargin)} % от ГО${lev ? ` (плечо ${lev})` : ''}${contract.src && contract.src !== 'tbank' ? ' · ГО биржи' : ''}`);
  }
  return parts.join(' · ');
}
