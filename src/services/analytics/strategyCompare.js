// src/services/analytics/strategyCompare.js
//
// Сравнение стратегий за период. Правило, которое трейдер сформулировал сам:
//   • разные горизонты или таймфреймы — ТОЛЬКО факты рядом (сигналов, сделок, итог, доля
//     прибыльных…), никаких «лучше/хуже»: краткосрок и долгосрок меряют разное;
//   • одинаковые горизонт и таймфрейм — сравнение «в лоб»: добавляется доля забранного хода и
//     разбор по общим инструментам, лучшее значение в каждой строке подсвечивается.
//
// Чистые функции без React и Firebase.
import { statsOf, monthKey, yearKey } from './periodReport.js';
import { capturedMovePct } from './excursion.js';
import { classKey, captionOf, workTimeframeOf, horizonById } from './strategyMeta.js';

const MIN_CAPTURE_SAMPLE = 3; // меньше трёх сделок с известным ходом — долю хода не показываем

const toDate = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v;
  if (v.toDate) return v.toDate();
  if (v.seconds != null) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
};

/** Найти стратегию профиля, которой открыта сделка: по id, иначе по имени. */
export function strategyOfTrade(trade, strategies) {
  const list = Array.isArray(strategies) ? strategies : [];
  if (trade?.entryStrategyId) {
    const byId = list.find((s) => s.id === trade.entryStrategyId);
    if (byId) return byId;
  }
  if (trade?.entryStrategyName) {
    const byName = list.find((s) => s.name === trade.entryStrategyName);
    if (byName) return byName;
  }
  return null;
}

function rowKey(trade, strategy) {
  return strategy?.id || trade?.entryStrategyId || trade?.entryStrategyName || '__none__';
}

function rowName(trade, strategy) {
  return strategy?.name || trade?.entryStrategyName || 'Вручную / без стратегии';
}

const holdDays = (t) => {
  const a = toDate(t.openedAt), b = toDate(t.closedAt || t.closeDate);
  return a && b && b >= a ? (b - a) / 86400000 : null;
};

const inPeriodDate = (type, key) => (d) => d && (type === 'year' ? yearKey(d) : monthKey(d)) === key;

/**
 * @param {object} a
 * @param {Array} a.items — нормализованные закрытые сделки периода (rep.items из periodReport)
 * @param {Array} [a.paperTrades] — все бумажные сделки (для счёта сигналов и «сейчас открыто»)
 * @param {Array} [a.realTrades] — все реальные сделки (то же)
 * @param {Array} a.strategies — стратегии профиля
 * @param {'month'|'year'} a.type
 * @param {string} a.key
 */
export function buildStrategyComparison({ items = [], paperTrades = [], realTrades = [], strategies = [], type = 'month', key }) {
  const rows = new Map();
  const ensure = (trade) => {
    const st = strategyOfTrade(trade, strategies);
    const k = rowKey(trade, st);
    if (!rows.has(k)) {
      rows.set(k, {
        key: k, id: st?.id || null, name: rowName(trade, st), strategy: st,
        caption: st ? captionOf(st) : '', classKey: st ? classKey(st) : null,
        horizonId: st?.horizon || null, timeframe: st ? workTimeframeOf(st) : null,
        _items: [], signals: 0, openNow: 0, _hold: [], _tickers: new Map(), _cap: [],
      });
    }
    return rows.get(k);
  };

  // закрытые сделки периода
  for (const x of items) {
    const row = ensure(x.raw || {});
    row._items.push(x);
    if (!x.partial) {
      const h = holdDays(x.raw || {});
      if (h != null) row._hold.push(h);
      const t = row._tickers.get(x.ticker) || { ticker: x.ticker, pnl: 0, count: 0 };
      t.pnl += x.pnl; t.count += 1;
      row._tickers.set(x.ticker, t);
      const mfe = Number(x.raw?.maxFavorablePct);
      const got = capturedMovePct(x.raw || {});
      if (Number.isFinite(mfe) && mfe > 0 && got != null) row._cap.push({ got, mfe });
    }
  }

  // сигналы периода (открытые в периоде) и «сейчас в рынке»
  const inOpen = inPeriodDate(type, key);
  for (const t of [...paperTrades, ...realTrades]) {
    if (!t) continue;
    const isOpen = t.status === 'open' || t.status === 'partial';
    const opened = toDate(t.openedAt) || toDate(t.date);
    if (!isOpen && !inOpen(opened)) continue;
    const st = strategyOfTrade(t, strategies);
    if (!st && !t.entryStrategyId && !t.entryStrategyName) continue; // без стратегии не считаем
    const row = ensure(t);
    if (inOpen(opened)) row.signals += 1;
    if (isOpen) row.openNow += 1;
  }

  const out = [...rows.values()].map((r) => {
    const stats = statsOf(r._items);
    const capN = r._cap.length;
    const sumMfe = r._cap.reduce((s, c) => s + c.mfe, 0);
    const sumGot = r._cap.reduce((s, c) => s + c.got, 0);
    return {
      key: r.key, id: r.id, name: r.name, caption: r.caption, classKey: r.classKey,
      horizonId: r.horizonId, timeframe: r.timeframe,
      stats, signals: r.signals, openNow: r.openNow,
      avgHoldDays: r._hold.length ? r._hold.reduce((s, x) => s + x, 0) / r._hold.length : null,
      capture: capN >= MIN_CAPTURE_SAMPLE && sumMfe > 0 ? { ratio: sumGot / sumMfe, n: capN } : null,
      tickers: [...r._tickers.values()],
    };
  }).filter((r) => r.stats.total > 0 || r.signals > 0 || r.openNow > 0)
    .sort((a, b) => b.stats.pnl - a.stats.pnl);

  // классы: одинаковые горизонт + таймфрейм
  const byClass = new Map();
  for (const r of out) {
    const k = r.classKey || `__solo:${r.key}`;
    if (!byClass.has(k)) byClass.set(k, []);
    byClass.get(k).push(r);
  }
  const clusters = [...byClass.entries()].map(([k, list]) => {
    const comparable = !k.startsWith('__solo:') && list.length >= 2;
    return {
      classKey: k.startsWith('__solo:') ? null : k,
      caption: comparable ? list[0].caption : '',
      comparable,
      rows: list,
      best: comparable ? bestOf(list) : null,
      shared: comparable ? sharedTickers(list) : [],
    };
  });

  return {
    rows: out,
    clusters,
    comparableClusters: clusters.filter((c) => c.comparable),
    hasAny: out.length > 0,
    hasComparable: clusters.some((c) => c.comparable),
    // Для подписи: чем отличаются стратегии, если они в разных классах
    differentClasses: new Set(out.map((r) => r.classKey || r.key)).size > 1,
  };
}

// Лучшие значения по метрикам внутри класса. Только числа — слово «победитель» не используется.
function bestOf(list) {
  const pick = (fn, dir = 'max', filter = () => true) => {
    const c = list.filter((r) => filter(r) && fn(r) != null && Number.isFinite(fn(r)));
    if (c.length < 2) return null; // выделять нечего, если сравнивать не с чем
    const vals = c.map(fn);
    const target = dir === 'max' ? Math.max(...vals) : Math.min(...vals);
    if (vals.every((v) => v === target)) return null; // все равны — никто не «лучше»
    return c.find((r) => fn(r) === target).key;
  };
  return {
    pnl: pick((r) => r.stats.pnl, 'max', (r) => r.stats.total > 0),
    winrate: pick((r) => r.stats.winrate, 'max', (r) => r.stats.total > 0),
    avg: pick((r) => r.stats.avg, 'max', (r) => r.stats.total > 0),
    profitFactor: pick((r) => (r.stats.profitFactor === Infinity ? 1e9 : r.stats.profitFactor), 'max', (r) => r.stats.total > 0),
    capture: pick((r) => (r.capture ? r.capture.ratio : null), 'max'),
    maxDrawdown: pick((r) => r.stats.maxDrawdown, 'min', (r) => r.stats.total > 0),
  };
}

// Инструменты, по которым отработали минимум две стратегии класса: итог каждой рядом.
function sharedTickers(list) {
  const map = new Map();
  for (const r of list) {
    for (const t of r.tickers) {
      if (!map.has(t.ticker)) map.set(t.ticker, []);
      map.get(t.ticker).push({ key: r.key, name: r.name, pnl: t.pnl, count: t.count });
    }
  }
  return [...map.entries()]
    .filter(([, v]) => v.length >= 2)
    .map(([ticker, v]) => ({ ticker, rows: v }))
    .sort((a, b) => a.ticker.localeCompare(b.ticker));
}

/** Человеческое объяснение, почему сравнивать нельзя / можно. */
export function comparisonNote(cmp) {
  if (!cmp?.hasAny) return 'За период нет сделок и сигналов по стратегиям.';
  if (cmp.hasComparable) {
    return 'Стратегии одного горизонта и таймфрейма сравниваются напрямую: у них одни и те же свечи и сроки, '
      + 'поэтому итог, доля прибыльных и доля забранного хода сопоставимы. Остальные показаны фактами.';
  }
  if (cmp.rows.length > 1) {
    return 'Стратегии работают на разных горизонтах или таймфреймах — это разные задачи, поэтому рядом только факты, без «лучше» и «хуже». '
      + 'Чтобы сравнить две стратегии честно, поставьте им одинаковые горизонт и таймфрейм (Капитал → Мои стратегии).';
  }
  return 'За период работала одна стратегия — сравнивать пока не с чем.';
}

export { horizonById };
