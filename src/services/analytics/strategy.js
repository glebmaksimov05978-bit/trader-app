// src/services/analytics/strategy.js
//
// "Моя стратегия" — a checklist the trader builds themselves out of a catalog of
// conditions computed by the earlier modules (indicators.js, patterns.js) plus the
// trader's own plan numbers from the Calculator (R:R, risk %, margin usage). This file
// only ever counts pass/fail against thresholds the trader picked — it never invents an
// opinion of its own, matching the "AI/algorithms give facts, human decides" principle.
//
// A condition is EXCLUDED from the N/M count (not counted as failed) when the data it
// needs isn't available yet (e.g. SMA/EMA200 on a freshly-listed ticker, or no plan
// entered in the Calculator) — an honest "не хватает данных", not a silent fail.

export const CONDITION_CATALOG = [
  // --- Market conditions: computed purely from the ticker, no plan needed -----------
  {
    id: 'rsi_below', category: 'market', label: 'RSI ниже X (перепроданность)',
    paramLabel: 'RSI ниже', defaultParam: 35,
    evaluate: (ctx, param) => {
      const v = ctx.indicators?.rsi14;
      if (v == null) return { na: true };
      return { passed: v < param, detail: `RSI ${v.toFixed(1)} ${v < param ? '<' : '≥'} ${param}` };
    },
  },
  {
    id: 'rsi_above', category: 'market', label: 'RSI выше X (перекупленность)',
    paramLabel: 'RSI выше', defaultParam: 65,
    evaluate: (ctx, param) => {
      const v = ctx.indicators?.rsi14;
      if (v == null) return { na: true };
      return { passed: v > param, detail: `RSI ${v.toFixed(1)} ${v > param ? '>' : '≤'} ${param}` };
    },
  },
  {
    id: 'price_above_ema200', category: 'market', label: 'Цена выше EMA200 (восходящий тренд)',
    evaluate: (ctx) => {
      const e = ctx.patterns?.emaLevels?.ema200;
      if (!e) return { na: true };
      return { passed: e.position === 'above', detail: `Цена ${e.position === 'above' ? 'выше' : 'ниже'} EMA200 на ${Math.abs(e.distancePct).toFixed(1)}%` };
    },
  },
  {
    id: 'price_below_ema200', category: 'market', label: 'Цена ниже EMA200 (нисходящий тренд)',
    evaluate: (ctx) => {
      const e = ctx.patterns?.emaLevels?.ema200;
      if (!e) return { na: true };
      return { passed: e.position === 'below', detail: `Цена ${e.position === 'above' ? 'выше' : 'ниже'} EMA200 на ${Math.abs(e.distancePct).toFixed(1)}%` };
    },
  },
  {
    id: 'macd_positive', category: 'market', label: 'MACD-гистограмма положительная',
    evaluate: (ctx) => {
      const v = ctx.indicators?.macdHistogram;
      if (v == null) return { na: true };
      return { passed: v > 0, detail: `MACD гистограмма ${v.toFixed(2)}` };
    },
  },
  {
    id: 'macd_negative', category: 'market', label: 'MACD-гистограмма отрицательная',
    evaluate: (ctx) => {
      const v = ctx.indicators?.macdHistogram;
      if (v == null) return { na: true };
      return { passed: v < 0, detail: `MACD гистограмма ${v.toFixed(2)}` };
    },
  },
  {
    id: 'pattern_confirmed', category: 'market', label: 'Есть подтверждённая фигура с уверенностью ≥ X%',
    paramLabel: 'Уверенность от', defaultParam: 60,
    evaluate: (ctx, param) => {
      const candidates = ctx.patterns?.candidates;
      if (!candidates) return { na: true };
      const best = candidates.filter((c) => c.status === 'confirmed').sort((a, b) => b.confidence - a.confidence)[0];
      if (!best) return { passed: false, detail: 'Подтверждённых фигур нет' };
      return { passed: best.confidence >= param, detail: `Лучшая фигура — ${best.confidence}%` };
    },
  },
  {
    id: 'near_support', category: 'market', label: 'Цена рядом с уровнем поддержки (в пределах X%)',
    paramLabel: 'В пределах, %', defaultParam: 1,
    evaluate: (ctx, param) => {
      const levels = ctx.patterns?.supportResistance?.filter((l) => l.type === 'support');
      const price = ctx.indicators?.close;
      if (!levels?.length || price == null) return { na: true };
      const nearest = levels.reduce((best, l) => Math.abs(price - l.price) < Math.abs(price - best.price) ? l : best);
      const distPct = (Math.abs(price - nearest.price) / price) * 100;
      return { passed: distPct <= param, detail: `Ближайшая поддержка ${nearest.price.toFixed(2)}, ${distPct.toFixed(1)}% от цены` };
    },
  },
  {
    id: 'near_resistance', category: 'market', label: 'Цена рядом с уровнем сопротивления (в пределах X%)',
    paramLabel: 'В пределах, %', defaultParam: 1,
    evaluate: (ctx, param) => {
      const levels = ctx.patterns?.supportResistance?.filter((l) => l.type === 'resistance');
      const price = ctx.indicators?.close;
      if (!levels?.length || price == null) return { na: true };
      const nearest = levels.reduce((best, l) => Math.abs(price - l.price) < Math.abs(price - best.price) ? l : best);
      const distPct = (Math.abs(price - nearest.price) / price) * 100;
      return { passed: distPct <= param, detail: `Ближайшее сопротивление ${nearest.price.toFixed(2)}, ${distPct.toFixed(1)}% от цены` };
    },
  },
  {
    id: 'bollinger_lower', category: 'market', label: 'Цена у нижней полосы Боллинджера (%B ≤ X)',
    paramLabel: '%B не выше', defaultParam: 0.1,
    evaluate: (ctx, param) => {
      const b = ctx.indicators?.bollinger;
      if (!b) return { na: true };
      return { passed: b.percentB <= param, detail: `%B = ${b.percentB.toFixed(2)}` };
    },
  },
  {
    id: 'bollinger_upper', category: 'market', label: 'Цена у верхней полосы Боллинджера (%B ≥ X)',
    paramLabel: '%B не ниже', defaultParam: 0.9,
    evaluate: (ctx, param) => {
      const b = ctx.indicators?.bollinger;
      if (!b) return { na: true };
      return { passed: b.percentB >= param, detail: `%B = ${b.percentB.toFixed(2)}` };
    },
  },
  {
    id: 'volume_above_avg', category: 'market', label: 'Объём выше среднего в X раз',
    paramLabel: 'Не меньше, ×', defaultParam: 1.3,
    evaluate: (ctx, param) => {
      const v = ctx.indicators?.volumeRatio;
      if (v == null) return { na: true };
      return { passed: v >= param, detail: `Объём ${v.toFixed(2)}× от среднего` };
    },
  },
  {
    id: 'market_trending', category: 'market', label: 'Рынок в тренде (не в боковике)',
    evaluate: (ctx) => {
      const t = ctx.marketContext?.trend;
      if (!t) return { na: true };
      return { passed: t.label !== 'sideways', detail: `Тренд: ${t.label === 'up' ? 'восходящий' : t.label === 'down' ? 'нисходящий' : 'боковик'} (${t.slopePct >= 0 ? '+' : ''}${t.slopePct.toFixed(1)}%)` };
    },
  },
  {
    id: 'market_sideways', category: 'market', label: 'Рынок в боковике (не в тренде)',
    evaluate: (ctx) => {
      const t = ctx.marketContext?.trend;
      if (!t) return { na: true };
      return { passed: t.label === 'sideways', detail: `Тренд: ${t.label === 'up' ? 'восходящий' : t.label === 'down' ? 'нисходящий' : 'боковик'} (${t.slopePct >= 0 ? '+' : ''}${t.slopePct.toFixed(1)}%)` };
    },
  },
  {
    id: 'volatility_not_high', category: 'market', label: 'Волатильность не повышена',
    evaluate: (ctx) => {
      const v = ctx.marketContext?.volatility;
      if (!v) return { na: true };
      return { passed: v.label !== 'high', detail: `Волатильность: ${v.ratio.toFixed(2)}× от обычной` };
    },
  },

  // --- Plan conditions: computed from the trader's own Calculator inputs -------------
  {
    id: 'min_rr', category: 'plan', label: 'Соотношение риск/прибыль не хуже 1:X',
    paramLabel: 'Минимум 1:', defaultParam: 2,
    evaluate: (ctx, param) => {
      const rr = ctx.plan?.rr;
      if (rr == null) return { na: true };
      return { passed: rr >= param, detail: `R:R = 1:${rr.toFixed(1)}` };
    },
  },
  {
    id: 'max_risk_percent', category: 'plan', label: 'Риск на сделку не больше X% депозита',
    paramLabel: 'Не больше, %', defaultParam: 1,
    evaluate: (ctx, param) => {
      const risk = ctx.plan?.riskPercent;
      if (risk == null) return { na: true };
      return { passed: risk <= param, detail: `Риск на сделку ${risk.toFixed(2)}%` };
    },
  },
  {
    id: 'max_margin_usage', category: 'plan', label: 'Загрузка депозита не больше X%',
    paramLabel: 'Не больше, %', defaultParam: 30,
    evaluate: (ctx, param) => {
      const margin = ctx.plan?.marginUsagePercent;
      if (margin == null) return { na: true };
      return { passed: margin <= param, detail: `Загрузка депозита ${margin}%` };
    },
  },
];

const CATALOG_BY_ID = Object.fromEntries(CONDITION_CATALOG.map((c) => [c.id, c]));

export function defaultStrategy() {
  return { name: 'Моя стратегия', conditions: [] };
}

// `strategy.conditions` = [{ id, enabled, param }] — only enabled ones count.
export function evaluateStrategy(strategy, ctx) {
  const active = (strategy?.conditions || []).filter((c) => c.enabled && CATALOG_BY_ID[c.id]);
  const results = active.map((c) => {
    const def = CATALOG_BY_ID[c.id];
    const param = c.param ?? def.defaultParam;
    const outcome = def.evaluate(ctx, param) || { na: true };
    return { id: c.id, label: def.label, param, ...outcome };
  });
  const evaluated = results.filter((r) => !r.na);
  const passed = evaluated.filter((r) => r.passed).length;
  return { total: evaluated.length, passed, results };
}
