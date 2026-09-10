// src/services/analytics/strategyKind.js
//
// Тип стратегии: пробойная, откатная, трендовая — или смешанная.
//
// Зачем: сохранённые стратегии в приложении были плоским списком имён. «Моя стратегия»
// и «Стратегия 2» ничего не говорят ни о том, чем они отличаются, ни о том, чего от них
// ждать. Тип считается ИЗ УСЛОВИЙ, а не спрашивается у трейдера: он и так уже описал
// стратегию, когда включал галочки, — переспрашивать значит просить его сделать работу
// дважды и получить расхождение между тем, что он выбрал, и тем, как стратегия торгует.
//
// Ключевая тонкость — направление. Одно и то же условие означает противоположные вещи:
// «цена у сопротивления» + покупка = игра на пробой, «цена у сопротивления» + продажа =
// игра от уровня. Поэтому вес считается по паре (условие, направление), а не по условию.

export const STRATEGY_KINDS = {
  breakout: {
    id: 'breakout',
    label: 'Пробойная',
    short: 'вход на выходе цены из диапазона',
    // Характер подхода, а не измеренная статистика этого трейдера: описывает, как такие
    // стратегии ведут себя в принципе. Реальные цифры — ниже, в разборе по сделкам.
    character: 'Входов мало, но движения после верного пробоя крупные. Главный риск — ложный '
      + 'пробой: цена выходит за уровень, собирает стопы и возвращается обратно.',
  },
  pullback: {
    id: 'pullback',
    label: 'Откатная',
    short: 'вход от уровня или из перепроданности, против текущего движения',
    character: 'Входов много, прибыль в каждом обычно небольшая. Главный риск — «ловить падающий '
      + 'нож»: уровень не держит, и одна сделка съедает прибыль нескольких удачных.',
  },
  trend: {
    id: 'trend',
    label: 'Трендовая',
    short: 'вход по направлению уже существующего тренда',
    character: 'Сделки длинные, прибыльных меньше половины — но выигрыши крупнее проигрышей. '
      + 'Главный риск — зайти в конце движения, когда тренд уже выдохся.',
  },
  mixed: {
    id: 'mixed',
    label: 'Смешанная',
    short: 'условия из разных подходов, единого типа нет',
    character: 'В стратегии смешаны признаки разных подходов. Это не ошибка, но и ждать от неё '
      + 'характерного поведения одного типа не стоит — она ведёт себя по обстоятельствам.',
  },
  none: {
    id: 'none',
    label: 'Без рыночных условий',
    short: 'включены только правила риска или свои текстовые пункты',
    character: 'Рыночных условий в стратегии нет — приложению нечего проверять на графике. '
      + 'Тип определится, как только вы включите хотя бы одно условие по рынку.',
  },
};

// Вес: сколько «голосов» условие даёт каждому типу. Направление 'both' читается в
// естественном смысле условия (от поддержки обычно покупают, а не пробивают её вниз).
// Числа здесь — не подгонка под данные, а прямое выражение смысла условия: 1 — условие
// само по себе означает этот подход, 0.5 — лишь склоняет к нему.
const WEIGHTS = {
  near_support:   { long: { pullback: 1 }, short: { breakout: 1 }, both: { pullback: 1 } },
  near_resistance:{ long: { breakout: 1 }, short: { pullback: 1 }, both: { pullback: 1 } },
  bollinger_lower:{ long: { pullback: 1 }, short: { breakout: 0.5 }, both: { pullback: 1 } },
  bollinger_upper:{ long: { breakout: 0.5 }, short: { pullback: 1 }, both: { pullback: 1 } },
  rsi_below:      { long: { pullback: 1 }, short: { trend: 0.5 }, both: { pullback: 1 } },
  rsi_above:      { long: { trend: 0.5 }, short: { pullback: 1 }, both: { pullback: 1 } },
  price_above_ema200: { any: { trend: 1 } },
  price_below_ema200: { any: { trend: 1 } },
  macd_positive:      { any: { trend: 0.5 } },
  macd_negative:      { any: { trend: 0.5 } },
  market_trending:    { any: { trend: 1, breakout: 0.5 } },
  market_sideways:    { any: { pullback: 1 } },
  volume_above_avg:   { any: { breakout: 1 } },
  momentum_favor:     { any: { breakout: 1, trend: 0.5 } },
  volatility_not_high:{ any: { pullback: 0.5 } },
  pattern_confirmed:  { any: { breakout: 0.5 } },
  // Условия плана (min_rr, max_risk_percent, max_margin_usage) — это управление риском,
  // а не способ входа: они одинаковы у любого подхода и на тип не влияют.
};

const READABLE = {
  near_support: 'уровень поддержки',
  near_resistance: 'уровень сопротивления',
  bollinger_lower: 'нижняя полоса Боллинджера',
  bollinger_upper: 'верхняя полоса Боллинджера',
  rsi_below: 'перепроданность по RSI',
  rsi_above: 'перекупленность по RSI',
  price_above_ema200: 'цена выше EMA200',
  price_below_ema200: 'цена ниже EMA200',
  macd_positive: 'MACD в плюсе',
  macd_negative: 'MACD в минусе',
  market_trending: 'рынок в тренде',
  market_sideways: 'рынок в боковике',
  volume_above_avg: 'повышенный объём',
  momentum_favor: 'импульс в сторону сделки',
  volatility_not_high: 'спокойная волатильность',
  pattern_confirmed: 'подтверждённая фигура',
};

/**
 * @param {object} strategy - сохранённая стратегия (conditions[], customConditions[])
 * @returns {{kind: string, label: string, short: string, character: string,
 *           confidence: 'clear'|'leaning'|'mixed', scores: object, why: string[]}}
 */
export function classifyStrategy(strategy) {
  const scores = { breakout: 0, pullback: 0, trend: 0 };
  const why = { breakout: [], pullback: [], trend: [] };

  for (const c of (strategy?.conditions || [])) {
    if (!c?.enabled) continue;
    const spec = WEIGHTS[c.id];
    if (!spec) continue;
    const dir = c.direction === 'long' || c.direction === 'short' ? c.direction : 'both';
    const table = spec.any || spec[dir] || spec.both || {};
    for (const [kind, w] of Object.entries(table)) {
      scores[kind] += w;
      if (w >= 1 && READABLE[c.id]) why[kind].push(READABLE[c.id]);
    }
  }

  const total = scores.breakout + scores.pullback + scores.trend;
  if (total === 0) {
    return {
      ...STRATEGY_KINDS.none, kind: 'none', confidence: 'clear', scores, why: [],
    };
  }

  const ranked = Object.entries(scores).sort((a, b) => b[1] - a[1]);
  const [topKind, topScore] = ranked[0];
  const secondScore = ranked[1][1];
  const share = topScore / total;

  // Порог намеренно мягкий: стратегия из двух условий не обязана быть «чистым» типом,
  // но если верхний тип не отрывается от следующего — честнее сказать «смешанная»,
  // чем назначить тип и потом объяснять им поведение, которого нет.
  const confidence = (topScore - secondScore) >= 1 && share >= 0.5 ? 'clear'
    : (topScore - secondScore) >= 0.5 ? 'leaning'
      : 'mixed';

  if (confidence === 'mixed') {
    return {
      ...STRATEGY_KINDS.mixed, kind: 'mixed', confidence, scores,
      why: [...new Set([...why.breakout, ...why.pullback, ...why.trend])].slice(0, 4),
    };
  }

  return {
    ...STRATEGY_KINDS[topKind], kind: topKind, confidence, scores,
    why: [...new Set(why[topKind])].slice(0, 4),
  };
}

/** Короткая строка для бейджа: «Пробойная» / «Скорее трендовая». */
export function kindBadge(classification) {
  if (!classification) return '';
  if (classification.confidence === 'leaning') return `Скорее ${classification.label.toLowerCase()}`;
  return classification.label;
}

/**
 * Как реально торговали стратегии трейдера — по закрытым сделкам, а не по замыслу.
 * Сделка помнит стратегию, по которой была открыта (entryStrategyId/entryStrategyName из
 * Калькулятора). Старые сделки этого поля не имеют и попадают в группу «без стратегии» —
 * это честнее, чем приписать их активной сегодня.
 *
 * @param {object[]} trades
 * @param {object[]} strategies - сохранённые стратегии профиля (для типа и текущего имени)
 */
export function strategyPerformance(trades, strategies = []) {
  const byId = new Map(strategies.map((s) => [s.id, s]));
  const byName = new Map(strategies.map((s) => [s.name, s]));
  const groups = new Map();

  for (const t of trades) {
    const closed = (t.status === 'closed' || t.status === 'partial') && t.pnl != null;
    if (!closed) continue;
    const strat = (t.entryStrategyId && byId.get(t.entryStrategyId))
      || (t.entryStrategyName && byName.get(t.entryStrategyName))
      || null;
    const key = strat?.id || t.entryStrategyName || '__none__';
    const cur = groups.get(key) || {
      key,
      name: strat?.name || t.entryStrategyName || 'Без стратегии',
      classification: strat ? classifyStrategy(strat) : null,
      exists: !!strat,
      count: 0, wins: 0, pnl: 0,
    };
    cur.count += 1;
    cur.pnl += t.pnl;
    if (t.pnl > 0) cur.wins += 1;
    groups.set(key, cur);
  }

  return [...groups.values()]
    .map((g) => ({ ...g, winrate: g.count ? (g.wins / g.count) * 100 : 0, avgPnl: g.count ? g.pnl / g.count : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
}
