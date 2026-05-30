// src/utils/calculator.js

/**
 * Calculate trade parameters for futures
 */
export function calcTrade({
  entryPrice,
  stopLoss,
  takeProfit,
  depositSize,
  riskPercent,
  lot = 1,              // contract lot size
  minStep = 1,          // min price step
  minStepAmount = 0,    // value of min step in RUB
  initialMargin = 0,    // ГО per contract
  commissionRate = 0.0006, // 0.06% default MOEX futures
}) {
  const entry = parseFloat(entryPrice) || 0;
  const sl = parseFloat(stopLoss) || 0;
  const tp = parseFloat(takeProfit) || 0;
  const deposit = parseFloat(depositSize) || 0;
  const risk = parseFloat(riskPercent) || 0;
  const iMargin = parseFloat(initialMargin) || 0;
  const step = parseFloat(minStep) || 1;
  const stepAmt = parseFloat(minStepAmount) || 0;
  const l = parseFloat(lot) || 1;

  if (!entry || !sl || !deposit || !risk) return null;

  const direction = entry > sl ? 'long' : 'short';

  // Risk amount in RUB
  const riskAmount = (deposit * risk) / 100;

  // Ticks between entry and SL
  const ticksToSL = Math.abs(entry - sl) / step;

  // Loss per contract (in RUB) = ticks * stepAmount * lot
  const lossPerContract = stepAmt > 0
    ? ticksToSL * stepAmt * l
    : ticksToSL * step * l; // fallback if no stepAmount

  // Number of contracts
  const contracts = lossPerContract > 0 ? Math.floor(riskAmount / lossPerContract) : 0;

  // Total ГО required
  const totalMargin = contracts * iMargin;

  // Commission (entry + exit, both sides)
  const notional = entry * contracts * l;
  const commission = notional * commissionRate * 2;

  // Risk/Reward
  const rr = tp > 0 ? Math.abs(tp - entry) / Math.abs(entry - sl) : 0;

  // Breakeven (considering commission)
  const commissionPerContract = notional > 0 ? commission / contracts : 0;
  const breakevenTicks = lossPerContract > 0 ? commissionPerContract / (stepAmt || step) : 0;
  const breakeven = direction === 'long'
    ? entry + breakevenTicks * step
    : entry - breakevenTicks * step;

  // Potential profit
  const ticksToTP = tp > 0 ? Math.abs(tp - entry) / step : 0;
  const profitPerContract = stepAmt > 0
    ? ticksToTP * stepAmt * l
    : ticksToTP * step * l;
  const totalProfit = profitPerContract * contracts - commission;
  const totalLoss = lossPerContract * contracts + commission;

  return {
    direction,
    riskAmount: Math.round(riskAmount),
    contracts,
    totalMargin: Math.round(totalMargin),
    commission: Math.round(commission),
    rr: Math.round(rr * 100) / 100,
    breakeven: Math.round(breakeven * 10) / 10,
    ticksToSL: Math.round(ticksToSL),
    ticksToTP: Math.round(ticksToTP),
    lossPerContract: Math.round(lossPerContract * 100) / 100,
    profitPerContract: Math.round(profitPerContract * 100) / 100,
    totalProfit: Math.round(totalProfit),
    totalLoss: Math.round(totalLoss),
    marginUsagePercent: deposit > 0 ? Math.round((totalMargin / deposit) * 100) : 0,
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
  return n.toLocaleString('ru-RU', { style: 'currency', currency: 'RUB', maximumFractionDigits: 0 });
}
