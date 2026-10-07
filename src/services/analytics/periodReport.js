// src/services/analytics/periodReport.js
//
// Отчёт за период (месяц или год) по трём срезам: реальные сделки, бумажные (их ведёт робот)
// и «всё вместе». Главный вопрос отчёта — «насколько хорошо я торгую» относительно прошлого
// периода, относительно системы и по стратегиям.
//
// Чистые функции без зависимостей (ни Firebase, ни React) — проверяются тестом. Сделка относится
// к периоду, в котором ЗАКРЫТА: результат есть только у закрытой.
//
// Бумажные считаются только закрытые: у открытой бумажной в поле pnl лежит уже зафиксированная
// часть, и смешивать её с итогом закрытых значит выдавать недосчитанное за результат.
const MONTHS = ['Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь', 'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь'];
const MONTHS_GEN = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];
const MONTHS_PREP = ['январе', 'феврале', 'марте', 'апреле', 'мае', 'июне', 'июле', 'августе', 'сентябре', 'октябре', 'ноябре', 'декабре'];
const MONTHS_SHORT = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек'];

export const SCOPES = [
  { id: 'real', label: 'Реальные' },
  { id: 'paper', label: 'Бумажные' },
  { id: 'all', label: 'Всё вместе' },
];

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v.seconds != null) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const closedAtOf = (t) => toDate(t.closedAt) || toDate(t.closeDate);
const pad = (n) => String(n).padStart(2, '0');
export const monthKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
export const yearKey = (d) => String(d.getFullYear());

/** Привести сделки обоих источников к одной форме; фильтр «закрыта и есть результат». */
export function normalize(realTrades, paperTrades, scope) {
  const out = [];
  if (scope === 'real' || scope === 'all') {
    for (const t of realTrades || []) {
      if (!(t.status === 'closed' || t.status === 'partial') || t.pnl == null) continue;
      const closed = closedAtOf(t);
      if (!closed || !Number.isFinite(Number(t.pnl))) continue;
      out.push({ src: 'real', pnl: Number(t.pnl), closed, ticker: String(t.ticker || '—').toUpperCase(), direction: t.direction, strategy: t.entryStrategyName || t.strategyName || 'Вручную', raw: t });
    }
  }
  if (scope === 'paper' || scope === 'all') {
    for (const t of paperTrades || []) {
      if (t.status !== 'closed' || t.pnl == null) continue;
      const closed = closedAtOf(t);
      if (!closed || !Number.isFinite(Number(t.pnl))) continue;
      out.push({ src: 'paper', pnl: Number(t.pnl), closed, ticker: String(t.ticker || '—').toUpperCase(), direction: t.direction, strategy: t.entryStrategyName || 'Без названия', raw: t });
    }
  }
  return out;
}

const inPeriod = (type, key) => (x) => (type === 'year' ? yearKey(x.closed) : monthKey(x.closed)) === key;

export function prevPeriodKey(type, key) {
  if (type === 'year') return String(Number(key) - 1);
  const [y, m] = key.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${pad(m - 1)}`;
}

export function periodLabel(type, key) {
  if (type === 'year') return `${key} год`;
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS[m - 1]} ${y}`;
}

/** «августа 2025» / «2025 года» — для оборотов «против …». */
export function periodLabelGen(type, key) {
  if (type === 'year') return `${key} года`;
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_GEN[m - 1]} ${y}`;
}
/** «августе 2025» / «2025 году» — для оборотов «в …». */
export function periodLabelIn(type, key) {
  if (type === 'year') return `${key} году`;
  const [y, m] = key.split('-').map(Number);
  return `${MONTHS_PREP[m - 1]} ${y}`;
}

/** Периоды, в которых что-то закрывалось (по любому из источников), от свежего к старому. */
export function listPeriods(realTrades, paperTrades, type) {
  const keys = new Set();
  for (const x of normalize(realTrades, paperTrades, 'all')) keys.add(type === 'year' ? yearKey(x.closed) : monthKey(x.closed));
  return [...keys].sort().reverse().map((key) => ({ key, label: periodLabel(type, key) }));
}

export function statsOf(items) {
  const n = items.length;
  if (!n) return { total: 0, wins: 0, winrate: 0, pnl: 0, avg: 0, profitFactor: null, avgWin: 0, avgLoss: 0, maxDrawdown: 0, best: null, worst: null };
  const wins = items.filter((x) => x.pnl > 0);
  const losses = items.filter((x) => x.pnl < 0);
  const gross = wins.reduce((s, x) => s + x.pnl, 0);
  const lossSum = Math.abs(losses.reduce((s, x) => s + x.pnl, 0));
  // Просадка по накопленному результату в порядке закрытия.
  let cum = 0, peak = 0, dd = 0;
  for (const x of [...items].sort((a, b) => a.closed - b.closed)) {
    cum += x.pnl; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum);
  }
  const sorted = [...items].sort((a, b) => b.pnl - a.pnl);
  return {
    total: n, wins: wins.length, winrate: (wins.length / n) * 100,
    pnl: items.reduce((s, x) => s + x.pnl, 0), avg: items.reduce((s, x) => s + x.pnl, 0) / n,
    profitFactor: lossSum > 0 ? gross / lossSum : (gross > 0 ? Infinity : null),
    avgWin: wins.length ? gross / wins.length : 0, avgLoss: losses.length ? -lossSum / losses.length : 0,
    maxDrawdown: dd, best: sorted[0], worst: n > 1 ? sorted[n - 1] : null,
  };
}

/** Накопленная кривая: по дням для месяца, по месяцам для года. */
export function buildCurve(items, type, key) {
  const slots = type === 'year'
    ? Array.from({ length: 12 }, (_, i) => ({ idx: i, label: MONTHS_SHORT[i] }))
    : Array.from({ length: new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)), 0).getDate() }, (_, i) => ({ idx: i, label: String(i + 1) }));
  const pnl = new Array(slots.length).fill(0), cnt = new Array(slots.length).fill(0);
  for (const x of items) {
    const i = type === 'year' ? x.closed.getMonth() : x.closed.getDate() - 1;
    pnl[i] += x.pnl; cnt[i] += 1;
  }
  let cum = 0;
  return slots.map((s, i) => { cum += pnl[i]; return { label: s.label, pnl: pnl[i], cumulative: cum, trades: cnt[i] }; });
}

/** Группировка: по ключу → {label,count,wins,winrate,pnl,avg,profitFactor}. */
function groupBy(items, keyFn) {
  const map = new Map();
  for (const x of items) {
    const k = keyFn(x);
    if (!map.has(k)) map.set(k, []);
    map.get(k).push(x);
  }
  return [...map.entries()].map(([label, arr]) => {
    const s = statsOf(arr);
    return { label, count: s.total, wins: s.wins, winrate: s.winrate, pnl: s.pnl, avg: s.avg, profitFactor: s.profitFactor };
  }).sort((a, b) => b.pnl - a.pnl);
}

/**
 * @param {object} a
 * @param {Array} a.realTrades
 * @param {Array} a.paperTrades
 * @param {'real'|'paper'|'all'} a.scope
 * @param {'month'|'year'} a.type
 * @param {string} a.key — 'YYYY-MM' или 'YYYY'
 */
export function buildPeriodReport({ realTrades, paperTrades, scope = 'real', type = 'month', key }) {
  const all = normalize(realTrades, paperTrades, scope);
  const cur = all.filter(inPeriod(type, key));
  const prevKey = prevPeriodKey(type, key);
  const prev = all.filter(inPeriod(type, prevKey));
  const stats = statsOf(cur);
  const prevStats = statsOf(prev);

  // «Я против системы»: реальные и бумажные того же периода рядом, независимо от выбранного среза.
  const realCur = normalize(realTrades, paperTrades, 'real').filter(inPeriod(type, key));
  const paperCur = normalize(realTrades, paperTrades, 'paper').filter(inPeriod(type, key));
  const versus = { real: statsOf(realCur), paper: statsOf(paperCur) };

  return {
    scope, type, key, label: periodLabel(type, key), prevKey, prevLabel: periodLabel(type, prevKey),
    prevLabelGen: periodLabelGen(type, prevKey), prevLabelIn: periodLabelIn(type, prevKey), labelIn: periodLabelIn(type, key),
    empty: cur.length === 0, items: cur, stats, prevStats,
    delta: {
      pnl: stats.pnl - prevStats.pnl,
      winrate: prevStats.total ? stats.winrate - prevStats.winrate : null,
      total: stats.total - prevStats.total,
      hasPrev: prevStats.total > 0,
    },
    curve: buildCurve(cur, type, key),
    prevCurve: buildCurve(prev, type, prevKey),
    byStrategy: groupBy(cur, (x) => (scope === 'all' ? `${x.strategy} · ${x.src === 'paper' ? 'бумага' : 'реал'}` : x.strategy)),
    byInstrument: groupBy(cur, (x) => x.ticker),
    versus,
  };
}
