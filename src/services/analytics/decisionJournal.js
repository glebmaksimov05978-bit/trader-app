// src/services/analytics/decisionJournal.js
//
// Журнал решений: что вы делали с сигналами и чего это стоило. Бумажная сделка показывает, что
// получила бы система; ваши отметки («вошёл», «пропустил» + причина) показывают, что сделали вы.
// Рядом они отвечают на главный вопрос: «где мои решения лучше системы, а где — хуже».
//
// Считаем по ЗАКРЫТЫМ бумажным сделкам периода (у открытой результата ещё нет). Это результат
// системы по сигналу, а не ваш реальный: если вы пропустили сигнал, вы этих денег не получили и
// не потеряли — цифра показывает, сколько стоил пропуск.
//
// Чистые функции без зависимостей.
import { summarizeDecisions } from './actionMatch.js';

const toMs = (v) => {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (v.toDate) return v.toDate().getTime();
  if (v.seconds != null) return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
};

const pad = (n) => String(n).padStart(2, '0');
const periodKeyOf = (type, ms) => {
  const d = new Date(ms);
  return type === 'year' ? String(d.getFullYear()) : `${d.getFullYear()}-${pad(d.getMonth() + 1)}`;
};

const bucket = () => ({ count: 0, pnl: 0, wins: 0 });
const addTo = (b, pnl) => { b.count += 1; b.pnl += pnl; if (pnl > 0) b.wins += 1; };
const finish = (b) => ({
  count: b.count, pnl: b.pnl, wins: b.wins,
  avg: b.count ? b.pnl / b.count : 0,
  winrate: b.count ? (b.wins / b.count) * 100 : 0,
});

/**
 * @param {object} a
 * @param {Array} a.paperTrades
 * @param {Array} [a.realTrades] — для разбора «по сигналу / по своему решению» (поле entryDecision)
 * @param {'month'|'year'} a.type
 * @param {string} a.key
 */
export function buildDecisionJournal({ paperTrades = [], realTrades = [], type = 'month', key }) {
  const inPeriod = (ms) => ms != null && periodKeyOf(type, ms) === key;

  // --- сигналы периода: открытые в периоде бумажные сделки ---
  let signals = 0;
  let marked = 0;
  const followed = bucket();
  const skipped = bucket();
  const unmarked = bucket();
  const reasons = new Map();
  let autoCount = 0;
  let waiting = 0; // открытые бумажные без отметки — прямо сейчас ждут решения

  for (const t of paperTrades || []) {
    const sum = summarizeDecisions(t);
    const isOpen = t.status === 'open' || t.status === 'partial';
    if (isOpen && !sum.last) waiting += 1;

    const opened = toMs(t.openedAt) || toMs(t.date);
    if (!inPeriod(opened)) continue;
    signals += 1;
    if (sum.last) marked += 1;
    if (sum.auto) autoCount += 1;

    const closed = t.status === 'closed' && Number.isFinite(Number(t.pnl));
    if (!closed) continue;
    const pnl = Number(t.pnl);
    if (sum.entered) addTo(followed, pnl);
    else if (sum.skipped) {
      addTo(skipped, pnl);
      const r = sum.skipReason || 'без причины';
      if (!reasons.has(r)) reasons.set(r, bucket());
      addTo(reasons.get(r), pnl);
    } else addTo(unmarked, pnl);
  }

  const reasonRows = [...reasons.entries()].map(([reason, b]) => ({ reason, ...finish(b) }))
    .sort((a, b) => b.count - a.count || b.pnl - a.pnl);

  // --- ваши реальные входы: по сигналу или по своему решению ---
  const kinds = new Map();
  for (const t of realTrades || []) {
    if (t.status !== 'closed' || !Number.isFinite(Number(t.pnl))) continue;
    const c = toMs(t.closedAt) || toMs(t.closeDate);
    if (!inPeriod(c)) continue;
    const kind = t.entryDecision?.kind || 'unmarked';
    if (!kinds.has(kind)) kinds.set(kind, bucket());
    addTo(kinds.get(kind), Number(t.pnl));
  }
  const entryKinds = [...kinds.entries()].map(([kind, b]) => ({ kind, label: ENTRY_KIND_LABELS[kind] || kind, ...finish(b) }))
    .sort((a, b) => b.count - a.count);

  const f = finish(followed), s = finish(skipped), u = finish(unmarked);
  return {
    signals, marked, unmarkedSignals: signals - marked, autoCount, waiting,
    followed: f, skipped: s, unmarked: u,
    reasons: reasonRows,
    entryKinds,
    hasAnything: signals > 0 || entryKinds.length > 0,
    // Главный вывод: сравнение средней сделки по взятым и пропущенным сигналам. Только когда
    // в обеих группах есть хотя бы по 3 закрытых — иначе это шум, а не вывод.
    verdict: verdictOf(f, s),
  };
}

export const ENTRY_KIND_LABELS = {
  signal: 'По сигналу стратегии',
  own_strategy: 'По своей стратегии',
  own_analysis: 'По своему анализу',
  emotion: 'Эмоции / догоняю движение',
  other: 'Другое',
  unmarked: 'Без отметки',
};

function verdictOf(f, s) {
  if (f.count < 3 || s.count < 3) {
    return { enough: false, text: 'Для вывода нужно хотя бы по 3 закрытых сигнала среди взятых и пропущенных.' };
  }
  const diff = f.avg - s.avg;
  const round = (v) => Math.round(Math.abs(v));
  if (Math.abs(diff) < 1) return { enough: true, better: 'same', diff, text: 'Взятые и пропущенные сигналы в среднем дали одинаково.' };
  if (diff > 0) {
    return { enough: true, better: 'followed', diff, text: `Взятые сигналы в среднем лучше пропущенных на ${round(diff)} ₽ за сделку — выбор в целом был верным.` };
  }
  return { enough: true, better: 'skipped', diff, text: `Пропущенные сигналы в среднем лучше взятых на ${round(diff)} ₽ за сделку — стоит разобрать причины пропусков.` };
}
