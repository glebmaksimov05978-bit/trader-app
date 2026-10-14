// src/services/analytics/strategyMeta.js
//
// «Паспорт» стратегии для Сопровождения: на каком горизонте она работает (краткосрок, среднесрок,
// долгосрок), на каком рабочем таймфрейме, стоит ли она «на сопровождении» и не в режиме ли
// наблюдения. Условия входа и правила выхода живут в самой стратегии (Капитал → «Моя стратегия»),
// здесь — только то, что нужно, чтобы несколько стратегий работали рядом и их можно было
// сравнивать честно.
//
// Поля лежат прямо на объекте стратегии (профиль хранит массив strategies):
//   horizon   — 'short' | 'medium' | 'long' | null
//   timeframe — ключ таймфрейма ('M15', 'H1', 'D1' …) | null; null = как у записи радара
//   followed  — true: стратегия на сопровождении (видна в обзоре, робот ведёт по ней бумажные сделки)
//   observe   — true: режим наблюдения (бумажные сделки идут, уведомлений в Telegram нет)
//
// Чистые функции без импортов — модуль подключают и приложение, и роботы (через esmify).

export const HORIZONS = [
  { id: 'short', label: 'Краткосрок', hint: 'сделки на часы — несколько дней', timeframes: ['M15', 'H1'] },
  { id: 'medium', label: 'Среднесрок', hint: 'сделки на дни — недели', timeframes: ['H1', 'D1'] },
  { id: 'long', label: 'Долгосрок', hint: 'сделки на недели — месяцы', timeframes: ['D1'] },
];

// Подписи совпадают с TIMEFRAMES из candles.js (там же минуты бара) — повторены здесь, чтобы модуль
// оставался без импортов.
export const TF_INFO = {
  M5: { label: 'М5', minutes: 5 },
  M10: { label: 'М10', minutes: 10 },
  M15: { label: 'М15', minutes: 15 },
  H1: { label: 'Ч1', minutes: 60 },
  D1: { label: 'Д1', minutes: 1440 },
};

export const tfLabel = (key) => TF_INFO[key]?.label || key || '—';

export const horizonById = (id) => HORIZONS.find((h) => h.id === id) || null;
export const horizonOf = (strategy) => horizonById(strategy?.horizon);
export const workTimeframeOf = (strategy) => (TF_INFO[strategy?.timeframe] ? strategy.timeframe : null);
export const isFollowed = (strategy) => strategy?.followed === true;
export const isObserved = (strategy) => strategy?.observe === true;

/** Рекомендуемые таймфреймы горизонта (пользователь может выбрать и другой — с предупреждением). */
export function suggestedTimeframes(horizonId) {
  return horizonById(horizonId)?.timeframes || [];
}

/**
 * Предупреждение к выбору, если он вызывает сомнения. Пусто — всё в порядке.
 * Не запрет: трейдеру виднее, но рядом с выбором он должен увидеть последствия.
 */
export function followWarnings({ horizon, timeframe }) {
  const out = [];
  if (horizon && timeframe && !suggestedTimeframes(horizon).includes(timeframe)) {
    out.push(`${tfLabel(timeframe)} для горизонта «${horizonById(horizon).label.toLowerCase()}» нетипичен — `
      + `обычно берут ${suggestedTimeframes(horizon).map(tfLabel).join(' или ')}.`);
  }
  const mins = TF_INFO[timeframe]?.minutes;
  if (mins && mins < 60) {
    out.push('Робот проверяет рынок раз в 15 минут: на таймфрейме меньше часа сигнал может прийти с опозданием, '
      + 'и цена входа окажется хуже. Для точной работы на таких таймфреймах нужна проверка каждую минуту.');
  }
  return out;
}

/** Результат проверки формы «добавить в Сопровождение». */
export function validateFollow({ horizon, timeframe }) {
  if (!horizonById(horizon)) return { ok: false, error: 'Выберите горизонт: краткосрок, среднесрок или долгосрок.' };
  if (!TF_INFO[timeframe]) return { ok: false, error: 'Выберите рабочий таймфрейм.' };
  return { ok: true, error: null };
}

/** Строка-подпись для плашки: «краткосрок · Ч1». */
export function captionOf(strategy) {
  const h = horizonOf(strategy);
  const tf = workTimeframeOf(strategy);
  const parts = [];
  if (h) parts.push(h.label.toLowerCase());
  if (tf) parts.push(tfLabel(tf));
  return parts.join(' · ');
}

/** Поставить стратегию на сопровождение. Возвращает НОВЫЙ объект, исходный не меняется. */
export function followStrategy(strategy, { horizon, timeframe, observe } = {}) {
  const v = validateFollow({ horizon, timeframe });
  if (!v.ok) throw new Error(v.error);
  return { ...strategy, horizon, timeframe, followed: true, observe: observe === true };
}

/** Снять со сопровождения. Горизонт и таймфрейм остаются — вернуть стратегию можно одним нажатием. */
export function unfollowStrategy(strategy) {
  return { ...strategy, followed: false, observe: false };
}

export function setObserve(strategy, on) {
  return { ...strategy, observe: on === true };
}

/**
 * Стратегии, которые показывает Сопровождение. Если трейдер ещё ни одну не отметил (аккаунты
 * до появления этой возможности) — показываем все, как раньше: иначе экран был бы пустым.
 */
export function followedStrategies(strategies) {
  const list = Array.isArray(strategies) ? strategies : [];
  const flagged = list.filter(isFollowed);
  return flagged.length ? flagged : list;
}

/** Отмечена ли хоть одна стратегия — нужно, чтобы понять, включён ли новый режим. */
export function hasFollowFlags(strategies) {
  return (Array.isArray(strategies) ? strategies : []).some(isFollowed);
}

/**
 * Какие стратегии торгуют бумажно. Раньше — только список paperStrategyIds из Настроек;
 * теперь к нему добавляются стратегии «на сопровождении». Порядок: сначала явный список.
 * Пусто — прежнее поведение робота (одна стратегия на тикер).
 */
export function paperStrategyIdsFor(profile) {
  const all = Array.isArray(profile?.strategies) ? profile.strategies : [];
  const known = new Set(all.map((s) => s.id));
  const explicit = Array.isArray(profile?.alertPrefs?.paperStrategyIds) ? profile.alertPrefs.paperStrategyIds : [];
  const out = [];
  for (const id of explicit) if (known.has(id) && !out.includes(id)) out.push(id);
  for (const s of all) if (isFollowed(s) && !out.includes(s.id)) out.push(s.id);
  return out;
}

/** Таймфрейм, на котором стратегия смотрит запись радара: свой рабочий важнее настроек тикера. */
export function timeframeFor(strategy, item, profile, fallback = 'D1') {
  return workTimeframeOf(strategy)
    || (TF_INFO[item?.timeframe] ? item.timeframe : null)
    || (TF_INFO[profile?.preferredTimeframe] ? profile.preferredTimeframe : null)
    || fallback;
}

/** Две стратегии одного класса: одинаковые горизонт и таймфрейм — только их и сравнивают «в лоб». */
export function sameClass(a, b) {
  const ha = a?.horizon, hb = b?.horizon;
  const ta = workTimeframeOf(a), tb = workTimeframeOf(b);
  return !!ha && ha === hb && !!ta && ta === tb;
}

/** Ключ класса стратегии для группировки; null — класс не задан (сравнивать не с кем). */
export function classKey(strategy) {
  const h = strategy?.horizon;
  const tf = workTimeframeOf(strategy);
  return h && tf ? `${h}|${tf}` : null;
}
