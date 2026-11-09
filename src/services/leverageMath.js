// src/services/leverageMath.js
//
// Плечо фьючерса и «что можно купить на мои деньги» — одни и те же формулы для радара, Калькулятора, Журнала, Сопровождения и линейки на графике.
//
// Зачем отдельный модуль. ГО у контракта меняется постоянно (биржа пересматривает его чаще, чем кажется), и смотреть на ГО в рублях неудобно: цифра
// «прыгает» и ничего не говорит о риске. Плечо — стоимость контракта ÷ ГО — это то, что реально нужно знать: на сколько процентов от замороженных
// под ГО денег сдвигает счёт движение цены на 1 %. Движение цены на 1 % при плече 9× — это ≈9 % от ГО. Поэтому:
//   • плечо показывается ОКРУГЛЁННЫМ (9×, а не 8,98×) — оно не должно «рябить» от каждого тика цены;
//   • ГО в рублях остаётся рядом, но вторым числом;
//   • «сколько можно купить» считается по ГО СТОРОНЫ сделки (лонг и шорт у брокера разные) и по лимиту доли депозита под ГО (по умолчанию 30 %).
//
// Чистые функции, без зависимостей.

const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

/** Плечо для показа: до 5× — с одним знаком после запятой (3,4×), от 5× — целым (9×). Нет плеча — пустая строка. */
export function leverageText(l) {
  const v = num(l);
  if (!(v > 0)) return '';
  const r = v >= 5 ? Math.round(v) : Math.round(v * 10) / 10;
  return `${r.toLocaleString('ru-RU', { maximumFractionDigits: 1 })}×`;
}

/** Плечо числом для сохранения в сделке: тот же шаг округления, что и в тексте (чтобы запись и подпись совпадали). */
export function leverageValue(l) {
  const v = num(l);
  if (!(v > 0)) return null;
  return v >= 5 ? Math.round(v) : Math.round(v * 10) / 10;
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
 * @param {{delta:number, pct:number|null}} stats  из rulerStats
 * @param {{rubPerPoint:number, margin:number, startPrice?:number}} contract
 * @returns {string} — например «≈ +520 ₽ на контракт · +19 % от ГО (плечо 9×)»; пустая строка, если данных нет
 */
export function rulerContractText(stats, contract) {
  if (!stats || !contract) return '';
  const rpp = num(contract.rubPerPoint), margin = num(contract.margin);
  if (!(rpp > 0)) return '';
  const rub = stats.delta * rpp;
  const sign = rub >= 0 ? '+' : '−';
  const fmt = (v, d = 0) => Math.abs(v).toLocaleString('ru-RU', { maximumFractionDigits: d });
  const parts = [`≈ ${sign}${fmt(rub)} ₽ на контракт`];
  if (margin > 0) {
    const onMargin = (rub / margin) * 100;
    const lev = contract.startPrice > 0 ? leverageText(leverageOf(contract.startPrice * rpp, margin)) : '';
    parts.push(`${sign}${fmt(onMargin, Math.abs(onMargin) < 10 ? 1 : 0)} % от ГО${lev ? ` (плечо ${lev})` : ''}`);
  }
  return parts.join(' · ');
}
