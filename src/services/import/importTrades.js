// src/services/import/importTrades.js
import { addTrade, updateTrade, addTradeHistoryEntry } from '../trades.js';
import { matchTransactionsToTrades } from './fifoMatcher.js';
import { TinkoffAPI, parseFutureInfo } from '../tinkoff.js';

const OBJECTIVE_FIELDS = [
  'entryPrice', 'exitPrice', 'volume', 'remainingVolume', 'commission', 'openedAt', 'closedAt',
  'direction', 'status', 'pnl', 'pnlNeedsSpecs', 'expiredUnclosed',
];
const SUBJECTIVE_FIELDS = ['emotion', 'setup', 'notes'];

// Drops any parsed transaction whose broker deal number was already folded into an
// existing trade's legs in a prior import. Filtering at the transaction level (not the
// finished-position level) means re-importing an overlapping period — e.g. a monthly
// report after a yearly one — never re-derives a position from legs already consumed by
// an existing trade, which a whole-position ID-set comparison can miss when the two
// imports see different amounts of surrounding history.
export function filterAlreadyImportedTransactions(transactions, existingTrades) {
  const consumed = new Set();
  for (const t of existingTrades) {
    for (const id of (t.sourceTransactionIds || [])) consumed.add(id);
  }
  return transactions.filter((t) => !consumed.has(t.dealNumber));
}

function roundTo2Min(date) {
  const ms = new Date(date).getTime();
  return Math.round(ms / 120000) * 120000;
}

function fingerprint(trade) {
  if (!trade.openedAt) return null;
  return [trade.ticker, trade.direction, roundTo2Min(trade.openedAt), trade.volume].join('|');
}

// Defensive fallback only — transactions are pre-filtered via
// filterAlreadyImportedTransactions() before FIFO matching, so a true duplicate should
// never actually reach here.
function findExactDuplicate(candidate, existingTrades) {
  if (!candidate.sourceTransactionIds?.length) return null;
  return existingTrades.find((t) =>
    Array.isArray(t.sourceTransactionIds) && t.sourceTransactionIds.length &&
    candidate.sourceTransactionIds.every((id) => t.sourceTransactionIds.includes(id))
  );
}

// Matches a freshly-matched position against a manually entered trade (Calculator.js),
// which has no sourceTransactionIds of its own to extend via fifoMatcher's existingTradeId
// path — this is how an import "adopts" a manual entry instead of creating a duplicate row.
function findFuzzyDuplicate(candidate, existingTrades) {
  const fp = fingerprint(candidate);
  if (!fp) return null;
  return existingTrades.find((t) => !t.sourceTransactionIds?.length && fingerprint(t) === fp);
}

// Categorizes matched positions against existing Firestore trades for the preview UI.
export function classifyForPreview(matchedTrades, existingTrades) {
  return matchedTrades.map((candidate) => {
    if (candidate.existingTradeId) {
      return { candidate, status: 'update', existing: existingTrades.find((t) => t.id === candidate.existingTradeId) };
    }
    const exact = findExactDuplicate(candidate, existingTrades);
    if (exact) return { candidate, status: 'duplicate', existing: exact };
    const fuzzy = findFuzzyDuplicate(candidate, existingTrades);
    if (fuzzy) return { candidate, status: 'update', existing: fuzzy };
    return { candidate, status: 'new', existing: null };
  });
}

// Futures P&L needs each instrument's point value, fetched async from the Tinkoff API —
// fifoMatcher.js can't do that itself (it's synchronous), so it hands off raw
// price-point differences (`pnlPoints`) for this step to rescale into rubles.
async function resolveFuturesPnl(trade, tapi) {
  if (trade.status === 'open' && trade.remainingVolume === trade.volume) {
    return { ...trade, pnl: null }; // nothing closed yet, nothing realized
  }
  if (!tapi) return { ...trade, pnl: null, pnlNeedsSpecs: true };
  try {
    const raw = await tapi.getFutureByTicker(trade.ticker);
    const info = parseFutureInfo(raw);
    if (!info?.minPriceIncrement || !info?.minPriceIncrementAmount) {
      return { ...trade, pnl: null, pnlNeedsSpecs: true };
    }
    const priceStep = info.minPriceIncrement;
    const stepCost = info.minPriceIncrementAmount;
    const pnl = trade.pnlPoints * (stepCost / priceStep) - trade.commission;
    return { ...trade, pnl: Math.round(pnl * 100) / 100, pnlNeedsSpecs: false };
  } catch {
    return { ...trade, pnl: null, pnlNeedsSpecs: true };
  }
}

// Stocks' realized P&L is already computed in rubles by fifoMatcher.js as legs are
// processed (price-diff × volume needs no per-instrument spec lookup); this just rounds it.
export async function enrichPnl(matchedTrades, tinkoffToken) {
  const tapi = tinkoffToken ? new TinkoffAPI(tinkoffToken) : null;
  const out = [];
  for (const t of matchedTrades) {
    if (t.isFuture) {
      out.push(await resolveFuturesPnl(t, tapi));
    } else {
      out.push({ ...t, pnl: t.pnl != null ? Math.round(t.pnl * 100) / 100 : null });
    }
  }
  return out;
}

function mergePatch(existing, candidate) {
  const patch = {};
  const historyEntries = [];
  for (const field of OBJECTIVE_FIELDS) {
    if (candidate[field] === undefined) continue;
    if (existing[field] !== candidate[field]) {
      historyEntries.push({ field, was: existing[field] ?? null, became: candidate[field], source: 'import-tinkoff' });
      patch[field] = candidate[field];
    }
  }
  for (const field of SUBJECTIVE_FIELDS) {
    if (!existing[field] && candidate[field]) patch[field] = candidate[field];
  }
  patch.dataSource = existing.dataSource === 'manual' ? 'hybrid' : (existing.dataSource || 'imported');
  // legs/sourceTransactionIds are arrays — candidate's version already carries the fully
  // extended history (fifoMatcher re-hydrated it from `existing` before adding new legs),
  // so it's always the authoritative superset, not something to diff field-by-field.
  patch.legs = candidate.legs;
  patch.sourceTransactionIds = candidate.sourceTransactionIds;
  return { patch, historyEntries };
}

// Runs the create/merge logic for the positions the user left checked in the preview UI.
export async function commitImport(uid, checkedTrades, existingTrades) {
  const classified = classifyForPreview(checkedTrades, existingTrades);
  let created = 0, updated = 0;

  for (const { candidate, status, existing } of classified) {
    if (status === 'duplicate') continue;

    if (status === 'update' && existing) {
      const { patch, historyEntries } = mergePatch(existing, candidate);
      if (Object.keys(patch).length) {
        await updateTrade(existing.id, patch);
        for (const h of historyEntries) await addTradeHistoryEntry(existing.id, h);
      }
      updated++;
    } else {
      const { existingTradeId, ...rest } = candidate;
      await addTrade(uid, {
        ticker: rest.ticker,
        date: rest.openedAt ? new Date(rest.openedAt).toISOString().split('T')[0] : null,
        openedAt: rest.openedAt,
        closedAt: rest.closedAt || null,
        status: rest.status,
        direction: rest.direction,
        entryPrice: rest.entryPrice,
        exitPrice: rest.exitPrice ?? null,
        volume: rest.volume,
        remainingVolume: rest.remainingVolume,
        commission: rest.commission,
        pnl: rest.pnl ?? null,
        pnlPoints: rest.pnlPoints,
        pnlNeedsSpecs: rest.pnlNeedsSpecs || false,
        isFuture: rest.isFuture || false,
        exchange: rest.exchange || null,
        dataSource: 'imported',
        brokerSource: 'tinkoff',
        parseMethod: rest.parseMethod,
        expiredUnclosed: rest.expiredUnclosed || false,
        legs: rest.legs,
        sourceTransactionIds: rest.sourceTransactionIds,
      });
      created++;
    }
  }

  return { created, updated, skippedDuplicates: classified.filter((c) => c.status === 'duplicate').length };
}

export { matchTransactionsToTrades };
