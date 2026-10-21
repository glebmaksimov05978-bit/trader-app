// src/utils/calculator.js

export function calcTrade({
  entryPrice,
  stopLoss,
  takeProfit,
  depositSize,
  riskPercent,
  lot = 1,
  minStep = 1,
  minStepAmount = 0,
  initialMargin = 0,
  commissionRate = 0.0006,
  maxMarginPercent = 30,
  instrumentType = 'future',
}) {
  const entry   = parseFloat(entryPrice) || 0;
  const sl      = parseFloat(stopLoss)   || 0;
  const tp      = parseFloat(takeProfit) || 0;
  const deposit = parseFloat(depositSize) || 0;
  const risk    = parseFloat(riskPercent) || 0;
  const iMargin = parseFloat(initialMargin) || 0;
  const step    = parseFloat(minStep) || 1;
  const stepAmt = parseFloat(minStepAmount) || 0;
  const l       = parseFloat(lot) || 1;

  if (!entry || !sl || !deposit || !risk) return null;

  const direction = sl < entry ? 'long' : 'short';
  if (direction === 'long'  && sl >= entry) return null;
  if (direction === 'short' && sl <= entry) return null;

  const riskAmount = (deposit * risk) / 100;
  const ticksToSL  = Math.abs(entry - sl) / step;

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
  const commissionPerContract = entry * rubPerPt * commissionRate * 2;
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
  const positionValue  = Math.round(entry * contracts * rubPerPt);
  const notional       = positionValue;
  const commission     = notional * commissionRate * 2;

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

  const totalProfit = profitPerContract * contracts - commission;
  const totalLoss   = lossPerContract   * contracts + commission;

  // Точка безубытка
  const commPerContract = contracts > 0 ? commission / contracts : 0;
  const bevenTicks      = lossPerContract > 0 ? commPerContract / (stepAmt || step) : 0;
  const breakeven       = direction === 'long'
    ? entry + bevenTicks * step
    : entry - bevenTicks * step;

  const marginUsedRub     = instrumentType === 'future' ? totalMargin : positionValue;
  const marginUsagePercent = deposit > 0
    ? Math.round((marginUsedRub / deposit) * 100)
    : 0;

  return {
    direction,
    riskAmount:          Math.round(riskAmount),
    contracts,
    contractsByRisk,
    maxContractsByMargin,
    totalMargin:         Math.round(totalMargin),
    positionValue,
    commission:          Math.round(commission),
    rr:                  Math.round(rr * 100) / 100,
    rrValid,
    breakeven:           Math.round(breakeven * 10) / 10,
    ticksToSL:           Math.round(ticksToSL),
    ticksToTP:           Math.round(ticksToTP),
    lossPerContract:     Math.round(lossPerContract   * 100) / 100,
    profitPerContract:   Math.round(profitPerContract * 100) / 100,
    totalProfit:         Math.round(totalProfit),
    totalLoss:           Math.round(totalLoss),
    marginUsagePercent,
    maxMarginPercent:    maxMarginPercent || 30,
    limitedByMargin:     contracts < contractsByRisk,
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
