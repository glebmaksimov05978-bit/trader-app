// src/services/strategyBuilder/ruleSpec.js
//
// Язык правил «Моего сетапа» (генератор стратегий, шаг 1). Стратегия — это обычный JSON: на чём торгую (класс
// инструментов), на каком таймфрейме, какой у неё характер, условия входа (каждое: признак → сравнение → число) и
// выход. Этот JSON собирает конструктор руками; позже (после переезда на Яндекс) его же будет заполнять ИИ из текста —
// поэтому всё, что ИИ может написать, обязано пройти validateSpec и быть понятным человеку через describeCondition.
//
// Главные решения (согласовано с владельцем 2026-11-17):
//   • считают только алгоритмы; признаки — причинные (на баре i — только бары ≤ i, см. features.js);
//   • расстояния — и в процентах, и в ATR (выбор у каждого условия);
//   • у каждого условия есть ДОПУСК (±%): сделки делятся на «точно подходят» и «почти подходят»;
//   • вход либо «все условия», либо «баллы» (каждое условие весит сколько-то, вход от суммы);
//   • стратегия знает свой класс инструментов — проверка не смешивает акции с опционами;
//   • «характер» (тренд, отскок, пробой, новости…) меняет то, чем меряем результат;
//   • признаки без истории (стакан, новости) делают стратегию «только для бумажной торговли».

export const SPEC_VERSION = 1;

export const TIMEFRAME_MINUTES = { M5: 5, M10: 10, M15: 15, H1: 60, D1: 1440 };
export const TIMEFRAME_LABELS = { M5: 'М5', M10: 'М10', M15: 'М15', H1: 'Ч1', D1: 'Д1' };

// Классы инструментов. Проверка по журналу и по истории идёт только внутри класса стратегии; опционы и облигации
// в техническую проверку не попадают никогда — у них цена живёт по другим законам (время до экспирации, купон).
export const INSTRUMENT_CLASSES = {
  stock: { label: 'Акции', testable: true },
  future: { label: 'Фьючерсы', testable: true },
  currency: { label: 'Валюта', testable: true },
  bond: { label: 'Облигации', testable: false },
  option: { label: 'Опционы', testable: false },
  fund: { label: 'Фонды', testable: true },
};

// Группы фьючерсов: нефть с индексом не смешиваем, если человек сам этого не захотел.
export const FUTURE_GROUPS = {
  oil: { label: 'Нефть', roots: ['BR', 'CL', 'WTI', 'BM'] },
  gas: { label: 'Газ', roots: ['NG', 'NR'] },
  // Только корни, в которых уверены; незнакомый корень попадает в «На акции» — человек может поправить список руками.
  index: { label: 'Индексы', roots: ['MX', 'MM', 'RI', 'RM', 'IMOEXF', 'RTS', 'MIX', 'SPYF'] },
  currency: { label: 'Валюта', roots: ['SI', 'EU', 'CR', 'ED', 'UC', 'CNY', 'USDRUBF', 'EURRUBF', 'CNYRUBF'] },
  metals: { label: 'Металлы', roots: ['GD', 'GL', 'GOLD', 'SV', 'SILV', 'PT', 'PD', 'GLDRUBF'] },
  stock: { label: 'На акции', roots: [] }, // всё остальное у фьючерсов — как правило, контракты на акции (SBRF, GAZR…)
};

const FUT_RE = /^([A-Z]{2,6})([FGHJKMNQUVXZ])(\d)$/;
const PERP_RE = /^([A-Z]{3,8})F$/;
const CURRENCY_RE = /^(USD|EUR|CNY|HKD|KZT|BYN|TRY|AED|GLD|SLV)(RUB|000)/;

/** Корень фьючерса: BRZ6 → BR, IMOEXF → IMOEXF, SiH7 → SI. */
export function futureRoot(ticker) {
  const t = String(ticker || '').toUpperCase();
  const m = t.match(FUT_RE);
  if (m) return m[1];
  if (PERP_RE.test(t)) return t;
  return t;
}

export function futureGroupOf(ticker) {
  const root = futureRoot(ticker);
  for (const [id, g] of Object.entries(FUTURE_GROUPS)) {
    if (g.roots.some((r) => root === r || (r.length >= 2 && root.startsWith(r) && root.length <= r.length + 1))) return id;
  }
  return 'stock';
}

/** Класс инструмента сделки: по полю instrumentType, а без него — по тикеру. */
export function instrumentClassOf(trade) {
  const raw = String(trade?.instrumentType || trade?.instrumentKind || '').toLowerCase();
  if (raw === 'futures' || raw === 'future') return 'future';
  if (raw === 'stock' || raw === 'share') return 'stock';
  if (raw === 'currency') return 'currency';
  if (raw === 'bond') return 'bond';
  if (raw === 'option') return 'option';
  if (raw === 'etf' || raw === 'fund') return 'fund';
  const t = String(trade?.ticker || '').toUpperCase();
  if (CURRENCY_RE.test(t)) return 'currency';
  if (FUT_RE.test(t) || /^(IMOEX|USDRUB|EURRUB|CNYRUB|GLDRUB)F$/.test(t)) return 'future';
  return 'stock';
}

// Характер стратегии. focus — чем меряем результат: у трендовой нормально проигрывать в 6 сделках из 10, если
// прибыльные крупные (меряем средним R); у отскока наоборот — много мелких побед, опасен редкий крупный убыток.
// Совпадающие id — те же, что у автоопределения типа старого конструктора (analytics/strategyKind.js).
export const CHARACTERS = {
  trend: {
    label: 'Ловит большие движения (тренд)', focus: 'avgR',
    hint: 'Прибыльных сделок может быть меньше половины — смотрим, перекрывают ли крупные выигрыши частые мелкие стопы.',
  },
  pullback: {
    label: 'Отскок от уровня, против движения', focus: 'winRate',
    hint: 'Обычно много мелких побед. Главное — не съедает ли редкий крупный убыток всю прибыль.',
  },
  breakout: {
    label: 'Пробой', focus: 'avgR',
    hint: 'Входов немного, ключевое — доля ложных пробоев и размер движения после верного.',
  },
  news: {
    label: 'На новостях', focus: 'paper',
    hint: 'Истории новостей у нас пока нет — такую стратегию проверяем бумажной торговлей с момента создания.',
  },
  ta_news: {
    label: 'Тех. анализ + новости', focus: 'avgR',
    hint: 'Техническую часть проверяем на истории, новостную — только бумагой.',
  },
  other: { label: 'Другое / не знаю', focus: 'avgR', hint: 'Меряем средним результатом сделки в R.' },
};

export const HORIZONS = {
  intraday: 'Внутри дня',
  swing: 'Несколько дней',
  position: 'Недели и дольше',
};

// --- признаки ---
// Все признаки НОРМИРОВАНЫ (проценты, ATR, 0–100, разы) — сырых цен нет, поэтому любое сравнение признака с признаком
// и любой допуск «±%» осмысленны на любом инструменте. scale — масштаб для допуска, когда порог равен нулю
// («MACD выше 0» ± 5% от нуля = ничего, поэтому берём 5% от типичного масштаба признака). null — допуск неприменим.
// kind: 'value' — обычное число; 'distance' — расстояние цены до чего-то (единица % или ATR, знак: + цена выше);
// 'time' — час/день недели; historical:false — истории нет, только бумага.
export const FEATURES = {
  rsi: { label: 'RSI', group: 'Осцилляторы', kind: 'value', params: { period: 14 }, scale: 100, range: [0, 100] },
  stoch_k: { label: 'Стохастик %K', group: 'Осцилляторы', kind: 'value', params: { period: 14, smooth: 3 }, scale: 100, range: [0, 100] },
  stoch_d: { label: 'Стохастик %D', group: 'Осцилляторы', kind: 'value', params: { period: 14, smooth: 3, signal: 3 }, scale: 100, range: [0, 100] },
  macd_hist: { label: 'MACD-гистограмма, % цены', group: 'Осцилляторы', kind: 'value', params: { fast: 12, slow: 26, signal: 9 }, scale: 0.5 },
  bb_pos: { label: 'Положение в полосах Боллинджера (0 — нижняя, 1 — верхняя)', group: 'Волатильность', kind: 'value', params: { period: 20, k: 2 }, scale: 1 },
  adx: { label: 'Сила тренда (ADX)', group: 'Тренд', kind: 'value', params: { period: 14 }, scale: 100, range: [0, 100] },
  supertrend_dir: { label: 'Supertrend: +1 вверх, −1 вниз', group: 'Тренд', kind: 'value', params: { period: 10, mult: 3 }, scale: null },
  atr_pct: { label: 'ATR, % цены (волатильность)', group: 'Волатильность', kind: 'value', params: { period: 14 }, scale: 1 },
  volume_ratio: { label: 'Объём к среднему, раз', group: 'Объём', kind: 'value', params: { period: 20 }, scale: 1 },
  change_pct: { label: 'Изменение цены за N свечей, %', group: 'Цена', kind: 'value', params: { bars: 3 }, scale: 1 },
  gap_pct: { label: 'Гэп открытия дня, %', group: 'Цена', kind: 'value', params: {}, scale: 1 },

  dist_ma: { label: 'Расстояние до средней', group: 'Средние и уровни', kind: 'distance', params: { type: 'ema', period: 50 }, scale: 1 },
  dist_support: { label: 'Расстояние до ближайшей поддержки', group: 'Средние и уровни', kind: 'distance', params: {}, scale: 1 },
  dist_resistance: { label: 'Расстояние до ближайшего сопротивления', group: 'Средние и уровни', kind: 'distance', params: {}, scale: 1 },
  dist_high_n: { label: 'Цена против максимума прошлых N свечей (>0 — пробой вверх)', group: 'Пробой', kind: 'distance', params: { bars: 20 }, scale: 1 },
  dist_low_n: { label: 'Цена против минимума прошлых N свечей (<0 — пробой вниз)', group: 'Пробой', kind: 'distance', params: { bars: 20 }, scale: 1 },
  dist_vwap: { label: 'Расстояние до VWAP дня', group: 'Средние и уровни', kind: 'distance', params: {}, scale: 1, intradayOnly: true },
  dist_pivot: { label: 'Расстояние до пивота прошлого дня', group: 'Средние и уровни', kind: 'distance', params: { level: 'P' }, scale: 1 },
  dist_supertrend: { label: 'Расстояние до линии Supertrend', group: 'Тренд', kind: 'distance', params: { period: 10, mult: 3 }, scale: 1 },

  hour: { label: 'Час (МСК)', group: 'Время', kind: 'time', params: {}, scale: null, range: [0, 23] },
  weekday: { label: 'День недели (1 — пн … 7 — вс)', group: 'Время', kind: 'time', params: {}, scale: null, range: [1, 7] },

  orderbook: { label: 'Стакан (перевес заявок)', group: 'Без истории', kind: 'value', params: {}, scale: 1, historical: false },
  news: { label: 'Новость по инструменту / геополитика', group: 'Без истории', kind: 'value', params: {}, scale: null, historical: false },
};

export const PIVOT_LEVELS = ['S3', 'S2', 'S1', 'P', 'R1', 'R2', 'R3'];

export const OPERATORS = {
  '>': 'выше',
  '<': 'ниже',
  between: 'между',
  crossAbove: 'пересекает снизу вверх',
  crossBelow: 'пересекает сверху вниз',
  rising: 'растёт',
  falling: 'падает',
};

export const DISTANCE_UNITS = { pct: '%', atr: 'ATR' };

export function emptySpec() {
  return {
    version: SPEC_VERSION,
    name: 'Мой сетап',
    direction: 'long',
    timeframe: 'H1',
    instrumentClass: 'stock',
    futureGroups: [],
    tickers: [],
    character: 'other',
    horizon: 'swing',
    tolerancePct: 5,
    entry: { mode: 'all', minScore: null, conditions: [] },
    exit: { stop: { type: 'atr', value: 1.5 }, target: { type: 'r', value: 2 }, trailing: null, maxBars: null, opposite: false },
    notes: '',
  };
}

let seq = 0;
export function newCondition(featureId, patch = {}) {
  const f = FEATURES[featureId];
  seq += 1;
  return {
    id: `c${Date.now().toString(36)}${seq}`,
    feature: { id: featureId, params: { ...(f?.params || {}) }, unit: f?.kind === 'distance' ? 'pct' : undefined },
    op: '<',
    value: 0,
    weight: 1,
    required: false,
    side: 'both',
    ago: 0,
    ...patch,
  };
}

const num = (v) => typeof v === 'number' && Number.isFinite(v);

/**
 * Проверка стратегии. Возвращает список проблем человеческим языком; пустой список — всё в порядке.
 * level: 'error' — считать нельзя; 'warn' — можно, но человек должен знать.
 */
export function validateSpec(spec) {
  const out = [];
  const err = (text, condId) => out.push({ level: 'error', text, condId });
  const warn = (text, condId) => out.push({ level: 'warn', text, condId });
  if (!spec || typeof spec !== 'object') return [{ level: 'error', text: 'Стратегия пустая' }];
  if (!TIMEFRAME_MINUTES[spec.timeframe]) err(`Неизвестный таймфрейм «${spec.timeframe}»`);
  if (!INSTRUMENT_CLASSES[spec.instrumentClass]) err(`Неизвестный класс инструментов «${spec.instrumentClass}»`);
  else if (!INSTRUMENT_CLASSES[spec.instrumentClass].testable) warn(`${INSTRUMENT_CLASSES[spec.instrumentClass].label} на истории по графику не проверяем — только бумажная торговля`);
  if (!['long', 'short', 'both'].includes(spec.direction)) err('Направление должно быть «лонг», «шорт» или «оба»');
  if (spec.character && !CHARACTERS[spec.character]) err(`Неизвестный характер «${spec.character}»`);
  if (!num(spec.tolerancePct) || spec.tolerancePct < 0 || spec.tolerancePct > 50) err('Допуск должен быть от 0 до 50%');
  const conds = spec.entry?.conditions || [];
  if (!conds.length) err('Нет ни одного условия входа');
  const ids = new Set();
  for (const c of conds) {
    const f = FEATURES[c?.feature?.id];
    if (!f) { err(`Неизвестный признак «${c?.feature?.id}»`, c?.id); continue; }
    if (ids.has(c.id)) err('У двух условий одинаковый номер', c.id);
    ids.add(c.id);
    if (!OPERATORS[c.op]) err(`Неизвестное сравнение «${c.op}»`, c.id);
    if (f.kind === 'distance' && !DISTANCE_UNITS[c.feature.unit]) err(`${f.label}: выберите единицу — % или ATR`, c.id);
    if (c.feature.tf && !TIMEFRAME_MINUTES[c.feature.tf]) err(`Неизвестный таймфрейм условия «${c.feature.tf}»`, c.id);
    if (c.feature.tf && TIMEFRAME_MINUTES[c.feature.tf] < TIMEFRAME_MINUTES[spec.timeframe]) {
      err('Таймфрейм условия меньше таймфрейма стратегии — так нельзя, берите старший', c.id);
    }
    if (f.intradayOnly && (c.feature.tf || spec.timeframe) === 'D1') err(`${f.label} считается только внутри дня`, c.id);
    if (c.op === 'between') {
      if (!Array.isArray(c.value) || c.value.length !== 2 || !num(c.value[0]) || !num(c.value[1])) err('«Между» требует два числа', c.id);
      else if (c.value[0] > c.value[1]) err('«Между»: первое число должно быть меньше второго', c.id);
    } else if (c.op === 'rising' || c.op === 'falling') {
      if (!Number.isInteger(c.n) || c.n < 1 || c.n > 50) err('«Растёт/падает»: укажите число свечей от 1 до 50', c.id);
    } else if (c.right) {
      if (!FEATURES[c.right.id]) err(`Неизвестный признак справа «${c.right.id}»`, c.id);
    } else if (!num(c.value)) err(`${f.label}: укажите число`, c.id);
    if (f.range && num(c.value) && !c.right && (c.value < f.range[0] || c.value > f.range[1])) {
      warn(`${f.label}: значение ${c.value} вне диапазона ${f.range[0]}–${f.range[1]} — условие не выполнится никогда или всегда`, c.id);
    }
    if (c.ago != null && (!Number.isInteger(c.ago) || c.ago < 0 || c.ago > 50)) err('«N свечей назад»: от 0 до 50', c.id);
    if (c.weight != null && (!num(c.weight) || c.weight <= 0)) err('Вес условия должен быть больше нуля', c.id);
    if (!['long', 'short', 'both'].includes(c.side || 'both')) err('Сторона условия: лонг, шорт или оба', c.id);
    if (f.historical === false) warn(`${f.label}: истории нет — стратегия будет только для бумажной торговли`, c.id);
  }
  if (spec.entry?.mode === 'score') {
    const total = conds.reduce((s, c) => s + (c.weight ?? 1), 0);
    if (!num(spec.entry.minScore) || spec.entry.minScore <= 0) err('Режим «баллы»: укажите, со скольких баллов входить');
    else if (spec.entry.minScore > total) err(`Порог ${spec.entry.minScore} больше суммы всех баллов (${total}) — вход невозможен`);
  } else if (spec.entry?.mode !== 'all') err('Режим входа: «все условия» или «баллы»');
  const ex = spec.exit || {};
  if (!ex.stop || ex.stop.type === 'none') warn('Без стопа результат в R не посчитать — будем мерить в процентах');
  else if (!['atr', 'pct'].includes(ex.stop.type) || !num(ex.stop.value) || ex.stop.value <= 0) err('Стоп: ATR или %, число больше нуля');
  if (ex.target && ex.target.type !== 'none' && (!['r', 'atr', 'pct'].includes(ex.target.type) || !num(ex.target.value) || ex.target.value <= 0)) err('Цель: R, ATR или %, число больше нуля');
  if (ex.trailing && (!['atr', 'pct'].includes(ex.trailing.type) || !num(ex.trailing.value) || ex.trailing.value <= 0)) err('Трейлинг: ATR или %, число больше нуля');
  if (ex.maxBars != null && (!Number.isInteger(ex.maxBars) || ex.maxBars < 1)) err('Выход по времени: целое число свечей');
  if (!ex.target?.value && !ex.trailing && !ex.maxBars && !ex.opposite && (!ex.stop || ex.stop.type === 'none')) {
    err('Нет ни одного правила выхода — сделка никогда не закроется');
  }
  return out;
}

/** Почему стратегию можно вести только на бумаге (истории признака нет, класс не проверяется). */
export function paperOnlyReasons(spec) {
  const out = [];
  const cls = INSTRUMENT_CLASSES[spec?.instrumentClass];
  if (cls && !cls.testable) out.push(`${cls.label} не проверяются на истории графика`);
  if (spec?.character === 'news') out.push('стратегия на новостях — истории новостей у нас пока нет');
  for (const c of spec?.entry?.conditions || []) {
    const f = FEATURES[c?.feature?.id];
    if (f?.historical === false) out.push(`${f.label}: истории нет`);
  }
  return [...new Set(out)];
}

// Заготовки, с которых удобно начать. Это не «проверенные стратегии», а распространённые описания стилей — числа
// человек сразу подкручивает под себя (и проверка покажет, что из этого вышло в его журнале).
export const SETUP_PRESETS = [
  {
    id: 'bounce',
    label: 'Отскок от поддержки',
    patch: { character: 'pullback', direction: 'long', entry: { mode: 'score', minScore: 3, conditions: [
      { feature: { id: 'rsi', params: { period: 14 } }, op: '<', value: 35, weight: 1 },
      { feature: { id: 'dist_support', params: {}, unit: 'pct' }, op: 'between', value: [0, 1], weight: 2, required: true },
      { feature: { id: 'stoch_k', params: { period: 14, smooth: 3 } }, op: '<', value: 25, weight: 1 },
    ] } },
  },
  {
    id: 'breakout',
    label: 'Пробой максимума с объёмом',
    patch: { character: 'breakout', direction: 'long', entry: { mode: 'all', conditions: [
      { feature: { id: 'dist_high_n', params: { bars: 20 }, unit: 'pct' }, op: '>', value: 0 },
      { feature: { id: 'volume_ratio', params: { period: 20 } }, op: '>', value: 1.5 },
    ] } },
  },
  {
    id: 'trend',
    label: 'По тренду: откат к средней',
    patch: { character: 'trend', direction: 'long', entry: { mode: 'all', conditions: [
      { feature: { id: 'dist_ma', params: { type: 'ema', period: 200 }, unit: 'pct' }, op: '>', value: 0 },
      { feature: { id: 'dist_ma', params: { type: 'ema', period: 50 }, unit: 'atr' }, op: 'between', value: [-0.5, 0.5] },
      { feature: { id: 'adx', params: { period: 14 } }, op: '>', value: 25 },
    ] } },
  },
];

/** Стратегия из заготовки: условия получают номера и недостающие поля. */
export function specFromPreset(presetId, base = emptySpec()) {
  const p = SETUP_PRESETS.find((x) => x.id === presetId);
  if (!p) return base;
  const conditions = p.patch.entry.conditions.map((c) => newCondition(c.feature.id, {
    ...c,
    feature: { ...c.feature, params: { ...(FEATURES[c.feature.id]?.params || {}), ...(c.feature.params || {}) } },
  }));
  return { ...base, ...p.patch, name: p.label, entry: { ...p.patch.entry, conditions } };
}

const fmt = (v) => (num(v) ? String(Math.round(v * 1000) / 1000).replace('.', ',') : '?');

/** Короткое имя признака с параметрами: «RSI(14)», «EMA 50», «Стохастик %K(14,3)», «пивот R1». */
export function featureName(ref) {
  const f = FEATURES[ref?.id];
  if (!f) return String(ref?.id || '?');
  const p = { ...f.params, ...(ref.params || {}) };
  let name;
  switch (ref.id) {
    case 'rsi': name = `RSI(${p.period})`; break;
    case 'stoch_k': name = `Стохастик %K(${p.period},${p.smooth})`; break;
    case 'stoch_d': name = `Стохастик %D(${p.period},${p.smooth},${p.signal})`; break;
    case 'macd_hist': name = `MACD-гистограмма(${p.fast},${p.slow},${p.signal})`; break;
    case 'bb_pos': name = `положение в полосах Боллинджера(${p.period})`; break;
    case 'adx': name = `ADX(${p.period})`; break;
    case 'atr_pct': name = `ATR(${p.period}) в % цены`; break;
    case 'volume_ratio': name = `объём к среднему за ${p.period}`; break;
    case 'change_pct': name = `изменение цены за ${p.bars} свеч.`; break;
    case 'dist_ma': name = `расстояние до ${String(p.type).toUpperCase()} ${p.period}`; break;
    case 'dist_high_n': name = `цена против максимума ${p.bars} свечей`; break;
    case 'dist_low_n': name = `цена против минимума ${p.bars} свечей`; break;
    case 'dist_pivot': name = `расстояние до пивота ${p.level}`; break;
    case 'supertrend_dir': name = `направление Supertrend(${p.period},${p.mult})`; break;
    case 'dist_supertrend': name = `расстояние до Supertrend(${p.period},${p.mult})`; break;
    default: name = f.label.charAt(0).toLowerCase() + f.label.slice(1);
  }
  if (ref.tf) name += ` на ${TIMEFRAME_LABELS[ref.tf] || ref.tf}`;
  return name;
}

const unitOf = (ref) => (FEATURES[ref?.id]?.kind === 'distance' ? (ref.unit === 'atr' ? ' ATR' : '%') : '');

/** Условие человеческим языком: «RSI(14) ниже 30», «расстояние до EMA 50 между −1% и 1%». */
export function describeCondition(c) {
  if (!c) return '';
  const left = featureName(c.feature);
  const u = unitOf(c.feature);
  let text;
  if (c.op === 'between' && Array.isArray(c.value)) text = `${left} между ${fmt(c.value[0])}${u} и ${fmt(c.value[1])}${u}`;
  else if (c.op === 'rising' || c.op === 'falling') text = `${left} ${OPERATORS[c.op]} ${c.n} свеч. подряд`;
  else if (c.right) text = `${left} ${OPERATORS[c.op]} ${featureName(c.right)}`;
  else text = `${left} ${OPERATORS[c.op] || c.op} ${fmt(c.value)}${u}`;
  if (c.ago) text += ` (${c.ago} свеч. назад)`;
  if (c.side && c.side !== 'both') text += c.side === 'long' ? ' — для лонга' : ' — для шорта';
  return text;
}
