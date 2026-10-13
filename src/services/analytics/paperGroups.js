// src/services/analytics/paperGroups.js
//
// Бумажные сделки, разложенные по стратегиям, которые их открыли. Стратегии с разными
// горизонтами (краткосрок, среднесрок, долгосрок) друг с другом не сравнивают — у каждой своя
// «лента» и своя сводка: сколько открыто, сколько закрыто, итог закрытых, доля прибыльных,
// средний срок удержания. Чистая функция без зависимостей — проверяется тестом.
//
// Ключ стратегии — её id (entryStrategyId); у старых сделок без id — имя; без того и другого — «—».

function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v.toDate) return v.toDate();
  if (v.seconds != null) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const paperStrategyKey = (t) => t.entryStrategyId || t.entryStrategyName || '—';

function summarize(list) {
  const open = list.filter((t) => t.status === 'open' || t.status === 'partial');
  const closed = list.filter((t) => t.status === 'closed' && t.pnl != null && Number.isFinite(Number(t.pnl)));
  const pnl = closed.reduce((s, t) => s + Number(t.pnl), 0);
  const wins = closed.filter((t) => Number(t.pnl) > 0).length;
  const holdDays = closed
    .map((t) => {
      const a = toDate(t.openedAt), b = toDate(t.closedAt || t.closeDate);
      return a && b ? (b - a) / 86400000 : null;
    })
    .filter((x) => x != null && x >= 0);
  return {
    open: open.length,
    closed: closed.length,
    pnl,
    winrate: closed.length ? (wins / closed.length) * 100 : null,
    avgHoldDays: holdDays.length ? holdDays.reduce((s, x) => s + x, 0) / holdDays.length : null,
    timeframes: [...new Set(list.map((t) => t.entryTimeframe).filter(Boolean))],
  };
}

/**
 * @param {Array} paper — бумажные сделки (открытые и закрытые)
 * @returns {{ groups: Array<{key,label,...сводка}>, total: сводка }}
 *   groups отсортированы: сначала с открытыми сделками, затем по числу закрытых.
 */
export function groupPaperByStrategy(paper) {
  const map = new Map();
  for (const t of paper || []) {
    const key = paperStrategyKey(t);
    if (!map.has(key)) map.set(key, { key, label: t.entryStrategyName || 'Без стратегии', items: [] });
    map.get(key).items.push(t);
  }
  const groups = [...map.values()]
    .map((g) => ({ key: g.key, label: g.label, ...summarize(g.items) }))
    .sort((a, b) => (b.open - a.open) || (b.closed - a.closed) || a.label.localeCompare(b.label));
  return { groups, total: { key: 'all', label: 'Все', ...summarize(paper || []) } };
}
