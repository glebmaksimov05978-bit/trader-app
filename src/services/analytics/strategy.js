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

// Price-relative conditions compare against the trader's own planned entry price when
// one exists (limit order in the Calculator) — comparing a limit-order plan against the
// *current* price answers the wrong question entirely (real user report: "он смотрит не
// ту цену по которой я хочу войти"). Falls back to the last close when there's no plan
// (Journal snapshot, Radar, Dashboard widget).
const refPrice = (ctx) => ctx.plan?.entryPrice ?? ctx.indicators?.close;

// %B relative to the reference price: with a planned entry the stored percentB (which
// was computed from the last close) is recomputed from the plan price against the same
// band values, so the checklist judges the trader's actual intended entry.
function bollingerPercentB(ctx, b) {
  const price = ctx.plan?.entryPrice;
  if (price == null) return b.percentB ?? null;
  if (b.upper == null || b.lower == null || b.upper === b.lower) return b.percentB ?? null;
  return (price - b.lower) / (b.upper - b.lower);
}

export const CONDITION_CATALOG = [
  // --- Market conditions: computed purely from the ticker, no plan needed -----------
  //
  // Every market condition gets the manual "лонг/шорт/оба" selector in Capital.js —
  // even RSI/MACD/EMA200, whose mean-reversion convention is common but not universal
  // (a momentum trader reads a stubbornly overbought RSI as trend strength — a long
  // signal, not a short one). Trying to guess a "right" hardcoded direction per
  // condition would just be wrong for that trader; a manual selector, defaulting to
  // 'both', costs nothing and never boxes anyone out. See evaluateStrategy for how an
  // opposite-direction condition gets quietly collapsed instead of shown as a failure.
  //
  // `defaultDirection` is a separate, softer thing — it's what the direction selector
  // starts on the FIRST time a trader enables this specific condition (toggleCondition
  // in Capital.js), not a permanent lock. Without it, a trader who enables both
  // rsi_below and rsi_above (the natural thing to do if they trade both ways) gets both
  // stuck on "оба" by default — and outside the Calculator (Radar, or before a
  // stop-loss is entered) direction is unknown, so BOTH evaluate and one of the pair is
  // mathematically guaranteed to fail every single time, quietly capping their % (real
  // user report — exactly this pairing, on Radar). Pre-selecting the conventional side
  // fixes that for anyone who doesn't deliberately change it, same convention already
  // used to explain the templates.
  {
    id: 'rsi_below', category: 'market', label: 'RSI ниже X (перепроданность)',
    paramLabel: 'RSI ниже', defaultParam: 35, defaultDirection: 'long',
    evaluate: (ctx, param) => {
      const v = ctx.indicators?.rsi14;
      if (v == null) return { na: true };
      return { passed: v < param, detail: `RSI ${v.toFixed(1)} ${v < param ? '<' : '≥'} ${param}` };
    },
  },
  {
    id: 'rsi_above', category: 'market', label: 'RSI выше X (перекупленность)',
    paramLabel: 'RSI выше', defaultParam: 65, defaultDirection: 'short',
    evaluate: (ctx, param) => {
      const v = ctx.indicators?.rsi14;
      if (v == null) return { na: true };
      return { passed: v > param, detail: `RSI ${v.toFixed(1)} ${v > param ? '>' : '≤'} ${param}` };
    },
  },
  {
    id: 'price_above_ema200', category: 'market', label: 'Цена выше EMA200 (восходящий тренд)', defaultDirection: 'long',
    evaluate: (ctx) => {
      const e = ctx.patterns?.emaLevels?.ema200;
      const price = refPrice(ctx);
      if (!e || e.value == null || price == null) return { na: true };
      const above = price >= e.value;
      const distPct = Math.abs(((price - e.value) / e.value) * 100);
      return { passed: above, detail: `Цена ${above ? 'выше' : 'ниже'} EMA200 на ${distPct.toFixed(1)}%` };
    },
  },
  {
    id: 'price_below_ema200', category: 'market', label: 'Цена ниже EMA200 (нисходящий тренд)', defaultDirection: 'short',
    evaluate: (ctx) => {
      const e = ctx.patterns?.emaLevels?.ema200;
      const price = refPrice(ctx);
      if (!e || e.value == null || price == null) return { na: true };
      const above = price >= e.value;
      const distPct = Math.abs(((price - e.value) / e.value) * 100);
      return { passed: !above, detail: `Цена ${above ? 'выше' : 'ниже'} EMA200 на ${distPct.toFixed(1)}%` };
    },
  },
  {
    id: 'macd_positive', category: 'market', label: 'MACD-гистограмма положительная', defaultDirection: 'long',
    evaluate: (ctx) => {
      const v = ctx.indicators?.macdHistogram;
      if (v == null) return { na: true };
      return { passed: v > 0, detail: `MACD гистограмма ${v.toFixed(2)}` };
    },
  },
  {
    id: 'macd_negative', category: 'market', label: 'MACD-гистограмма отрицательная', defaultDirection: 'short',
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
      const price = refPrice(ctx);
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
      const price = refPrice(ctx);
      if (!levels?.length || price == null) return { na: true };
      const nearest = levels.reduce((best, l) => Math.abs(price - l.price) < Math.abs(price - best.price) ? l : best);
      const distPct = (Math.abs(price - nearest.price) / price) * 100;
      return { passed: distPct <= param, detail: `Ближайшее сопротивление ${nearest.price.toFixed(2)}, ${distPct.toFixed(1)}% от цены` };
    },
  },
  {
    id: 'bollinger_lower', category: 'market', label: 'Цена у нижней полосы Боллинджера',
    paramLabel: 'Позиция в полосах (0 = нижняя, 1 = верхняя) не выше', defaultParam: 0.1,
    evaluate: (ctx, param) => {
      const b = ctx.indicators?.bollinger;
      if (!b) return { na: true };
      const pb = bollingerPercentB(ctx, b);
      if (pb == null) return { na: true };
      return { passed: pb <= param, detail: `Позиция цены в полосах: ${pb.toFixed(2)} (0 = нижняя, 1 = верхняя)` };
    },
  },
  {
    id: 'bollinger_upper', category: 'market', label: 'Цена у верхней полосы Боллинджера',
    paramLabel: 'Позиция в полосах (0 = нижняя, 1 = верхняя) не ниже', defaultParam: 0.9,
    evaluate: (ctx, param) => {
      const b = ctx.indicators?.bollinger;
      if (!b) return { na: true };
      const pb = bollingerPercentB(ctx, b);
      if (pb == null) return { na: true };
      return { passed: pb >= param, detail: `Позиция цены в полосах: ${pb.toFixed(2)} (0 = нижняя, 1 = верхняя)` };
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
  return { name: 'Моя стратегия', conditions: [], customConditions: [] };
}

// Presets for the "Свои условия" free-form list in Capital.js — real user request: give
// popular indicator/event names to pick from so a trader isn't inventing wording from
// scratch, without hardcoding an actual calculation for any of them (that's exactly the
// kind of exotic-indicator scope-creep the app deliberately avoids — see backlog notes).
// Picking a preset just fills the label text field; it's still a free-text condition
// underneath, editable like any other.
export const CUSTOM_CONDITION_PRESETS = [
  { group: 'Индикаторы', options: [
    'Стохастик в зоне перепроданности (<20)',
    'Стохастик в зоне перекупленности (>80)',
    'ADX выше 25 (сильный тренд)',
    'CCI ниже -100 (перепроданность)',
    'CCI выше +100 (перекупленность)',
    'Дивергенция RSI с ценой',
    'Объём подтверждает пробой',
    'Свеча-разворот на дневном графике (пин-бар/поглощение)',
  ]},
  { group: 'Фундаментал / новости', options: [
    'Нет важных новостей по эмитенту сегодня',
    'Нет заседания ЦБ РФ в ближайшие 2 дня',
    'Нет публикации отчётности эмитента на этой неделе',
    'Нет экспирации по инструменту в ближайшие 3 дня',
    'Общий новостной фон по рынку нейтральный/позитивный',
  ]},
];

// Starting drafts, not tuned presets — the numbers (and even which conditions belong
// in which tier) are a reasonable first guess based on how these styles are commonly
// described, not backtested against real outcomes (nobody has that data yet). Every
// field stays fully editable after loading a template; `readinessThreshold` is what
// the checklist verdict ("Готово к входу" vs "Рано — N%") compares the live match
// percentage against, and is meant to be nudged over time once a trader's own journal
// shows whether trades above/below their threshold actually did better.
export const STRATEGY_TEMPLATES = [
  {
    id: 'conservative',
    label: 'Консервативная — по тренду',
    description: 'Вход только по направлению тренда, строгие требования к R:R и риску. Реже сигналов, выше требовательность.',
    readinessThreshold: 80,
    conditions: [
      { id: 'price_above_ema200', enabled: true, param: null, direction: 'both' },
      { id: 'market_trending', enabled: true, param: null, direction: 'both' },
      { id: 'macd_positive', enabled: true, param: null, direction: 'both' },
      { id: 'min_rr', enabled: true, param: 3, direction: 'both' },
      { id: 'max_risk_percent', enabled: true, param: 0.5, direction: 'both' },
      { id: 'max_margin_usage', enabled: true, param: 15, direction: 'both' },
    ],
  },
  {
    id: 'moderate',
    label: 'Умеренная — отскок от уровня',
    description: 'Вход на перепроданности/перекупленности у уровня поддержки/сопротивления, средние требования к риску.',
    readinessThreshold: 60,
    conditions: [
      { id: 'near_support', enabled: true, param: 1, direction: 'both' },
      { id: 'rsi_below', enabled: true, param: 35, direction: 'both' },
      { id: 'min_rr', enabled: true, param: 2, direction: 'both' },
      { id: 'max_risk_percent', enabled: true, param: 1, direction: 'both' },
      { id: 'max_margin_usage', enabled: true, param: 30, direction: 'both' },
    ],
  },
  {
    id: 'aggressive',
    label: 'Агрессивная — пробой уровня',
    description: 'Вход на пробое сопротивления/поддержки с подтверждением объёмом, мягкие требования — больше сигналов, выше риск.',
    readinessThreshold: 40,
    conditions: [
      { id: 'near_resistance', enabled: true, param: 1, direction: 'both' },
      { id: 'volume_above_avg', enabled: true, param: 1.5, direction: 'both' },
      { id: 'market_trending', enabled: true, param: null, direction: 'both' },
      { id: 'min_rr', enabled: true, param: 1.5, direction: 'both' },
      { id: 'max_risk_percent', enabled: true, param: 2, direction: 'both' },
      { id: 'max_margin_usage', enabled: true, param: 50, direction: 'both' },
    ],
  },
];

// `strategy.conditions` = [{ id, enabled, param, direction }] — only enabled ones count.
// Direction binding decides which side of a trade a condition applies to. Some
// conditions (see `impliedDirection` in the catalog) have it hardcoded — the trader
// can't set those, the catalog's own value always wins. The rest default to
// `direction` ('long' | 'short' | 'both') the trader picked in Capital.js. A condition
// bound to the other side is excluded from N/M (like na), not failed. When the trade's
// direction isn't known yet (no stop-loss entered in the Calculator, or a Radar/
// Dashboard check with no plan at all), direction-bound conditions still evaluate
// normally — better to show both sides than to silently hide half the checklist.
// `strategy.customConditions` = [{ id, label, direction }] — free-text conditions the
// trader writes themselves for anything not in the catalog (exotic indicators,
// fundamental checks — see CUSTOM_CONDITION_PRESETS). There's no `evaluate` function for
// these; the app has no way to check a stochastic or a news calendar itself, so the
// trader ticks a plain checkbox by hand in the Calculator (`ctx.manualChecks[id]`) each
// time they analyze a ticker. Direction binding and na/skip behavior mirror the catalog
// conditions exactly, just without a computed `outcome` — `passed` comes straight from
// the checkbox.
export function evaluateStrategy(strategy, ctx) {
  const active = (strategy?.conditions || []).filter((c) => c.enabled && CATALOG_BY_ID[c.id]);
  const results = active.map((c) => {
    const def = CATALOG_BY_ID[c.id];
    const param = c.param ?? def.defaultParam;
    // The catalog's label is a template ("RSI выше X") — X is a placeholder, not a
    // literal letter the trader should ever see. Substituting the trader's own
    // configured number turns "RSI выше X — не соблюдается" into "RSI выше 65 — не
    // соблюдается" (real user report: seeing the raw template read as broken).
    const label = param != null ? def.label.replace('X', param) : def.label;
    const condDirection = def.impliedDirection || c.direction || 'both';
    if (condDirection !== 'both' && ctx.direction && ctx.direction !== condDirection) {
      return {
        id: c.id, label, param, na: true, skippedByDirection: true,
        detail: `Условие только для ${condDirection === 'long' ? 'лонга' : 'шорта'} — сделка в ${ctx.direction === 'long' ? 'лонг' : 'шорт'}`,
      };
    }
    const outcome = def.evaluate(ctx, param) || { na: true };
    return { id: c.id, label, param, direction: condDirection, ...outcome };
  });

  const customResults = (strategy?.customConditions || []).map((c) => {
    const condDirection = c.direction || 'both';
    if (condDirection !== 'both' && ctx.direction && ctx.direction !== condDirection) {
      return {
        id: c.id, label: c.label, custom: true, na: true, skippedByDirection: true,
        detail: `Условие только для ${condDirection === 'long' ? 'лонга' : 'шорта'} — сделка в ${ctx.direction === 'long' ? 'лонг' : 'шорт'}`,
      };
    }
    const checked = !!ctx.manualChecks?.[c.id];
    return {
      id: c.id, label: c.label, custom: true, direction: condDirection,
      passed: checked, detail: 'Отмечено вручную — приложение это не проверяет',
    };
  });

  const allResults = [...results, ...customResults];
  const evaluated = allResults.filter((r) => !r.na);
  const passed = evaluated.filter((r) => r.passed).length;
  return { total: evaluated.length, passed, results: allResults };
}
