// src/services/analytics/entryStats.js
//
// Статистика по ВХОДАМ трейдера: как его сделки отработали в разрезе направления, дня
// недели, времени суток и срока удержания. Отвечает на вопрос «где я обычно входю хорошо, а
// где плачу» — на уровне, который не требует разбора каждой сделки по отдельности.
//
// Чистые функции без зависимостей (ни Firebase, ни React) — чтобы считать их можно было в
// тесте. Время суток и день недели — по Москве независимо от часового пояса компьютера.
const MSK_OFFSET_MS = 3 * 3600 * 1000;
const DAYS = ['Воскресенье', 'Понедельник', 'Вторник', 'Среда', 'Четверг', 'Пятница', 'Суббота'];

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v.seconds != null) return new Date(v.seconds * 1000);
  if (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v)) return new Date(`${v}T09:00:00Z`); // как resolveOpenedAt
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

const msk = (d) => new Date(d.getTime() + MSK_OFFSET_MS);

function session(d) {
  const h = msk(d).getUTCHours();
  if (h < 10) return 'Утренняя сессия (до 10:00)';
  if (h < 19) return 'Основная сессия (10:00–19:00)';
  return 'Вечерняя сессия (после 19:00)';
}

function holdBucket(minutes) {
  if (minutes < 60) return '1) до часа';
  if (minutes < 240) return '2) 1–4 часа';
  if (minutes < 1440) return '3) до суток';
  if (minutes < 4320) return '4) 1–3 дня';
  return '5) дольше 3 дней';
}

function addTo(map, key, pnl) {
  const cur = map.get(key) || { label: key, count: 0, wins: 0, pnl: 0 };
  cur.count += 1;
  cur.pnl += pnl;
  if (pnl > 0) cur.wins += 1;
  map.set(key, cur);
}

const finish = (map, sorter) => [...map.values()]
  .map((x) => ({ ...x, winrate: x.count ? (x.wins / x.count) * 100 : 0, avg: x.count ? x.pnl / x.count : 0 }))
  .sort(sorter);

/**
 * @param {Array} trades — сделки с реализованным результатом (поле pnl)
 * @returns {{ total, groups: Array<{ id, title, rows: Array<{label,count,wins,winrate,pnl,avg}> }> }}
 */
export function buildEntryStats(trades) {
  const dir = new Map(); const day = new Map(); const ses = new Map(); const hold = new Map();
  let total = 0;
  for (const t of trades || []) {
    if (t.pnl == null || !Number.isFinite(Number(t.pnl))) continue;
    const opened = toDate(t.openedAt || t.openDate || t.date);
    if (!opened) continue;
    const pnl = Number(t.pnl);
    total += 1;
    addTo(dir, t.direction === 'short' ? 'Шорт' : 'Лонг', pnl);
    addTo(day, DAYS[msk(opened).getUTCDay()], pnl);
    // У сделок, внесённых вручную только датой, времени нет — «сессия» для них была бы
    // выдумкой (12:00 подставляется как заглушка), поэтому их в этот разрез не берём.
    const hasTime = !(typeof (t.openedAt || t.date) === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(t.openedAt || t.date));
    if (hasTime) addTo(ses, session(opened), pnl);
    const closed = toDate(t.closedAt || t.closeDate);
    if (closed && hasTime) addTo(hold, holdBucket((closed - opened) / 60000), pnl);
  }
  const byPnl = (a, b) => b.pnl - a.pnl;
  const order = Object.fromEntries(DAYS.map((d, i) => [d, (i + 6) % 7])); // Пн первым
  return {
    total,
    groups: [
      { id: 'direction', title: 'Направление', rows: finish(dir, byPnl) },
      { id: 'weekday', title: 'День недели входа', rows: finish(day, (a, b) => order[a.label] - order[b.label]) },
      { id: 'session', title: 'Время суток входа (МСК)', rows: finish(ses, byPnl) },
      { id: 'hold', title: 'Срок удержания', rows: finish(hold, (a, b) => a.label.localeCompare(b.label)) },
    ].filter((g) => g.rows.length),
  };
}
