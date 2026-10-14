// src/services/analytics/actionMatch.js
//
// Отметка ВАШИХ действий по бумажным сигналам. Бумажную сделку открывает и ведёт робот, а что
// сделали вы — вошли ли по сигналу, снимали ли часть, вышли ли — приложение не знало, пока вы не
// отметите вручную. Здесь два пути:
//   • вручную — кнопки в приложении и в Telegram («Вошёл», «Пропустил», «Снял часть», «Закрыл»);
//   • автоматически — робот спрашивает у Т-Банка позиции по тикерам открытых бумажных сделок и
//     по изменению позиции определяет, что вы сделали.
//
// Важно честно понимать, что здесь «определено»: по позиции видно, что у вас появился/уменьшился/
// пропал инструмент, но не видно, ПО КАКОМУ сигналу. Поэтому:
//   • если в журнале уже есть ваша сделка по этому тикеру и направлению — позиция считается
//     учтённой там, лишних отметок не создаём;
//   • если по одному тикеру в одну сторону открыты бумажные сделки сразу нескольких стратегий —
//     событие помечается «неоднозначно», и вас спросят, по какой вы входили;
//   • всё определённое автоматически помечено via: 'broker' — видно, что это вывод системы, а не
//     ваше слово, и его можно поправить.
//
// Чистые функции без зависимостей: проверяются тестом, подключаются и в приложение, и в робот.

export const ACTION_LABELS = {
  entered: 'Вошёл по сигналу',
  skipped: 'Пропустил',
  fixed_partial: 'Снял часть',
  closed_full: 'Закрыл целиком',
  not_this: 'Позиция не по этому сигналу',
};

const upper = (s) => String(s || '').toUpperCase();
const num = (v) => {
  const n = Number(v);
  return Number.isFinite(n) ? n : 0;
};
const isOpen = (t) => t && (t.status === 'open' || t.status === 'partial');
const sideSign = (dir) => (dir === 'short' ? -1 : 1);

function toMs(v) {
  if (!v) return null;
  if (v instanceof Date) return v.getTime();
  if (v.toDate) return v.toDate().getTime();
  if (v.seconds != null) return v.seconds * 1000;
  const t = new Date(v).getTime();
  return Number.isNaN(t) ? null : t;
}

/** Сколько единиц инструмента держит трейдер В СТОРОНУ сделки (0 — позиции нет или она в другую сторону). */
export function heldInDirection(signedBalance, direction) {
  const held = num(signedBalance) * sideSign(direction);
  return held > 0 ? held : 0;
}

/**
 * Сверка открытых бумажных сделок с позициями у брокера.
 *
 * @param {object} a
 * @param {Array} a.paperTrades — бумажные сделки (открытые; закрытые за последние дни — для «вы ещё в позиции»)
 * @param {Record<string, number>} a.balances — позиции брокера: ТИКЕР → баланс со знаком (шт. или контракты)
 * @param {Array} [a.journalTrades] — ваши сделки из журнала (открытые)
 * @param {number} [a.nowMs]
 * @returns {{ events: Array, patches: Record<string, object> }}
 *   events:  { paperId, ticker, direction, strategy, kind, qty, held, ambiguous, candidates }
 *   patches: paperId → новое значение brokerWatch (записать в сделку)
 */
export function reconcileWithBroker({ paperTrades = [], balances = {}, journalTrades = [], nowMs = Date.now() }) {
  const events = [];
  const patches = {};

  const journalHas = (ticker, dir) => (journalTrades || []).some((j) => isOpen(j)
    && upper(j.ticker) === ticker && (j.direction === 'short' ? 'short' : 'long') === dir);

  // группы «тикер|направление» среди открытых бумажных — для неоднозначности
  const groups = new Map();
  for (const p of paperTrades || []) {
    if (!isOpen(p)) continue;
    const k = `${upper(p.ticker)}|${p.direction === 'short' ? 'short' : 'long'}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(p);
  }

  for (const p of paperTrades || []) {
    const ticker = upper(p.ticker);
    const dir = p.direction === 'short' ? 'short' : 'long';
    const held = heldInDirection(balances[ticker], dir);
    const w = p.brokerWatch || { state: 'none', lastQty: 0, maxQty: 0 };
    const base = { paperId: p.id, ticker, direction: dir, strategy: p.entryStrategyName || null };

    // закрытая роботом сделка: если вы всё ещё в позиции — один раз напомнить
    if (!isOpen(p)) {
      const closedMs = toMs(p.closedAt) || toMs(p.closeDate);
      const fresh = closedMs != null && nowMs - closedMs <= 10 * 86400000;
      if (fresh && w.state === 'in') {
        if (held > 0 && !w.notifiedExit) {
          events.push({ ...base, kind: 'system_exit_still_holding', qty: held, held });
          patches[p.id] = { ...w, notifiedExit: true };
        } else if (held === 0 && w.state === 'in') {
          patches[p.id] = { ...w, state: 'out', lastQty: 0 };
        }
      }
      continue;
    }

    const group = groups.get(`${ticker}|${dir}`) || [p];
    const ambiguous = group.length > 1;

    if (w.state === 'in') {
      if (held === 0) {
        events.push({ ...base, kind: 'closed', qty: num(w.lastQty), held: 0 });
        patches[p.id] = { ...w, state: 'out', lastQty: 0, lastSeenMs: nowMs };
      } else if (held < num(w.lastQty)) {
        events.push({ ...base, kind: 'partial', qty: num(w.lastQty) - held, held });
        patches[p.id] = { ...w, lastQty: held, lastSeenMs: nowMs };
      } else if (held > num(w.lastQty)) {
        // докупили — отдельного события нет, просто запоминаем новый объём
        patches[p.id] = { ...w, lastQty: held, maxQty: Math.max(num(w.maxQty), held), lastSeenMs: nowMs };
      }
      continue;
    }

    if (w.state === 'journal' || w.state === 'ambiguous' || w.state === 'declined') {
      // позиция исчезла — сбрасываем, чтобы следующий вход определился заново
      if (held === 0) patches[p.id] = { state: 'none', lastQty: 0, maxQty: 0, lastSeenMs: nowMs };
      continue;
    }

    // none / out
    if (held > 0) {
      const mine = summarizeDecisions(p);
      if (mine.declined) {
        // Вы сами сказали «это не по этому сигналу» — больше не гадаем.
        patches[p.id] = { state: 'declined', lastQty: held, maxQty: held, lastSeenMs: nowMs };
      } else if (mine.entered && !mine.auto) {
        // Вход уже отмечен вручную — просто начинаем следить за позицией, без повторного события.
        patches[p.id] = { state: 'in', lastQty: held, maxQty: held, firstSeenMs: nowMs, lastSeenMs: nowMs };
      } else if (journalHas(ticker, dir)) {
        patches[p.id] = { state: 'journal', lastQty: held, maxQty: held, lastSeenMs: nowMs };
      } else if (ambiguous) {
        patches[p.id] = { state: 'ambiguous', lastQty: held, maxQty: held, lastSeenMs: nowMs };
        events.push({
          ...base, kind: 'entered', qty: held, held, ambiguous: true,
          candidates: group.map((g) => ({ paperId: g.id, strategy: g.entryStrategyName || null })),
        });
      } else {
        patches[p.id] = { state: 'in', lastQty: held, maxQty: held, firstSeenMs: nowMs, lastSeenMs: nowMs };
        events.push({ ...base, kind: 'entered', qty: held, held, ambiguous: false });
      }
    }
  }

  // Неоднозначный вход: одно событие на группу, а не по числу кандидатов
  const seen = new Set();
  const dedup = events.filter((e) => {
    if (!e.ambiguous) return true;
    const k = `${e.ticker}|${e.direction}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });

  return { events: dedup, patches };
}

/** Событие → запись в журнал решений (поле decisions у бумажной сделки). */
export function eventToDecision(ev, atIso) {
  const at = atIso || new Date().toISOString();
  const map = {
    entered: { action: 'entered', reason: ev.ambiguous ? 'по данным Т-Банка (стратегия не определена)' : 'по данным Т-Банка' },
    partial: { action: 'fixed_partial', reason: 'по данным Т-Банка' },
    closed: { action: 'closed_full', reason: 'по данным Т-Банка' },
    system_exit_still_holding: null,
  };
  const m = map[ev.kind];
  if (!m) return null;
  return { at, action: m.action, reason: m.reason, via: 'broker', qty: ev.qty ?? null, ambiguous: ev.ambiguous === true };
}

/** Текст для Telegram: что система увидела у брокера. Без разметки — экранирует вызывающий. */
export function describeEvent(ev) {
  const dir = ev.direction === 'short' ? 'шорт' : 'лонг';
  const strat = ev.strategy ? ` по стратегии «${ev.strategy}»` : '';
  switch (ev.kind) {
    case 'entered':
      return ev.ambiguous
        ? `У вас в Т-Банке появилась позиция ${ev.ticker} (${dir}, ${fmtQty(ev.qty)}). Бумажные сигналы по нему открыты у нескольких стратегий: `
          + `${(ev.candidates || []).map((c) => `«${c.strategy || 'без названия'}»`).join(', ')}. По какой вы вошли?`
        : `Вижу в Т-Банке вашу позицию ${ev.ticker} (${dir}, ${fmtQty(ev.qty)}) — отметил, что вы вошли${strat}.`;
    case 'partial':
      return `По ${ev.ticker} позиция уменьшилась на ${fmtQty(ev.qty)} (осталось ${fmtQty(ev.held)}) — отметил частичную фиксацию${strat}.`;
    case 'closed':
      return `Позиции по ${ev.ticker} в Т-Банке больше нет — отметил, что вы вышли${strat}.`;
    case 'system_exit_still_holding':
      return `Система закрыла бумажную сделку по ${ev.ticker}${strat}, а в Т-Банке у вас позиция ещё есть (${fmtQty(ev.held)}).`;
    default:
      return '';
  }
}

function fmtQty(q) {
  const n = Number(q);
  if (!Number.isFinite(n)) return '—';
  return `${Math.round(n * 1000) / 1000} шт.`;
}

/**
 * Свод решений по бумажной сделке — что вы с ней сделали, на последнее решение.
 * @returns {{ entered:boolean, skipped:boolean, skipReason:string|null, partials:number, closed:boolean, last:object|null, auto:boolean }}
 */
export function summarizeDecisions(paperTrade) {
  const list = Array.isArray(paperTrade?.decisions) ? [...paperTrade.decisions] : [];
  list.sort((a, b) => (toMs(a.at) || 0) - (toMs(b.at) || 0));
  const out = { entered: false, skipped: false, skipReason: null, partials: 0, closed: false, declined: false, last: null, auto: false };
  for (const d of list) {
    if (d.action === 'entered') { out.entered = true; out.skipped = false; out.declined = false; }
    else if (d.action === 'skipped') { out.skipped = true; out.skipReason = d.reason || null; }
    else if (d.action === 'fixed_partial') out.partials += 1;
    else if (d.action === 'closed_full') out.closed = true;
    else if (d.action === 'not_this') { out.entered = false; out.partials = 0; out.closed = false; out.declined = true; }
  }
  out.last = list.length ? list[list.length - 1] : null;
  out.auto = !!out.last && out.last.via === 'broker';
  return out;
}

/** Короткая подпись статуса для плашки сделки: «Вы: вошли · снято 1 раз». */
export function statusLine(paperTrade) {
  const s = summarizeDecisions(paperTrade);
  if (!s.last) return null;
  if (s.closed) return `Вы: вышли${s.partials ? `, фиксаций было ${s.partials}` : ''}`;
  if (s.entered) return `Вы: вошли${s.partials ? ` · снято частями ${s.partials}` : ''}`;
  if (s.skipped) return `Вы: пропустили${s.skipReason ? ` — ${s.skipReason}` : ''}`;
  return null;
}
