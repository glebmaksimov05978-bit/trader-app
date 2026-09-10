// src/services/analytics/monthlyReport.js
//
// Месячный отчёт: что произошло за календарный месяц и чем он отличается от предыдущего.
//
// Почему отдельно от дашборда: дашборд отвечает на вопрос «как дела сейчас» — у него
// скользящее окно в 30 дней и он всегда про последнее время. Отчёт отвечает на другой
// вопрос — «чем закончился август» — и должен быть неизменным: открыл через полгода и
// увидел ровно то же самое. Отсюда календарные границы вместо скользящих.
//
// Сделка относится к месяцу, в котором она ЗАКРЫТА: до закрытия результата нет, а
// «прибыль августа» — это то, что зафиксировано в августе, даже если позиция открыта
// в июле. Так же считает налоговая и так же считает сам трейдер.
import { calcStats, resolveClosedAt } from '../trades';
import { computeHabitsFor } from './insightsEngine';

const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
// Отдельный падеж — «против июль 2026» читается как машинный перевод. Отчёт трейдер
// читает глазами, а не парсит, поэтому язык здесь такая же часть работы, как цифры.
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
  'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне',
  'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];

function plural(n, [one, few, many]) {
  const a = Math.abs(n) % 100;
  const b = a % 10;
  if (a > 10 && a < 20) return many;
  if (b === 1) return one;
  if (b >= 2 && b <= 4) return few;
  return many;
}

function hasRealizedPnl(t) {
  return (t.status === 'closed' || t.status === 'partial') && t.pnl !== undefined && t.pnl !== null;
}

export function monthKeyOf(date) {
  const d = date instanceof Date ? date : new Date(date);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function monthLabel(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** «августа 2026» — для оборотов вида «против августа 2026». */
export function monthLabelGenitive(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_GEN[m - 1]} ${y}`;
}

/** «в августе 2026». */
export function monthLabelIn(key) {
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_PREP[m - 1]} ${y}`;
}

function prevMonthKey(key) {
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

/** Месяцы, в которых вообще что-то закрывалось, от свежего к старому. */
export function listReportMonths(trades) {
  const keys = new Set();
  for (const t of trades) {
    if (!hasRealizedPnl(t)) continue;
    const closed = resolveClosedAt(t);
    if (closed) keys.add(monthKeyOf(closed));
  }
  return [...keys].sort().reverse().map((key) => ({ key, label: monthLabel(key) }));
}

function tradesOfMonth(trades, key) {
  return trades.filter((t) => {
    if (!hasRealizedPnl(t)) return false;
    const closed = resolveClosedAt(t);
    return closed && monthKeyOf(closed) === key;
  });
}

// Накопленный результат по дням месяца — форма месяца важнее итога: «+80 тысяч» может
// быть ровным подъёмом, а может быть провалом на 200 и отыгрышем в последнюю неделю,
// и это два совершенно разных месяца при одинаковой цифре.
function buildDailyCurve(monthTrades, key) {
  const [y, m] = key.split('-').map(Number);
  const days = new Date(y, m, 0).getDate();
  const perDay = new Array(days).fill(0);
  const countPerDay = new Array(days).fill(0);
  for (const t of monthTrades) {
    const closed = resolveClosedAt(t);
    if (!closed) continue;
    const d = closed.getDate() - 1;
    perDay[d] += t.pnl || 0;
    countPerDay[d] += 1;
  }
  let cum = 0;
  return perDay.map((pnl, i) => {
    cum += pnl;
    return { day: i + 1, pnl, cumulative: cum, trades: countPerDay[i] };
  });
}

function byInstrument(monthTrades) {
  const map = new Map();
  for (const t of monthTrades) {
    const key = (t.ticker || '—').toUpperCase();
    const cur = map.get(key) || { ticker: key, count: 0, pnl: 0, wins: 0 };
    cur.count += 1;
    cur.pnl += t.pnl || 0;
    if (t.pnl > 0) cur.wins += 1;
    map.set(key, cur);
  }
  return [...map.values()]
    .map((x) => ({ ...x, winrate: x.count ? (x.wins / x.count) * 100 : 0 }))
    .sort((a, b) => b.pnl - a.pnl);
}

// Дисциплина: что приложение предложило и что трейдер с этим сделал. Считается по
// решениям, которые он сам отмечал кнопками в уведомлениях (поле decisions), и по
// разбору закрытых сделок (vsSystemPct — насколько система на его месте вышла бы лучше).
function buildDiscipline(monthTrades) {
  let signals = 0;
  let acted = 0;
  let skipped = 0;
  const reasons = {};
  for (const t of monthTrades) {
    for (const d of (t.decisions || [])) {
      signals += 1;
      if (d.action === 'skipped') {
        skipped += 1;
        if (d.reason) reasons[d.reason] = (reasons[d.reason] || 0) + 1;
      } else if (d.action === 'fixed_partial' || d.action === 'closed_full') {
        acted += 1;
      }
    }
  }
  const withPostmortem = monthTrades.filter((t) => t.vsSystemPct != null);
  const behind = withPostmortem.filter((t) => t.vsSystemPct < 0);
  const vsSystemAvg = withPostmortem.length
    ? withPostmortem.reduce((s, t) => s + t.vsSystemPct, 0) / withPostmortem.length
    : null;

  return {
    signals,
    acted,
    skipped,
    followRate: signals ? (acted / signals) * 100 : null,
    topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([reason, count]) => ({ reason, count })),
    withPostmortem: withPostmortem.length,
    behindCount: behind.length,
    vsSystemAvg,
  };
}

/**
 * @param {object}   a
 * @param {object[]} a.trades   - все сделки пользователя
 * @param {string}   a.monthKey - 'YYYY-MM'
 * @param {object}  [a.profile] - профиль (нужен детекторам: дневной лимит, правила стратегии)
 */
export function buildMonthlyReport({ trades, monthKey, profile = {} }) {
  const monthTrades = tradesOfMonth(trades, monthKey);
  const prevKey = prevMonthKey(monthKey);
  const prevTrades = tradesOfMonth(trades, prevKey);

  const stats = calcStats(monthTrades);
  const prevStats = calcStats(prevTrades);
  const sorted = [...monthTrades].sort((a, b) => (b.pnl || 0) - (a.pnl || 0));

  const habits = computeHabitsFor(monthTrades, profile);
  const prevHabits = computeHabitsFor(prevTrades, profile);
  // Привычка «ушла» только если раньше она проявлялась, а теперь нет — прогресс, который
  // иначе никто не заметит: на дашборде видно только то, что болит сейчас.
  const fixed = prevHabits.triggered
    .filter((p) => !habits.triggered.some((h) => h.id === p.id))
    .map((p) => p.title);

  return {
    monthKey,
    label: monthLabel(monthKey),
    prevKey,
    prevLabel: monthLabel(prevKey),
    prevLabelGenitive: monthLabelGenitive(prevKey),
    prevLabelIn: monthLabelIn(prevKey),
    labelIn: monthLabelIn(monthKey),
    empty: monthTrades.length === 0,
    trades: monthTrades,
    stats,
    prevStats,
    deltaPnl: stats && prevStats ? stats.totalPnl - prevStats.totalPnl : null,
    daily: buildDailyCurve(monthTrades, monthKey),
    instruments: byInstrument(monthTrades),
    best: sorted[0] || null,
    worst: sorted.length > 1 ? sorted[sorted.length - 1] : null,
    discipline: buildDiscipline(monthTrades),
    habits: habits.triggered,
    allHabits: habits.all,
    fixedHabits: fixed,
  };
}

// Ниже этой суммы вывод «вот что стоило вам денег» — шум: движок честно посчитал, но
// называть направлением на месяц привычку ценой в сотню рублей значит обесценить сам
// раздел. Не влияет на список привычек в отчёте, только на итог словами.
const VERDICT_COST_FLOOR = 1000;

/**
 * Итог месяца человеческим языком. Осторожно с формулировками: месяц — это 10–30
 * сделок, на такой выборке «вы стали лучше торговать» не доказать. Поэтому здесь
 * описываются факты месяца и одно направление на следующий, без обещаний.
 */
export function reportVerdict(report) {
  if (report.empty) return 'В этом месяце не было закрытых сделок — считать нечего.';
  const lines = [];
  const s = report.stats;
  const sign = s.totalPnl >= 0 ? '+' : '−';
  lines.push(`${report.label}: ${s.total} ${plural(s.total, ['закрытая сделка', 'закрытые сделки', 'закрытых сделок'])}, `
    + `результат ${sign}${Math.abs(Math.round(s.totalPnl)).toLocaleString('ru-RU')} ₽, `
    + `${Math.round(s.winrate)}% прибыльных.`);

  if (report.prevStats && report.deltaPnl != null) {
    const better = report.deltaPnl >= 0;
    lines.push(`Против ${report.prevLabelGenitive} — ${better ? 'лучше' : 'хуже'} на `
      + `${Math.abs(Math.round(report.deltaPnl)).toLocaleString('ru-RU')} ₽.`);
  }

  const d = report.discipline;
  if (d.signals > 0) {
    lines.push(`${d.signals} ${plural(d.signals, ['сигнал', 'сигнала', 'сигналов'])}: `
      + `отработано ${d.acted}, пропущено ${d.skipped}`
      + (d.topReasons[0] ? ` (чаще всего — «${d.topReasons[0].reason}»)` : '') + '.');
  }

  if (report.fixedHabits.length) {
    lines.push(`Ушло по сравнению с прошлым месяцем: ${report.fixedHabits.join(', ').toLowerCase()}.`);
  }

  const top = report.habits.find((h) => h.costRub >= VERDICT_COST_FLOOR);
  if (top) {
    lines.push(`Дороже всего обошлось: ${top.title.toLowerCase()} — около `
      + `${Math.round(top.costRub).toLocaleString('ru-RU')} ₽`
      + (top.confidence === 'confirmed'
        ? '. Это и есть направление на следующий месяц.'
        : `. Пока это гипотеза: разобрано ${top.sampleSize} ${plural(top.sampleSize, ['сделка', 'сделки', 'сделок'])}, `
          + 'для уверенного вывода нужно больше.'));
  } else if (report.habits.length) {
    lines.push('Дорогих привычек за месяц не набралось — движок что-то отметил, но на суммы, '
      + 'которыми в масштабе месяца можно пренебречь.');
  } else {
    lines.push('Дорогих привычек за месяц движок не нашёл — либо их правда нет, либо сделок пока мало для вывода.');
  }
  return lines.join(' ');
}
