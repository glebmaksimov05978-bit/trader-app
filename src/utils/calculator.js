// src/utils/calculator.js

// До копеек.
const r2 = (v) => Math.round(v * 100) / 100;

// Комиссии плана сделки в рублях: «за круг» по цене входа (справочно), вход+выход по стопу, вход+выход по цели.
function planCommissions(entry, sl, tp, contracts, rubPerPt, rate) {
  const side = (price) => price * rubPerPt * contracts * rate;
  return {
    commission: side(entry) * 2,
    commissionAtStop: side(entry) + side(sl),
    commissionAtTake: tp > 0 ? side(entry) + side(tp) : side(entry) * 2,
  };
}

// Цена, на которой сделка выходит в ноль с учётом комиссии обеих сторон (комиссия выхода — по цене выхода):
// лонг: вход × (1 + ставка) / (1 − ставка); шорт — наоборот. От объёма не зависит. Округляется в сторону «с запасом»
// (раньше округлялось до 0,1 — для нефти с шагом 0,01 это ошибка в десятки рублей на контракт).
function breakevenPrice(entry, direction, rate, step, onStepGrid) {
  const raw = direction === 'long' ? entry * (1 + rate) / (1 - rate) : entry * (1 - rate) / (1 + rate);
  const decimalsOf = (v) => { const t = String(v); const i = t.indexOf('.'); return i === -1 ? 0 : t.length - i - 1; };
  const away = (x) => (direction === 'long' ? Math.ceil(x - 1e-7) : Math.floor(x + 1e-7));
  // Фьючерс: цена ходит только по сетке шага — берём первую цену на сетке, где сделка уже не в минусе.
  if (onStepGrid && step > 0) return Number((away(raw / step) * step).toFixed(Math.min(8, decimalsOf(step))));
  // Акция: шаг в форме бывает не заполнен — считаем с точностью цены входа, но не грубее копейки.
  const k = 10 ** Math.min(6, Math.max(2, decimalsOf(step), decimalsOf(entry)));
  return away(raw * k) / k;
}

export function calcTrade({
  entryPrice,
  stopLoss,
  takeProfit,
  depositSize,
  riskPercent,
  lot = 1,
  minStep = 1,
  minStepAmount = 0,
  // ГО на контракт. У Т-Банка оно РАЗНОЕ для покупки и продажи (initial_margin_on_buy /
  // initial_margin_on_sell) и меняется со временем: лонг считается по первому, шорт — по второму.
  // `initialMargin` — одно число «на обе стороны» (ручной ввод, биржа MOEX отдаёт одно значение);
  // оно берётся, только если для нужной стороны своего ГО нет.
  initialMargin = 0,
  initialMarginBuy = 0,
  initialMarginSell = 0,
  commissionRate = 0.0006,
  maxMarginPercent = 30,
  instrumentType = 'future',
}) {
  const entry   = parseFloat(entryPrice) || 0;
  const sl      = parseFloat(stopLoss)   || 0;
  const tp      = parseFloat(takeProfit) || 0;
  const deposit = parseFloat(depositSize) || 0;
  const risk    = parseFloat(riskPercent) || 0;
  const iMarginAny = parseFloat(initialMargin) || 0;
  const iMarginBuy = parseFloat(initialMarginBuy) || 0;
  const iMarginSell = parseFloat(initialMarginSell) || 0;
  const step    = parseFloat(minStep) || 1;
  const stepAmt = parseFloat(minStepAmount) || 0;
  const l       = parseFloat(lot) || 1;

  if (!entry || !sl || !deposit || !risk) return null;

  const direction = sl < entry ? 'long' : 'short';
  if (direction === 'long'  && sl >= entry) return null;
  if (direction === 'short' && sl <= entry) return null;

  const riskAmount = (deposit * risk) / 100;
  const ticksToSL  = Math.abs(entry - sl) / step;

  // ГО именно той стороны, с которой открывается сделка (лонг — покупка, шорт — продажа).
  // Раньше брали меньшее из двух для любой сделки: у шорта Роснефти (RNZ6) это занижало ГО
  // на четверть, и ограничение «не больше 30% депозита под ГО» пропускало на треть больше
  // контрактов, чем разрешено на самом деле.
  const sideMargin = direction === 'long' ? iMarginBuy : iMarginSell;
  const iMargin = sideMargin > 0 ? sideMargin : iMarginAny;

  // Убыток на единицу (контракт для фьючерса, лот для акции)
  let lossPerContract;
  if (instrumentType === 'stock') {
    // Акция: убыток = (разница цен) × лотность
    lossPerContract = Math.abs(entry - sl) * l;
  } else if (stepAmt > 0) {
    // Фьючерс, известна реальная "стоимость шага" (STEPPRICE с MOEX): это цена ОДНОГО
    // тика для ВСЕГО контракта целиком, лот уже заложен внутрь этого числа биржей.
    // Проверено на реальных спецификациях: GAZPF 0.01×100=1, CNYRUBF 0.001×1000=1,
    // IMOEXF 0.5×10=5 — во всех случаях step×lot точно равен STEPPRICE. Умножение на
    // `l` ещё раз (как было раньше) задирало убыток на контракт в `l` раз — контракт
    // ГАЗПРОМА для риск-сайзинга считался в 100 раз дороже, чем есть на самом деле,
    // валютные фьючерсы (лот 1000) — в 1000 раз. Реальный баг, найден 2026-08-27 при
    // проверке капитал-эффективности фьючерсов, где это давало абсурдные значения ГО.
    lossPerContract = ticksToSL * stepAmt;
  } else {
    // Запасной путь, когда биржа не прислала реальную STEPPRICE (в частности мини-
    // контракты без apiTradeAvailableFlag) — тут `step` это цена за ЕДИНИЦУ базового
    // актива, поэтому лот действительно нужно умножить отдельно.
    lossPerContract = ticksToSL * step * l;
  }

  // Количество по риску — учитывает и будущую комиссию (круглый рейс: вход + выход), не
  // только убыток по стопу. Комиссия на 1 контракт не зависит от их количества (она сама
  // растёт линейно вместе с contracts), поэтому её можно честно прибавить к убытку на
  // контракт ещё ДО деления. Раньше комиссия нигде не участвовала в подборе количества
  // контрактов — только вычиталась из итога после: при риске, скажем, 1000₽, реальный
  // максимальный убыток получался немного БОЛЬШЕ 1000₽ (риск% + комиссия), а не ровно
  // заявленный риск (реальная находка трейдера/Клода при разборе точности бэктеста).
  // Рубли за 1 пункт цены на одну единицу объёма — та же формула, что в services/contractMath.js:
  // у фьючерса со стоимостью шага это «стоимость шага / шаг» (лот уже внутри), иначе — лот.
  // Комиссия считается от стоимости позиции в рублях: раньше у фьючерсов брали цену в пунктах
  // (у Brent 80 вместо 60 000 ₽ за контракт) и комиссия выходила в сотни раз меньше настоящей.
  const rubPerPt = instrumentType !== 'stock' && stepAmt > 0 && step > 0 ? stepAmt / step : l;
  // Комиссия берётся с каждой стороны по ЕЁ цене: вход — по цене входа, выход по стопу — по цене стопа
  // (раньше обе стороны считались по цене входа — расхождение с брокером в рублях на десятке контрактов).
  const commissionPerContract = (entry + sl) * rubPerPt * commissionRate;
  const effectiveLossPerContract = lossPerContract + commissionPerContract;
  const contractsByRisk = effectiveLossPerContract > 0
    ? Math.floor(riskAmount / effectiveLossPerContract)
    : 0;

  // Ограничение по ГО (фьючерсы) или стоимости позиции (акции)
  const marginLimit = (maxMarginPercent || 30) / 100;
  const maxContractsByMargin = (instrumentType === 'future' && iMargin > 0)
    ? Math.floor((deposit * marginLimit) / iMargin)
    : contractsByRisk;

  // Для акций — ограничение по стоимости позиции (тот же лимит maxMarginPercent%)
  const maxContractsByPosition = instrumentType === 'stock'
    ? Math.floor((deposit * marginLimit) / (entry * l))
    : contractsByRisk;

  const contracts = Math.min(
    contractsByRisk,
    maxContractsByMargin,
    maxContractsByPosition
  );

  const totalMargin    = instrumentType === 'future' ? contracts * iMargin : 0;
  const positionValue  = r2(entry * contracts * rubPerPt);
  const { commission, commissionAtStop, commissionAtTake } = planCommissions(entry, sl, tp, contracts, rubPerPt, commissionRate);

  // RR с учётом направления
  let rr = 0;
  let rrValid = true;
  if (tp > 0) {
    const tpDist = direction === 'long' ? tp - entry : entry - tp;
    const slDist = Math.abs(entry - sl);
    rr = slDist > 0 ? tpDist / slDist : 0;
    rrValid = direction === 'long' ? tp > entry : tp < entry;
  }

  const ticksToTP = tp > 0 ? Math.abs(tp - entry) / step : 0;

  let profitPerContract;
  if (instrumentType === 'stock') {
    profitPerContract = Math.abs(tp - entry) * l;
  } else if (stepAmt > 0) {
    // Same fix as lossPerContract above — STEPPRICE already includes the lot.
    profitPerContract = ticksToTP * stepAmt;
  } else {
    profitPerContract = ticksToTP * step * l;
  }

  const totalProfit = profitPerContract * contracts - commissionAtTake;
  const totalLoss   = lossPerContract   * contracts + commissionAtStop;

  // Точка безубытка. Рубли за один шаг цены на одну единицу объёма — ровно та же величина, что
  // стоит в убытке на контракт выше: у фьючерса со стоимостью шага это она, иначе шаг × лот.
  // Раньше делили на голый шаг цены без лота: у акций с лотом 10 (SBER) безубыток уходил в
  // десять раз дальше, чем есть (показывало 303 вместо 300,3 при цене входа 300).
  const breakeven = breakevenPrice(entry, direction, commissionRate, step, instrumentType !== 'stock' && stepAmt > 0);

  const marginUsedRub     = instrumentType === 'future' ? totalMargin : positionValue;
  const marginUsagePercent = deposit > 0
    ? Math.round((marginUsedRub / deposit) * 1000) / 10   // доля депозита — с десятой: 30,4 % при лимите 30 % не должно превращаться в «30 %»
    : 0;

  // Плечо по ГО: во сколько раз стоимость контракта больше замороженного под него ГО.
  const contractValue = entry * rubPerPt;
  const leverage = instrumentType === 'future' && iMargin > 0 ? contractValue / iMargin : 0;

  return {
    direction,
    // ГО одного контракта, которое реально использовано, и какой стороны оно было.
    marginPerContract:   Math.round(iMargin * 100) / 100,
    marginSide:          sideMargin > 0 ? direction : (iMargin > 0 ? 'any' : 'none'),
    leverage:            Math.round(leverage * 10000) / 10000,   // плечо не округляется до десятых: на десятках контрактов разница заметна
    // Рубли за 1 пункт цены на единицу объёма (нужно, чтобы пересчитать итог на другое число контрактов).
    rubPerPoint:         rubPerPt,
    riskAmount:          r2(riskAmount),
    contracts,
    contractsByRisk,
    maxContractsByMargin,
    totalMargin:         Math.round(totalMargin * 100) / 100,    // ГО на все контракты — до копеек, а не до рубля
    positionValue,
    commission:          r2(commission),          // вход + выход по цене входа — справочная «комиссия за круг»
    commissionAtStop:    r2(commissionAtStop),    // вход + выход по стопу — входит в «Макс. убыток»
    commissionAtTake:    r2(commissionAtTake),    // вход + выход по цели — входит в «Потенц. прибыль»
    rr:                  Math.round(rr * 100) / 100,
    rrValid,
    breakeven,
    ticksToSL:           Math.round(ticksToSL),
    ticksToTP:           Math.round(ticksToTP),
    lossPerContract:     Math.round(lossPerContract   * 100) / 100,
    profitPerContract:   Math.round(profitPerContract * 100) / 100,
    totalProfit:         r2(totalProfit),
    totalLoss:           r2(totalLoss),
    marginUsagePercent,
    maxMarginPercent:    maxMarginPercent || 30,
    limitedByMargin:     contracts < contractsByRisk,
  };
}

/**
 * Пересчёт итогов Калькулятора на другое число контрактов (когда трейдер ввёл объём руками).
 * Все деньги — через рубли за пункт (`result.rubPerPoint`) и ГО стороны сделки
 * (`result.marginPerContract`). Раньше здесь стояла своя копия формулы с голым лотом: у фьючерса
 * Brent комиссия получалась 0,06 ₽ вместо 48 ₽, а стоимость позиции 80 ₽ вместо 60 000 ₽.
 */
export function scaleToContracts(result, n, { entryPrice, commissionRate = 0.0006, depositSize, instrumentType = 'future' }) {
  if (!result) return null;
  const entry = parseFloat(entryPrice) || 0;
  const rate = parseFloat(commissionRate) || 0.0006;
  const deposit = parseFloat(depositSize) || 1;
  const positionValue = r2(entry * n * result.rubPerPoint);
  // Цены стопа и цели восстанавливаются из убытка/прибыли на контракт — комиссия выхода считается по ним, а не по входу.
  const rpp = result.rubPerPoint || 1;
  const dir = result.direction === 'short' ? -1 : 1;
  const sl = entry - dir * (result.lossPerContract / rpp);
  const tp = result.profitPerContract > 0 ? entry + dir * (result.profitPerContract / rpp) : 0;
  const { commission, commissionAtStop, commissionAtTake } = planCommissions(entry, sl, tp, n, rpp, rate);
  const totalMargin = instrumentType === 'future' ? Math.round(result.marginPerContract * n * 100) / 100 : 0;
  const marginUsed = instrumentType === 'future' ? totalMargin : positionValue;
  return {
    ...result,
    contracts: n,
    commission: r2(commission),
    commissionAtStop: r2(commissionAtStop),
    commissionAtTake: r2(commissionAtTake),
    totalLoss: r2(result.lossPerContract * n + commissionAtStop),
    totalProfit: r2(result.profitPerContract * n - commissionAtTake),
    totalMargin,
    positionValue,
    marginUsagePercent: Math.round((marginUsed / deposit) * 1000) / 10,
    maxMarginPercent: result.maxMarginPercent || 30,
  };
}

export function formatNumber(n, decimals = 0) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toLocaleString('ru-RU', {
    minimumFractionDigits: decimals,
    maximumFractionDigits: decimals,
  });
}

export function formatCurrency(n) {
  if (n === undefined || n === null || isNaN(n)) return '—';
  return n.toLocaleString('ru-RU', {
    style: 'currency', currency: 'RUB', maximumFractionDigits: 0,
  });
}
