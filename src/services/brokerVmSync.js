// src/services/brokerVmSync.js
//
// Сверка уже записанных в Журнал фьючерсных сделок с вариационной маржой Т-Банка. Нужна сделкам, открытым из
// приложения, и тем, что загружены раньше без сверки: результат «по ценам» у вечных и долларовых контрактов не равен
// деньгам брокера (фандинг, курс шага).
//
// Порядок: берём закрытые несверенные фьючерсы → запрашиваем у Т-Банка операции маржи и сделки за это время →
// убеждаемся, что в Журнале записаны ВСЕ фьючерсные сделки этого времени (иначе чужая маржа попала бы в поправку) →
// считаем поправку тем же кодом, что при загрузке из Т-Банка (import/varMarginApi.js).
// Модуль ничего не пишет сам: возвращает список правок, записывает их вызывающий.
import { applyApiVarMargin, fetchVarMarginOperations, vmOperationsFromApi } from './import/varMarginApi';
import { fetchTradeOperations, tbankOperationsToTransactions } from './import/tbankApiImport';
import { positionValueRub } from './contractMath';

const ms = (v) => {
  if (v == null) return NaN;
  if (typeof v?.toDate === 'function') return v.toDate().getTime();
  if (typeof v?.seconds === 'number') return v.seconds * 1000;
  return new Date(v).getTime();
};
const num = (v) => { const n = parseFloat(v); return Number.isFinite(n) ? n : 0; };
const isFut = (t) => t?.instrumentType === 'future' || t?.isFuture === true;
const DAY = 86400000;
export const VM_SYNC_MAX_AGE_DAYS = 370;

// Сделка журнала в виде, который понимает сверка: с ногами и временем. У сделки без ног они восстанавливаются из
// времени открытия и закрытия (так записаны простые ручные сделки).
function normalize(t) {
  let legs = Array.isArray(t.legs) ? t.legs.filter((l) => l && (l.type === 'open' || l.type === 'close')) : [];
  if (!legs.length) {
    const o = ms(t.openedAt || t.date), c = ms(t.closedAt || t.closeDate);
    if (Number.isFinite(o)) legs.push({ type: 'open', quantity: num(t.volume), timestampUtc: new Date(o) });
    if (Number.isFinite(c) && t.status === 'closed') legs.push({ type: 'close', quantity: num(t.volume), timestampUtc: new Date(c) });
  }
  return { ...t, isFuture: true, legs };
}

/** Какие сделки журнала ждут сверки: закрытые фьючерсы без отметки, не старше года. */
export function vmSyncCandidates(trades, now = Date.now()) {
  return (trades || []).filter((t) => isFut(t) && t.status === 'closed' && !t.brokerVmChecked && t.pnl != null
    && Number.isFinite(ms(t.closedAt || t.closeDate)) && now - ms(t.closedAt || t.closeDate) < VM_SYNC_MAX_AGE_DAYS * DAY);
}

// Сколько контрактов куплено и продано по каждому тикеру: «подпись», по которой сравниваем Журнал с брокером.
function volumeSignature(rows) {
  const m = new Map();
  for (const r of rows) {
    const cur = m.get(r.ticker) || { buy: 0, sell: 0 };
    cur[r.side] += r.quantity;
    m.set(r.ticker, cur);
  }
  return m;
}

/**
 * Чистая часть: по сделкам журнала, операциям маржи и сделкам брокера считает правки.
 * @returns {{updates:Array<{id:string, patch:object}>, report:Array, summary:object, mismatched:string[]}}
 */
export function planVmSync({ trades, vmItems, tradeItems, from, to, now = Date.now() }) {
  const vmOps = vmOperationsFromApi(vmItems);
  const all = (trades || []).filter((t) => isFut(t) && t.status !== 'pending' && t.status !== 'cancelled').map(normalize)
    .filter((t) => t.legs.some((l) => { const at = ms(l.timestampUtc); return at >= from && at <= to; }));

  // Полнота: в Журнале должны быть все фьючерсные сделки счёта за это время.
  const journalRows = [];
  for (const t of all) {
    for (const l of t.legs) {
      const at = ms(l.timestampUtc);
      if (!(at >= from && at <= to)) continue;
      const buy = (t.direction === 'short') !== (l.type === 'open');
      journalRows.push({ ticker: String(t.ticker || '').toUpperCase(), side: buy ? 'buy' : 'sell', quantity: num(l.quantity) });
    }
  }
  const brokerRows = tbankOperationsToTransactions(tradeItems || []).transactions.filter((x) => x.isFuture)
    .map((x) => ({ ticker: x.ticker, side: x.side, quantity: x.quantity }));
  const j = volumeSignature(journalRows), b = volumeSignature(brokerRows);
  const mismatched = [...new Set([...j.keys(), ...b.keys()])].filter((k) => {
    const x = j.get(k) || { buy: 0, sell: 0 }, y = b.get(k) || { buy: 0, sell: 0 };
    return Math.abs(x.buy - y.buy) > 1e-9 || Math.abs(x.sell - y.sell) > 1e-9;
  });

  const byTicker = vmOps.length > 0 && vmOps.every((o) => o.ticker);
  const summaryBase = { operations: vmOps.length, mismatched };
  if (!vmOps.length) return { updates: [], report: [], summary: { ...summaryBase, reason: 'Т-Банк не вернул операций вариационной маржи за это время' }, mismatched };
  if (mismatched.length && !byTicker) {
    return {
      updates: [], report: [], mismatched,
      summary: { ...summaryBase, reason: `в Журнале не все фьючерсные сделки этого времени (не сходится объём по ${mismatched.slice(0, 4).join(', ')}) — сначала загрузите сделки из Т-Банка` },
    };
  }
  const usable = all.filter((t) => !mismatched.includes(String(t.ticker || '').toUpperCase()));
  const ops = vmOps.filter((o) => !o.ticker || !mismatched.includes(o.ticker));
  const res = applyApiVarMargin(usable, ops, {
    // «ход цены» записанной сделки: результат + комиссия − прежняя поправка
    grossOf: (t) => (t.pnl != null ? num(t.pnl) + num(t.commission) - num(t.brokerAdjustment) : null),
    notionalOf: (t) => positionValueRub(t, t.entryPrice, t.volume) || null,
    periodStart: from, asOf: now,
    skip: (t) => !!t.brokerVmChecked,
  });
  const updates = [];
  res.trades.forEach((t, i) => {
    const before = usable[i];
    if (t === before || !t.brokerVmChecked || before.brokerVmChecked || !t.id) return;
    updates.push({ id: t.id, ticker: t.ticker, was: before.pnl, patch: {
      pnl: t.pnl, brokerAdjustment: t.brokerAdjustment || 0, brokerVmChecked: true, brokerVmShared: !!t.brokerVmShared, brokerVmSource: 'tbank-api',
    } });
  });
  return { updates, report: res.report, summary: { ...summaryBase, ...res.summary }, mismatched };
}

/** Полный путь с сетью: запросы к Т-Банку → план правок. Ничего не пишет. */
export async function fetchVmSyncPlan({ api, accountId, trades, now = Date.now() }) {
  const candidates = vmSyncCandidates(trades, now);
  if (!candidates.length) return { updates: [], report: [], summary: { candidates: 0 }, mismatched: [] };
  const firstOpen = Math.min(...candidates.map((t) => {
    const legs = normalize(t).legs.map((l) => ms(l.timestampUtc)).filter(Number.isFinite);
    return legs.length ? Math.min(...legs) : now;
  }));
  const from = firstOpen - DAY / 2;
  const [vmItems, tradeItems] = await Promise.all([
    fetchVarMarginOperations(api, { accountId, from: new Date(from), to: new Date(now) }),
    fetchTradeOperations(api, { accountId, from: new Date(from), to: new Date(now) }),
  ]);
  const plan = planVmSync({ trades, vmItems, tradeItems, from, to: now, now });
  return { ...plan, summary: { ...plan.summary, candidates: candidates.length } };
}
