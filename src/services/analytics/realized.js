// src/services/analytics/realized.js
//
// «Что реально зафиксировано и когда». Сделка может быть закрыта частями: часть прибыли уже
// получена, а позиция ещё открыта. Раньше такая прибыль нигде не учитывалась по времени:
//   • «P&L сегодня» и дневной лимит убытка брали только полностью закрытые сделки и смотрели на
//     дату ВХОДА, а не на дату фиксации;
//   • в отчёте у частично закрытой сделки нет даты закрытия, поэтому она выпадала из периода;
//   • в шапке «Сопровождения» было видно только движение цены, но не зафиксированные рубли.
// Здесь — одно место, которое отвечает на вопрос «сколько и когда зафиксировано».
//
// Чистые функции без зависимостей. Расчёт P&L одной ступени закрытия передаётся снаружи (legPnl) —
// в приложении это computeClosePnl из tradeClose.js, в тесте — подставная формула.
//
// Правило учёта, чтобы ничего не посчиталось дважды:
//   • полностью закрытая сделка — её итоговый pnl в момент закрытия (как и везде);
//   • частично закрытая — pnl каждой закрывающей ступени в момент этой ступени;
//   • когда частично закрытая закроется полностью, она перейдёт в первую категорию, и её итог
//     будет учтён один раз — в момент закрытия.

export function toDate(v) {
  if (!v) return null;
  if (v instanceof Date) return Number.isNaN(v.getTime()) ? null : v;
  if (v.toDate) return v.toDate();
  if (v.seconds != null) return new Date(v.seconds * 1000);
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? null : d;
}

export const closedAtOf = (t) => toDate(t.closedAt) || toDate(t.closeDate);

/** Закрывающие ступени сделки по времени. */
export function closeLegs(t) {
  return (Array.isArray(t.legs) ? t.legs : [])
    .filter((l) => l?.type === 'close' && Number(l.quantity) > 0)
    .map((l) => ({ leg: l, at: toDate(l.timestampUtc) }))
    .filter((x) => x.at)
    .sort((a, b) => a.at - b.at);
}

/**
 * События фиксации частично закрытой сделки: [{ at, pnl }].
 * Нет ступеней (старая сделка) — одно событие на всю накопленную сумму во время последнего
 * обновления: лучше показать, чем потерять.
 */
export function partialEvents(t, legPnl) {
  if (t.status !== 'partial' || t.pnl == null) return [];
  const legs = closeLegs(t);
  if (!legs.length || typeof legPnl !== 'function') {
    const at = toDate(t.updatedAt) || toDate(t.openedAt) || toDate(t.date);
    return at ? [{ at, pnl: Number(t.pnl) || 0, approx: true }] : [];
  }
  const out = [];
  for (const { leg, at } of legs) {
    const pnl = legPnl(t, leg);
    if (Number.isFinite(pnl)) out.push({ at, pnl });
  }
  // Если по ступеням посчитать не вышло — не теряем накопленное.
  if (!out.length) {
    const at = legs[legs.length - 1].at;
    return [{ at, pnl: Number(t.pnl) || 0, approx: true }];
  }
  return out;
}

/** Все события реализации: закрытые целиком (на дату закрытия) и фиксации частичных (по ступеням). */
export function realizedEvents(trades, legPnl) {
  const out = [];
  for (const t of trades || []) {
    if (t.pnl == null || !Number.isFinite(Number(t.pnl))) continue;
    if (t.status === 'closed') {
      const at = closedAtOf(t);
      if (at) out.push({ trade: t, at, pnl: Number(t.pnl), kind: 'closed' });
    } else if (t.status === 'partial') {
      for (const e of partialEvents(t, legPnl)) out.push({ trade: t, at: e.at, pnl: e.pnl, kind: 'partial', approx: e.approx });
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

const sameLocalDay = (a, b) => a.toDateString() === b.toDateString();

/** Реализованный результат за календарный день (по часам пользователя) и число затронутых сделок. */
export function realizedOnDay(trades, day = new Date(), legPnl) {
  const ev = realizedEvents(trades, legPnl).filter((e) => sameLocalDay(e.at, day));
  return {
    pnl: ev.reduce((s, e) => s + e.pnl, 0),
    events: ev.length,
    trades: new Set(ev.map((e) => e.trade.id || e.trade)).size,
    partialPnl: ev.filter((e) => e.kind === 'partial').reduce((s, e) => s + e.pnl, 0),
  };
}

/** Сколько сделок ОТКРЫТО в этот день (любого статуса) — для лимита «сделок в день». */
export function openedOnDay(trades, day = new Date()) {
  return (trades || []).filter((t) => {
    const d = toDate(t.openedAt) || toDate(t.date);
    return d && sameLocalDay(d, day);
  }).length;
}

/** Уже зафиксировано по открытой сделке (в рублях) — то, что в ней накоплено по ступеням. */
export function realizedOfOpen(t) {
  return (t && (t.status === 'partial' || t.status === 'open') && t.pnl != null && Number.isFinite(Number(t.pnl))) ? Number(t.pnl) : 0;
}
