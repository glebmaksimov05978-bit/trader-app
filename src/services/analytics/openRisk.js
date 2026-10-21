// src/services/analytics/openRisk.js
//
// Общий риск открытых позиций: сколько потеряет счёт, если одновременно сработают ВСЕ стопы.
// Одна сделка с риском 1% — спокойно; три стратегии по одному тикеру в одну сторону — это уже 3%,
// и в журнале по отдельности этого не видно.
//
// Риск считается теми же единицами, что результат при закрытии (tradeClose.computeClosePnl): шаг
// цены и стоимость шага для фьючерсов, лот для акций. Чистые функции без зависимостей.

const num = (v) => {
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
};

const isOpen = (t) => t && (t.status === 'open' || t.status === 'partial');

/** Рубли на единицу цены для одной позиции: «сколько стоит ход цены на 1 пункт». */
function rubPerPriceUnit(t) {
  // То же правило, что в services/contractMath.js (здесь продублировано, чтобы модуль оставался без
  // зависимостей для роботов): у фьючерса стоимость шага уже включает лот, у акции — лот.
  const lot = num(t.lot) || 1;
  const step = num(t.minStep) || 0;
  const stepAmt = num(t.minStepAmount) || 0;
  const future = t.instrumentType === 'future' || t.isFuture === true
    || (t.instrumentType !== 'stock' && t.instrumentType !== 'currency' && step > 0 && stepAmt > 0);
  if (future && step > 0 && stepAmt > 0) return stepAmt / step;
  return lot;
}

/**
 * Риск одной позиции.
 * @returns {{ id, ticker, direction, strategy, riskRub, notional, hasStop, sizingOnly, remaining, src }}
 */
export function positionRisk(t, src = 'real') {
  const entry = num(t.entryPrice);
  const stop = num(t.stopLoss);
  const vol = num(t.remainingVolume ?? t.volume) || 0;
  const per = rubPerPriceUnit(t);
  const hasStop = stop != null && stop > 0 && entry != null;
  const riskRub = hasStop ? Math.abs(entry - stop) * per * vol : null;
  return {
    id: t.id || null,
    ticker: String(t.ticker || '—').toUpperCase(),
    direction: t.direction === 'short' ? 'short' : 'long',
    strategy: t.entryStrategyName || (src === 'paper' ? 'Без названия' : 'Вручную'),
    strategyId: t.entryStrategyId || null,
    riskRub,
    notional: entry != null ? entry * per * vol : null,
    hasStop,
    // Стоп, заведённый только для расчёта объёма (у стратегии сознательно нет стопа): это не
    // заявка на выход, а допущение о риске — число честное, но защиты в рынке за ним нет.
    sizingOnly: t.stopIsSizingOnly === true,
    remaining: vol,
    src,
  };
}

/**
 * @param {object} a
 * @param {Array} a.trades — реальные сделки (все; открытые отберём сами)
 * @param {Array} [a.paper] — бумажные сделки
 * @param {number} a.deposit — депозит, ₽
 * @param {number} [a.dailyLossLimitPct] — дневной лимит убытка, % депозита
 * @param {number} [a.maxRiskPerTradePct] — риск на сделку, % депозита
 */
export function buildOpenRisk({ trades = [], paper = [], deposit = 0, dailyLossLimitPct = null, maxRiskPerTradePct = null }) {
  const dep = num(deposit) || 0;
  const pct = (rub) => (dep > 0 && rub != null ? (rub / dep) * 100 : null);

  const real = (trades || []).filter(isOpen).map((t) => positionRisk(t, 'real'));
  const pap = (paper || []).filter(isOpen).map((t) => positionRisk(t, 'paper'));

  const sum = (arr, f) => arr.reduce((s, x) => s + (f(x) || 0), 0);
  const known = (arr) => arr.filter((x) => x.riskRub != null);

  const total = {
    count: real.length,
    riskRub: sum(known(real), (x) => x.riskRub),
    riskPct: null,
    notional: sum(real, (x) => x.notional),
    exposurePct: null,
    withoutStop: real.filter((x) => !x.hasStop).length,
    sizingOnly: real.filter((x) => x.sizingOnly).length,
  };
  total.riskPct = pct(total.riskRub);
  total.exposurePct = pct(total.notional);

  const group = (arr, keyFn, nameFn) => {
    const m = new Map();
    for (const x of arr) {
      const k = keyFn(x);
      if (!m.has(k)) m.set(k, { key: k, name: nameFn(x), items: [] });
      m.get(k).items.push(x);
    }
    return [...m.values()].map((g) => {
      const riskRub = sum(known(g.items), (x) => x.riskRub);
      return {
        key: g.key, name: g.name, count: g.items.length, riskRub, riskPct: pct(riskRub),
        strategies: [...new Set(g.items.map((x) => x.strategy))],
        directions: [...new Set(g.items.map((x) => x.direction))],
      };
    }).sort((a, b) => b.riskRub - a.riskRub);
  };

  const byTicker = group(real, (x) => x.ticker, (x) => x.ticker).map((g) => ({ ...g, ticker: g.key }));
  const byStrategy = group(real, (x) => x.strategyId || x.strategy, (x) => x.strategy);

  const warnings = [];
  for (const t of byTicker) {
    if (t.count >= 2 && t.directions.length === 1) {
      warnings.push({
        code: 'same_ticker',
        text: `${t.name}: ${t.count} позиции в одну сторону (${t.strategies.join(', ')}) — риск складывается: ${Math.round(t.riskRub).toLocaleString('ru-RU')} ₽`
          + (t.riskPct != null ? ` (${t.riskPct.toFixed(1)}% депозита)` : '') + '.',
      });
    }
  }
  if (dailyLossLimitPct != null && total.riskPct != null && total.riskPct > dailyLossLimitPct) {
    warnings.push({
      code: 'over_daily_limit',
      text: `Если сработают все стопы, потеря составит ${total.riskPct.toFixed(1)}% депозита — больше дневного лимита ${dailyLossLimitPct}%.`,
    });
  }
  if (maxRiskPerTradePct != null) {
    const big = real.filter((x) => x.riskRub != null && pct(x.riskRub) > maxRiskPerTradePct * 1.5);
    for (const b of big) {
      warnings.push({
        code: 'big_position',
        text: `${b.ticker}: риск ${pct(b.riskRub).toFixed(1)}% депозита — выше вашего лимита на сделку (${maxRiskPerTradePct}%).`,
      });
    }
  }
  if (total.withoutStop > 0) {
    warnings.push({
      code: 'no_stop',
      text: `У ${total.withoutStop} позиц${total.withoutStop === 1 ? 'ии' : 'ий'} нет стопа — их риск в сумму не входит и может быть больше.`,
    });
  }

  const paperRisk = {
    count: pap.length,
    riskRub: sum(known(pap), (x) => x.riskRub),
    riskPct: null,
  };
  paperRisk.riskPct = pct(paperRisk.riskRub);

  return { total, byTicker, byStrategy, positions: real, warnings, paper: paperRisk, deposit: dep };
}
