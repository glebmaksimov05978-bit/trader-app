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
  } else {
    // Фьючерс: убыток = тики × стоимость шага × лот
    lossPerContract = stepAmt > 0
      ? ticksToSL * stepAmt * l
      : ticksToSL * step * l;
  }

  // Количество по риску
  const contractsByRisk = lossPerContract > 0
    ? Math.floor(riskAmount / lossPerContract)
    : 0;

  // Ограничение по ГО (только для фьючерсов)
  const marginLimit = (maxMarginPercent || 30) / 100;
  const maxContractsByMargin = (instrumentType === 'future' && iMargin > 0)
    ? Math.floor((deposit * marginLimit) / iMargin)
    : contractsByRisk;

  // Для акций — ограничение по стоимости позиции (не более 90% депозита)
  const maxContractsByPosition = instrumentType === 'stock'
    ? Math.floor((deposit * 0.9) / (entry * l))
    : contractsByRisk;

  const contracts = Math.min(
    contractsByRisk,
    maxContractsByMargin,
    maxContractsByPosition
  );

  const totalMargin    = instrumentType === 'future' ? contracts * iMargin : 0;
  const positionValue  = Math.round(entry * contracts * l);
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
  } else {
    profitPerContract = stepAmt > 0
      ? ticksToTP * stepAmt * l
      : ticksToTP * step * l;
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
