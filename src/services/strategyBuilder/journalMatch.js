// src/services/strategyBuilder/journalMatch.js
//
// «Насколько это правило похоже на меня»: ищем в журнале сделки, перед которыми правило было выполнено, и сравниваем
// их результат с остальными. Это первое, что видит человек, — не голая доходность правила, а его собственная история:
// «под правило подходят 34 ваших сделки из 120, в них вы заработали столько-то».
//
// Честные правила подсчёта:
//   • только закрытые сделки с известным результатом; деньги — реальные рубли журнала, бумажные сюда не передаются;
//   • только инструменты класса стратегии (и выбранных групп фьючерсов); остальные — отдельной строкой «не участвуют»;
//   • сигнал ищем на свечах, ЗАКРЫВШИХСЯ до входа (по таймфрейму стратегии), с окном в несколько свечей —
//     человек часто входит не на той же свече, что и сигнал;
//   • нет свечей / мало истории для индикаторов — «нет данных», а не «не подходит».
import { resolveOpenedAt } from '../tradeDates';
import { INSTRUMENT_CLASSES, futureGroupOf, instrumentClassOf } from './ruleSpec';
import { evaluateAt, lastClosedIndex } from './evaluate';

const RANK = { exact: 3, near: 2, none: 1, na: 0 };

function bucket() {
  return { n: 0, wins: 0, losses: 0, pnl: 0, trades: [] };
}

function add(b, item) {
  b.n += 1;
  b.pnl += item.pnl;
  if (item.pnl > 0) b.wins += 1;
  else if (item.pnl < 0) b.losses += 1;
  b.trades.push(item);
}

function finish(b) {
  return {
    ...b,
    pnl: Math.round(b.pnl * 100) / 100,
    avgPnl: b.n ? Math.round((b.pnl / b.n) * 100) / 100 : null,
    winRate: b.n ? b.wins / b.n : null,
  };
}

/** Сделка — кандидат для сверки? (класс, группа фьючерсов, список тикеров, сторона). */
export function tradeEligibility(spec, trade) {
  const cls = instrumentClassOf(trade);
  if (cls !== spec.instrumentClass) return { ok: false, reason: 'class', cls };
  if (!INSTRUMENT_CLASSES[cls]?.testable) return { ok: false, reason: 'class', cls };
  if (cls === 'future' && spec.futureGroups?.length && !spec.futureGroups.includes(futureGroupOf(trade.ticker))) {
    return { ok: false, reason: 'group', cls };
  }
  if (spec.tickers?.length && !spec.tickers.map((t) => String(t).toUpperCase()).includes(String(trade.ticker || '').toUpperCase())) {
    return { ok: false, reason: 'ticker', cls };
  }
  const side = trade.direction === 'short' ? 'short' : 'long';
  if (spec.direction !== 'both' && spec.direction !== side) return { ok: false, reason: 'side', cls };
  return { ok: true, cls, side };
}

/**
 * @param {object} spec           стратегия (ruleSpec)
 * @param {Array}  trades         сделки журнала (реальные)
 * @param {(ticker: string) => object|null} dataFor  подготовленные данные свечей (evaluate.prepareData) или null
 * @param {{windowBars?: number}} [opts]  сколько свечей ДО последней закрытой тоже считаются «сигналом перед входом»
 */
export function matchJournal(spec, trades, dataFor, { windowBars = 2 } = {}) {
  const groups = { exact: bucket(), near: bucket(), none: bucket() };
  const noData = [];
  const excluded = { byClass: {}, otherSide: 0, otherGroup: 0, otherTicker: 0, open: 0 };

  for (const t of trades || []) {
    if (t?.status !== 'closed' || typeof t.pnl !== 'number' || !Number.isFinite(t.pnl)) { excluded.open += 1; continue; }
    const el = tradeEligibility(spec, t);
    if (!el.ok) {
      if (el.reason === 'class') excluded.byClass[el.cls] = (excluded.byClass[el.cls] || 0) + 1;
      else if (el.reason === 'side') excluded.otherSide += 1;
      else if (el.reason === 'group') excluded.otherGroup += 1;
      else excluded.otherTicker += 1;
      continue;
    }
    const openedAt = resolveOpenedAt(t);
    const data = openedAt ? dataFor(t.ticker) : null;
    const last = data ? lastClosedIndex(data, openedAt) : -1;
    if (last < 0) { noData.push({ id: t.id, ticker: t.ticker, reason: data ? 'beforeHistory' : 'noCandles' }); continue; }

    let best = null;
    for (let i = last; i >= Math.max(0, last - windowBars); i--) {
      const ev = evaluateAt(spec, data, i, el.side);
      if (!best || RANK[ev.state] > RANK[best.ev.state]) best = { i, ev };
      if (ev.state === 'exact') break;
    }
    if (best.ev.state === 'na') { noData.push({ id: t.id, ticker: t.ticker, reason: 'warmup' }); continue; }
    const item = {
      id: t.id, ticker: t.ticker, side: el.side, pnl: t.pnl, openedAt,
      signalIndex: best.i, barsBeforeEntry: last - best.i, state: best.ev.state,
      results: best.ev.results, partial: best.ev.partial,
    };
    add(groups[best.ev.state], item);
  }

  const total = groups.exact.n + groups.near.n + groups.none.n;
  return {
    exact: finish(groups.exact),
    near: finish(groups.near),
    none: finish(groups.none),
    checked: total,
    shareExact: total ? groups.exact.n / total : null,
    noData,
    excluded,
    // Меньше 30 сделок в группе — это наблюдение, а не вывод (договорённость с владельцем).
    smallSample: groups.exact.n < 30,
  };
}
