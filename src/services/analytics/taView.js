// src/services/analytics/taView.js
//
// Что показывает плашка «Технический анализ» и какие слои включены на графике.
//
// Два режима, которые трейдер просил разделить:
//   • «без стратегии» — стандартные данные; набор блоков трейдер выбирает сам в Настройках
//     (убрал Фибоначчи — плашка стала короче);
//   • «по стратегии» — только то, чем стратегия реально пользуется, и рядом с каждым блоком её порог
//     («RSI: порог стратегии — ниже 35»). Параметры, которых в стратегии нет, исчезают.
//
// Чистые функции без зависимостей: ни React, ни Firestore.

export const TA_SECTIONS = [
  { id: 'rsi', label: 'RSI', group: 'Индикаторы', layers: ['rsi'] },
  { id: 'macd', label: 'MACD', group: 'Индикаторы', layers: ['macd'] },
  { id: 'volume', label: 'Объём', group: 'Индикаторы', layers: ['volume'] },
  { id: 'context', label: 'Рыночный контекст: тренд и волатильность', group: 'Контекст', layers: [] },
  { id: 'bollinger', label: 'Полосы Боллинджера', group: 'Уровни', layers: ['bollinger'] },
  { id: 'ema', label: 'EMA-уровни', group: 'Уровни', layers: ['ema9', 'ema100', 'ema200'] },
  { id: 'levels', label: 'Поддержка и сопротивление', group: 'Уровни', layers: ['sr'] },
  { id: 'fibonacci', label: 'Уровни Фибоначчи', group: 'Уровни', layers: ['fibonacci'] },
  { id: 'patterns', label: 'Фигуры-кандидаты', group: 'Фигуры', layers: [] },
];

export const TA_IDS = TA_SECTIONS.map((s) => s.id);

export const DEFAULT_TA_PREFS = Object.fromEntries(TA_IDS.map((id) => [id, true]));

/** Привести сохранённые настройки к полному набору: чего нет или не логическое — по умолчанию (показывать). */
export function normalizeTaPrefs(raw) {
  const out = { ...DEFAULT_TA_PREFS };
  if (raw && typeof raw === 'object') {
    for (const id of TA_IDS) if (typeof raw[id] === 'boolean') out[id] = raw[id];
  }
  return out;
}

// условие стратегии → блок плашки
const CONDITION_TO_SECTION = {
  rsi_below: 'rsi',
  rsi_above: 'rsi',
  macd_positive: 'macd',
  macd_negative: 'macd',
  volume_above_avg: 'volume',
  market_trending: 'context',
  market_sideways: 'context',
  volatility_not_high: 'context',
  momentum_favor: 'context',
  bollinger_lower: 'bollinger',
  bollinger_upper: 'bollinger',
  price_above_ema200: 'ema',
  price_below_ema200: 'ema',
  near_support: 'levels',
  near_resistance: 'levels',
  pattern_confirmed: 'patterns',
};

const num = (v) => (v == null || v === '' || Number.isNaN(Number(v)) ? null : Number(v));
const fmt = (v) => String(Math.round(v * 100) / 100).replace('.', ',');

function noteFor(c) {
  const p = num(c.param);
  switch (c.id) {
    case 'rsi_below': return p != null ? `ниже ${fmt(p)}` : 'перепроданность';
    case 'rsi_above': return p != null ? `выше ${fmt(p)}` : 'перекупленность';
    case 'macd_positive': return 'гистограмма выше нуля';
    case 'macd_negative': return 'гистограмма ниже нуля';
    case 'volume_above_avg': return p != null ? `не меньше ×${fmt(p)} от обычного` : 'выше обычного';
    case 'market_trending': return 'рынок в тренде';
    case 'market_sideways': return 'рынок в боковике';
    case 'volatility_not_high': return 'волатильность не повышена';
    case 'momentum_favor': return p != null ? `импульс за 3 бара больше ${fmt(p)}%` : 'импульс в сторону сделки';
    case 'bollinger_lower': return 'цена у нижней полосы';
    case 'bollinger_upper': return 'цена у верхней полосы';
    case 'price_above_ema200': return 'цена выше EMA200';
    case 'price_below_ema200': return 'цена ниже EMA200';
    case 'near_support': return p != null ? `у поддержки, в пределах ${fmt(p)}%` : 'у поддержки';
    case 'near_resistance': return p != null ? `у сопротивления, в пределах ${fmt(p)}%` : 'у сопротивления';
    case 'pattern_confirmed': return p != null ? `уверенность не ниже ${fmt(p)}%` : 'подтверждённая фигура';
    default: return '';
  }
}

/**
 * Чем пользуется стратегия: { used: {sectionId: bool}, notes: {sectionId: string}, any: bool }.
 * Учитываются только включённые условия, у которых есть рыночный блок (условия плана — нет).
 */
export function strategyUsage(strategy) {
  const used = Object.fromEntries(TA_IDS.map((id) => [id, false]));
  const notesArr = {};
  for (const c of (strategy?.conditions || [])) {
    if (!c || c.enabled === false) continue;
    const sec = CONDITION_TO_SECTION[c.id];
    if (!sec) continue;
    used[sec] = true;
    const n = noteFor(c);
    if (n) (notesArr[sec] = notesArr[sec] || []).push(n);
  }
  const notes = Object.fromEntries(Object.entries(notesArr).map(([k, v]) => [k, v.join(' · ')]));
  return { used, notes, any: Object.values(used).some(Boolean) };
}

/**
 * Что показывать.
 * @param {object} args
 * @param {object} [args.prefs] — настройки «без стратегии» (из профиля)
 * @param {object|null} [args.strategy] — стратегия-«призма»; null — без призмы
 * @returns {{ visible: Record<string, boolean>, notes: Record<string,string>, lens: boolean, empty: boolean }}
 */
export function resolveTaView({ prefs, strategy = null } = {}) {
  if (!strategy) {
    const visible = normalizeTaPrefs(prefs);
    return { visible, notes: {}, lens: false, empty: !Object.values(visible).some(Boolean) };
  }
  const u = strategyUsage(strategy);
  return { visible: u.used, notes: u.notes, lens: true, empty: !u.any };
}

/** Слои графика, которые соответствуют видимым блокам (для призмы стратегии). */
export function chartLayersFor(visible) {
  const on = new Set();
  for (const s of TA_SECTIONS) if (visible?.[s.id]) s.layers.forEach((l) => on.add(l));
  return [...on];
}

/** Сколько блоков включено — для подписи в Настройках. */
export function countVisible(visible) {
  return TA_IDS.filter((id) => visible?.[id]).length;
}
