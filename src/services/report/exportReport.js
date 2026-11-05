// src/services/report/exportReport.js
//
// Модель выгружаемого отчёта (PDF / Word / отправка по расписанию): за ЛЮБОЙ период — неделя, месяц, квартал, год или свои даты —
// и с выбором разделов. Чистые функции без зависимостей от React, Firebase и браузера, поэтому одна и та же модель строится
// и на странице, и в фоновом скрипте на сервере; рисуют её отдельные модули (pdfDoc.js, docxDoc.js).
//
// Сделка относится к периоду, в котором ЗАКРЫТА (как во всём отчётном блоке). Границы периодов считаются в заданном часовом поясе
// (по умолчанию Москва, UTC+3): на сервере в UTC «месяц» иначе заканчивался бы на три часа раньше.
import { normalize, statsOf, groupBy, strategyNameOf, SCOPES } from '../analytics/periodReport.js';

export const MSK_OFFSET_MIN = 180;
const DAY = 86400000;
const MIN = 60000;

const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_NOM = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];
const WEEKDAYS = ['Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота', 'Воскресенье'];
const WEEKDAYS_SHORT = ['Пн', 'Вт', 'Ср', 'Чт', 'Пт', 'Сб', 'Вс'];
const ROMAN = ['I', 'II', 'III', 'IV'];

// ---------- форматирование (общее для всех рисовальщиков) ----------
const NBSP = ' ';
export const fmtInt = (v) => Math.round(Math.abs(v)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, NBSP);
/** «+12 400 ₽» / «−3 200 ₽»; ноль — «0 ₽». */
export const fmtMoney = (v, { sign = true } = {}) => {
  if (v == null || !Number.isFinite(v)) return '—';
  const r = Math.round(v);
  if (r === 0) return `0${NBSP}₽`;
  return `${sign ? (r > 0 ? '+' : '−') : (r < 0 ? '−' : '')}${fmtInt(r)}${NBSP}₽`;
};
export const fmtPct = (v, digits = 0) => (v == null || !Number.isFinite(v) ? '—' : `${v.toFixed(digits).replace('.', ',')}%`);
export const fmtPF = (v) => (v == null ? '—' : Number.isFinite(v) ? v.toFixed(2).replace('.', ',') : '∞');
export const plural = (n, [one, few, many]) => {
  const a = Math.abs(n) % 100, b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
};

// ---------- периоды ----------
export const PERIOD_PRESETS = [
  { id: 'last_week', label: 'Прошлая неделя' },
  { id: 'this_week', label: 'Эта неделя' },
  { id: 'last_month', label: 'Прошлый месяц' },
  { id: 'this_month', label: 'Этот месяц' },
  { id: 'last_quarter', label: 'Прошлый квартал' },
  { id: 'this_quarter', label: 'Этот квартал' },
  { id: 'last_year', label: 'Прошлый год' },
  { id: 'this_year', label: 'Этот год' },
  { id: 'last_30', label: 'Последние 30 дней' },
  { id: 'last_90', label: 'Последние 90 дней' },
  { id: 'custom', label: 'Свои даты' },
];

function parts(ms, off) {
  const d = new Date(ms + off * MIN);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth(), d: d.getUTCDate(), dow: (d.getUTCDay() + 6) % 7 };
}
const dayStart = (y, m, d, off) => Date.UTC(y, m, d) - off * MIN;
const dayEnd = (y, m, d, off) => dayStart(y, m, d + 1, off) - 1;
const daysInMonth = (y, m) => new Date(Date.UTC(y, m + 1, 0)).getUTCDate();

/** Строка YYYY-MM-DD (из поля ввода даты) → начало этого дня в поясе off; null, если не дата. */
export function parseDateInput(s, off = MSK_OFFSET_MIN) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s || ''));
  if (!m) return null;
  return dayStart(+m[1], +m[2] - 1, +m[3], off);
}
export function toDateInput(ms, off = MSK_OFFSET_MIN) {
  const p = parts(ms, off);
  return `${p.y}-${String(p.m + 1).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
}

function rangeText(fromMs, toMs, off) {
  const a = parts(fromMs, off), b = parts(toMs, off);
  if (a.y === b.y && a.m === b.m) return a.d === b.d ? `${a.d} ${MONTHS_GEN[a.m]} ${a.y}` : `${a.d}–${b.d} ${MONTHS_GEN[a.m]} ${a.y}`;
  if (a.y === b.y) return `${a.d} ${MONTHS_GEN[a.m]} – ${b.d} ${MONTHS_GEN[b.m]} ${a.y}`;
  return `${a.d} ${MONTHS_GEN[a.m]} ${a.y} – ${b.d} ${MONTHS_GEN[b.m]} ${b.y}`;
}

/** Человеческое название диапазона: «Ноябрь 2026», «III квартал 2026», «2026 год», «Неделя 27 октября – 2 ноября 2026»… */
function nameRange(fromMs, toMs, off) {
  const a = parts(fromMs, off), b = parts(toMs, off);
  const firstDay = a.d === 1, lastOfMonth = b.d === daysInMonth(b.y, b.m);
  if (a.y === b.y && a.m === b.m && firstDay && lastOfMonth) return `${MONTHS_NOM[a.m]} ${a.y}`;
  if (a.y === b.y && firstDay && a.m === 0 && b.m === 11 && lastOfMonth) return `${a.y} год`;
  if (a.y === b.y && firstDay && a.m % 3 === 0 && b.m === a.m + 2 && lastOfMonth) return `${ROMAN[a.m / 3]} квартал ${a.y}`;
  return rangeText(fromMs, toMs, off);
}

/**
 * Период отчёта. `now` — момент «сейчас»; границы возвращаются в миллисекундах, `to` — конец последнего дня включительно.
 * @returns {{id,label,from,to,days,kind,title,rangeText,prev:{from,to,title,rangeText}}}
 */
export function resolvePeriod({ preset = 'last_month', from = null, to = null, now = Date.now(), tzOffsetMin = MSK_OFFSET_MIN } = {}) {
  const off = tzOffsetMin;
  const t = parts(now, off);
  let f, e, kind = 'custom';
  switch (preset) {
    case 'this_week': { kind = 'week'; const s = dayStart(t.y, t.m, t.d - t.dow, off); f = s; e = dayEnd(t.y, t.m, t.d, off); break; }
    case 'last_week': { kind = 'week'; const s = dayStart(t.y, t.m, t.d - t.dow - 7, off); f = s; e = s + 7 * DAY - 1; break; }
    case 'this_month': kind = 'month'; f = dayStart(t.y, t.m, 1, off); e = dayEnd(t.y, t.m, t.d, off); break;
    case 'last_month': kind = 'month'; f = dayStart(t.y, t.m - 1, 1, off); e = dayStart(t.y, t.m, 1, off) - 1; break;
    case 'this_quarter': { kind = 'quarter'; const q = Math.floor(t.m / 3) * 3; f = dayStart(t.y, q, 1, off); e = dayEnd(t.y, t.m, t.d, off); break; }
    case 'last_quarter': { kind = 'quarter'; const q = Math.floor(t.m / 3) * 3; f = dayStart(t.y, q - 3, 1, off); e = dayStart(t.y, q, 1, off) - 1; break; }
    case 'this_year': kind = 'year'; f = dayStart(t.y, 0, 1, off); e = dayEnd(t.y, t.m, t.d, off); break;
    case 'last_year': kind = 'year'; f = dayStart(t.y - 1, 0, 1, off); e = dayStart(t.y, 0, 1, off) - 1; break;
    case 'last_30': kind = 'rolling'; f = dayStart(t.y, t.m, t.d - 29, off); e = dayEnd(t.y, t.m, t.d, off); break;
    case 'last_90': kind = 'rolling'; f = dayStart(t.y, t.m, t.d - 89, off); e = dayEnd(t.y, t.m, t.d, off); break;
    case 'custom': {
      const a = typeof from === 'string' ? parseDateInput(from, off) : from;
      const b = typeof to === 'string' ? parseDateInput(to, off) : to;
      if (a == null || b == null) throw new Error('Укажите даты начала и конца периода');
      const pb = parts(b, off);
      f = a; e = dayEnd(pb.y, pb.m, pb.d, off);
      if (e < f) throw new Error('Дата конца раньше даты начала');
      break;
    }
    default: throw new Error(`Неизвестный период: ${preset}`);
  }
  const days = Math.round((e - f + 1) / DAY);

  // Предыдущий период для сравнения: тот же календарный отрезок на шаг назад; для «скользящих» и своих дат — столько же дней до начала.
  let pf, pe;
  const fp = parts(f, off), ep = parts(e, off);
  if (kind === 'week') { pf = f - 7 * DAY; pe = e - 7 * DAY; }
  else if (kind === 'month' || kind === 'quarter' || kind === 'year') {
    const back = kind === 'month' ? 1 : kind === 'quarter' ? 3 : 12;
    const shift = (y, m) => { const d = new Date(Date.UTC(y, m - back, 1)); return { y: d.getUTCFullYear(), m: d.getUTCMonth() }; };
    const s = shift(fp.y, fp.m), en = shift(ep.y, ep.m);
    pf = dayStart(s.y, s.m, 1, off);
    // период кончался в последний день месяца — и предыдущий кончается в последний; иначе тот же день месяца (не дальше конца месяца)
    const lastDay = daysInMonth(en.y, en.m);
    pe = ep.d === daysInMonth(ep.y, ep.m) ? dayEnd(en.y, en.m, lastDay, off) : dayEnd(en.y, en.m, Math.min(ep.d, lastDay), off);
  } else { pf = f - days * DAY; pe = f - 1; }

  const titleOf = (a, b) => (kind === 'week' ? `Неделя ${rangeText(a, b, off)}` : nameRange(a, b, off));
  const preset_ = PERIOD_PRESETS.find((p) => p.id === preset);
  return {
    id: preset, presetLabel: preset_?.label || '', kind, from: f, to: e, days,
    title: titleOf(f, e), rangeText: rangeText(f, e, off),
    prev: { from: pf, to: pe, title: titleOf(pf, pe), rangeText: rangeText(pf, pe, off) },
    tzOffsetMin: off,
  };
}

// ---------- кривая результата ----------
function buildCurve(items, period) {
  const off = period.tzOffsetMin;
  const days = period.days;
  let gran, slots;
  if (days <= 62) gran = 'day'; else if (days <= 200) gran = 'week'; else gran = 'month';
  const keyOf = (ms) => {
    const p = parts(ms, off);
    if (gran === 'day') return dayStart(p.y, p.m, p.d, off);
    if (gran === 'week') return dayStart(p.y, p.m, p.d - p.dow, off);
    return dayStart(p.y, p.m, 1, off);
  };
  slots = [];
  let cur = keyOf(period.from);
  const last = keyOf(period.to);
  while (cur <= last) {
    slots.push(cur);
    const p = parts(cur, off);
    cur = gran === 'day' ? dayStart(p.y, p.m, p.d + 1, off) : gran === 'week' ? dayStart(p.y, p.m, p.d + 7, off) : dayStart(p.y, p.m + 1, 1, off);
  }
  const pnl = new Map(slots.map((s) => [s, 0])), cnt = new Map(slots.map((s) => [s, 0]));
  for (const x of items) {
    const k = keyOf(x.closed.getTime());
    if (!pnl.has(k)) continue;
    pnl.set(k, pnl.get(k) + x.pnl); cnt.set(k, cnt.get(k) + 1);
  }
  let cum = 0;
  const labelOf = (s) => {
    const p = parts(s, off);
    if (gran === 'month') return `${MONTHS_SHORT[p.m]} ${String(p.y).slice(2)}`;
    return `${String(p.d).padStart(2, '0')}.${String(p.m + 1).padStart(2, '0')}`;
  };
  const points = slots.map((s) => { cum += pnl.get(s); return { t: s, label: labelOf(s), pnl: pnl.get(s), cumulative: cum, trades: cnt.get(s) }; });
  return { granularity: gran, points };
}

// ---------- сборка модели ----------
export const SECTIONS = [
  { id: 'summary', label: 'Итоги периода', hint: 'Главные цифры и вывод словами', def: true },
  { id: 'curve', label: 'Динамика результата', hint: 'График накопленного результата', def: true },
  { id: 'best_worst', label: 'Лучшие и худшие сделки', hint: 'Пять лучших и пять худших', def: true },
  { id: 'instruments', label: 'По инструментам', hint: 'Где заработали и где потеряли', def: true },
  { id: 'strategies', label: 'По стратегиям', hint: 'Какая стратегия как отработала', def: true },
  { id: 'weekdays', label: 'По дням недели', hint: 'В какие дни торговля удачнее', def: false },
  { id: 'versus', label: 'Я против системы', hint: 'Ваши реальные сделки рядом с бумажными сделками робота', def: false },
  { id: 'habits', label: 'Привычки и что они стоили', hint: 'Что движок привычек нашёл в ваших реальных сделках', def: true },
  { id: 'trades', label: 'Список всех сделок', hint: 'Полная таблица закрытых сделок периода', def: false },
];
export const DEFAULT_SECTIONS = SECTIONS.filter((s) => s.def).map((s) => s.id);

const MIN_SAMPLE = 25;
const sideText = (d) => (d === 'short' ? 'Шорт' : 'Лонг');

function tradeRow(x, off) {
  const p = parts(x.closed.getTime(), off);
  return {
    date: `${String(p.d).padStart(2, '0')}.${String(p.m + 1).padStart(2, '0')}.${p.y}`, closedMs: x.closed.getTime(),
    ticker: x.ticker, side: sideText(x.direction), strategy: x.strategy, pnl: x.pnl, src: x.src,
  };
}

/**
 * @param {object} a
 * @param {object[]} a.realTrades
 * @param {object[]} [a.paperTrades]
 * @param {'real'|'paper'|'all'} [a.scope]
 * @param {string[]} [a.strategyNames] — пусто = все стратегии
 * @param {object} a.period — результат resolvePeriod
 * @param {string[]} [a.sections]
 * @param {object} [a.profile]
 * @param {Function} [a.legPnl]
 * @param {Function} [a.habitsFn] — (сделки, профиль) → { triggered:[{title,costRub,confidence,sampleSize,detail}] }; без неё раздел привычек пропускается
 * @param {string} [a.userName]
 * @param {number} [a.now]
 */
export function buildExportReport({
  realTrades = [], paperTrades = [], scope = 'real', strategyNames = [], period, sections = DEFAULT_SECTIONS,
  profile = {}, legPnl = null, habitsFn = null, userName = '', now = Date.now(),
}) {
  if (!period) throw new Error('Не задан период');
  const off = period.tzOffsetMin;
  const want = new Set(sections);
  const filterOn = strategyNames.length > 0;
  const keep = (x) => !filterOn || strategyNames.includes(x.strategy);
  const all = normalize(realTrades, paperTrades, scope, legPnl).filter(keep);
  const inRange = (r) => (x) => x.closed.getTime() >= r.from && x.closed.getTime() <= r.to;
  const items = all.filter(inRange(period)).sort((a, b) => a.closed - b.closed);
  const prevItems = all.filter(inRange(period.prev));
  const stats = statsOf(items);
  const prevStats = statsOf(prevItems);
  const done = items.filter((x) => !x.partial);
  const scopeLabel = SCOPES.find((s) => s.id === scope)?.label || scope;

  const model = {
    version: 1,
    meta: {
      title: 'Отчёт по торговле',
      period: { title: period.title, rangeText: period.rangeText, from: period.from, to: period.to, days: period.days, kind: period.kind },
      prevPeriod: { title: period.prev.title, rangeText: period.prev.rangeText },
      scope, scopeLabel,
      strategies: filterOn ? strategyNames : [],
      strategiesText: filterOn ? strategyNames.join(', ') : 'Все стратегии',
      generatedAt: now, userName: userName || '',
    },
    empty: items.length === 0,
    sections: SECTIONS.filter((s) => want.has(s.id)).map((s) => s.id),
    stats, prevStats,
    delta: { pnl: stats.pnl - prevStats.pnl, hasPrev: prevStats.total > 0 || prevStats.partialEvents > 0, winrate: prevStats.total ? stats.winrate - prevStats.winrate : null, total: stats.total - prevStats.total },
  };

  // кривая и разрезы строим всегда (дёшево): рисовальщик показывает только выбранные разделы
  model.curve = buildCurve(items, period);

  const sortedDone = [...done].sort((a, b) => b.pnl - a.pnl);
  model.best = sortedDone.filter((x) => x.pnl > 0).slice(0, 5).map((x) => tradeRow(x, off));
  model.worst = [...sortedDone].reverse().filter((x) => x.pnl < 0).slice(0, 5).map((x) => tradeRow(x, off));

  const label = (arr) => arr.map((g) => ({ label: g.label, count: g.count, wins: g.wins, winrate: g.winrate, pnl: g.pnl, avg: g.avg, profitFactor: g.profitFactor }));
  model.byInstrument = label(groupBy(items, (x) => x.ticker));
  model.byStrategy = label(groupBy(items, (x) => (scope === 'all' ? `${x.strategy} · ${x.src === 'paper' ? 'бумага' : 'реал'}` : x.strategy)));

  const wd = Array.from({ length: 7 }, (_, i) => ({ label: WEEKDAYS[i], short: WEEKDAYS_SHORT[i], count: 0, wins: 0, pnl: 0 }));
  for (const x of done) { const w = wd[parts(x.closed.getTime(), off).dow]; w.count += 1; w.pnl += x.pnl; if (x.pnl > 0) w.wins += 1; }
  model.byWeekday = wd.map((w) => ({ ...w, winrate: w.count ? (w.wins / w.count) * 100 : 0 }));

  // я против системы — независимо от среза, по тому же фильтру стратегий
  const sideOf = (sc) => statsOf(normalize(realTrades, paperTrades, sc, legPnl).filter(keep).filter(inRange(period)));
  model.versus = { real: sideOf('real'), paper: sideOf('paper') };

  model.trades = items.filter((x) => !x.partial).map((x) => tradeRow(x, off)).sort((a, b) => a.closedMs - b.closedMs);

  // привычки — только по реальным сделкам периода (и только если рисовальщик получил детектор)
  model.habits = null;
  if (want.has('habits') && habitsFn && scope !== 'paper') {
    const realInRange = items.filter((x) => x.src === 'real').map((x) => x.raw);
    if (realInRange.length) {
      try {
        const r = habitsFn(realInRange, profile);
        model.habits = {
          n: realInRange.length,
          list: (r.triggered || []).slice(0, 5).map((h) => ({ title: h.title, costRub: Math.round(h.costRub || 0), confidence: h.confidence, sampleSize: h.sampleSize, detail: h.detail || '' })),
        };
      } catch { model.habits = null; }
    }
  }

  model.verdict = buildVerdict(model);
  model.notes = [];
  if (!model.empty && stats.total < MIN_SAMPLE) model.notes.push(`За период закрыто ${stats.total} ${plural(stats.total, ['сделка', 'сделки', 'сделок'])}. На такой выборке выводы предварительные: нужно не меньше ${MIN_SAMPLE} сделок, чтобы отличить закономерность от случайности.`);
  if (stats.realizedOpen) model.notes.push(`В результат включено ${fmtMoney(stats.realizedOpen)}, зафиксированные по ещё открытым позициям (частичные закрытия).`);
  return model;
}

/** Итог словами: факты периода и одно направление, без обещаний. */
export function buildVerdict(m) {
  if (m.empty) return `За период ${m.meta.period.rangeText} закрытых сделок не было — считать нечего.`;
  const s = m.stats;
  const lines = [];
  lines.push(`${m.meta.period.title}: ${s.total} ${plural(s.total, ['закрытая сделка', 'закрытые сделки', 'закрытых сделок'])}, результат ${fmtMoney(s.pnl)}, ${Math.round(s.winrate)}% прибыльных.`);
  if (m.delta.hasPrev) {
    const better = m.delta.pnl >= 0;
    lines.push(`Против предыдущего периода (${m.meta.prevPeriod.title}) — ${better ? 'лучше' : 'хуже'} на ${fmtMoney(Math.abs(m.delta.pnl), { sign: false })}.`);
  }
  if (s.maxDrawdown > 0) lines.push(`Наибольшая просадка внутри периода — ${fmtMoney(s.maxDrawdown, { sign: false })}.`);
  const strat = m.byStrategy.filter((g) => g.count >= 3);
  if (strat.length >= 2) lines.push(`Сильнее всех отработала стратегия «${strat[0].label}» (${fmtMoney(strat[0].pnl)}), слабее всех — «${strat[strat.length - 1].label}» (${fmtMoney(strat[strat.length - 1].pnl)}).`);
  const top = m.habits?.list?.find((h) => h.costRub >= 1000);
  if (top) lines.push(`Дороже всего обошлось: ${top.title.toLowerCase()} — около ${fmtMoney(top.costRub, { sign: false })}${top.confidence === 'confirmed' ? '.' : ` (пока гипотеза: разобрано ${top.sampleSize} ${plural(top.sampleSize, ['сделка', 'сделки', 'сделок'])}).`}`);
  return lines.join(' ');
}

/** Имя файла без кириллицы и пробелов: надёжно открывается на любой системе и в Telegram. */
export function reportFileName(model, ext) {
  const day = (ms) => new Date(ms + MSK_OFFSET_MIN * MIN).toISOString().slice(0, 10);
  return `TraderPro_report_${day(model.meta.period.from)}_${day(model.meta.period.to)}.${ext}`;
}

export { strategyNameOf };
