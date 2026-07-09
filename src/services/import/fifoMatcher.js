// src/services/import/fifoMatcher.js
import { isFuturesCode, decodeFuturesExpiry } from './instrumentResolver';

// transaction shape (post-parse, pre-match):
// {
//   dealNumber, ticker, isin, exchange, side: 'buy'|'sell', assetName,
//   price, quantity, amount, currency, commission, timestampUtc,
//   isFuture, tradeMode, parseMethod,
// }

// Position model: one document per real-world position (open → possibly several partial
// closes/re-opens → fully closed), not one document per matched open/close *pair*. Every
// buy/sell that touches the position becomes a "leg" in its `legs` array, so the journal
// can show the whole step-by-step history under one row instead of fragmenting a single
// trade into several rows whenever it was closed in more than one broker transaction.

function commissionOf(t) {
  return t.commission || 0;
}

function durationMinutes(openedAt, closedAt) {
  if (!closedAt) return null;
  return Math.round((new Date(closedAt) - new Date(openedAt)) / 60000);
}

// Starts a brand-new position from its first leg.
function openPosition(ticker, exchange, isFuture, tx, quantity) {
  return {
    ticker,
    exchange,
    isFuture,
    direction: tx.side === 'buy' ? 'long' : 'short',
    volume: quantity,
    remainingVolume: quantity,
    entryPrice: tx.price,
    exitPrice: null,
    openedAt: tx.timestampUtc,
    closedAt: null,
    commission: commissionOf(tx) * (quantity / tx.quantity),
    pnl: null,
    pnlPoints: 0, // futures only: raw price-point P&L, rescaled to rubles in enrichPnl()
    legs: [{
      type: 'open', side: tx.side, price: tx.price, quantity,
      commission: commissionOf(tx) * (quantity / tx.quantity),
      timestampUtc: tx.timestampUtc, dealNumber: tx.dealNumber,
    }],
    existingTradeId: null,
  };
}

// Re-hydrates an in-progress position from its Firestore document so new legs can extend
// it exactly as if the whole import history had been processed in one pass. Trades from
// before this schema (manual Calculator entries, or positions imported prior to this
// change) have no `legs` array — synthesize a single opening leg from their aggregate
// fields so they can still be extended going forward.
function fromExistingTrade(et) {
  const legs = Array.isArray(et.legs) && et.legs.length
    ? et.legs.map((l) => ({ ...l }))
    : [{
        type: 'open', side: et.direction === 'long' ? 'buy' : 'sell',
        price: et.entryPrice, quantity: et.remainingVolume ?? et.volume,
        commission: et.commission || 0, timestampUtc: et.openedAt, dealNumber: null,
      }];
  return {
    ticker: et.ticker,
    exchange: et.exchange,
    isFuture: !!et.isFuture,
    direction: et.direction,
    volume: et.volume ?? (et.remainingVolume ?? 0),
    remainingVolume: et.remainingVolume ?? et.volume ?? 0,
    entryPrice: et.entryPrice,
    exitPrice: et.exitPrice ?? null,
    openedAt: et.openedAt,
    closedAt: et.closedAt ?? null,
    commission: et.commission || 0,
    pnl: et.pnl ?? null,
    pnlPoints: et.pnlPoints || 0,
    legs,
    existingTradeId: et.id,
  };
}

function addOpenLeg(position, tx, quantity) {
  const newVolume = position.remainingVolume + quantity;
  position.entryPrice = (position.entryPrice * position.remainingVolume + tx.price * quantity) / newVolume;
  position.remainingVolume = newVolume;
  position.volume += quantity;
  const legCommission = commissionOf(tx) * (quantity / tx.quantity);
  position.commission += legCommission;
  position.legs.push({
    type: 'open', side: tx.side, price: tx.price, quantity,
    commission: legCommission, timestampUtc: tx.timestampUtc, dealNumber: tx.dealNumber,
  });
}

// Closes `closeVol` of the position at this leg's price. Realized P&L for stocks is
// computed in rubles right here (price-diff × volume, matching the broker's own ruble
// amounts closely enough); futures P&L needs a per-instrument point value looked up async,
// so we only accumulate raw point-difference × volume here and let enrichPnl() in
// importTrades.js rescale it to rubles once it has fetched that instrument's spec.
function addCloseLeg(position, tx, closeVol) {
  const legCommission = commissionOf(tx) * (closeVol / tx.quantity);
  position.commission += legCommission;
  const sign = position.direction === 'long' ? 1 : -1;
  const priceDiff = (tx.price - position.entryPrice) * sign;

  if (position.isFuture) {
    position.pnlPoints += priceDiff * closeVol;
  } else {
    position.pnl = (position.pnl || 0) + priceDiff * closeVol - legCommission;
  }

  position.exitPrice = position.exitPrice == null
    ? tx.price
    : (position.exitPrice * (position.volume - position.remainingVolume) + tx.price * closeVol) / (position.volume - position.remainingVolume + closeVol);
  position.remainingVolume -= closeVol;
  position.closedAt = tx.timestampUtc;
  position.legs.push({
    type: 'close', side: tx.side, price: tx.price, quantity: closeVol,
    commission: legCommission, timestampUtc: tx.timestampUtc, dealNumber: tx.dealNumber,
    entryPriceAtClose: position.entryPrice,
  });
}

function finalize(position, isFuture) {
  const status = position.remainingVolume === 0 ? 'closed' : (position.remainingVolume < position.volume ? 'partial' : 'open');
  const expiry = isFuture ? decodeFuturesExpiry(position.ticker) : null;
  return {
    ticker: position.ticker,
    exchange: position.exchange,
    isFuture,
    direction: position.direction,
    status,
    volume: position.volume,
    remainingVolume: position.remainingVolume,
    entryPrice: position.entryPrice,
    exitPrice: position.exitPrice,
    openedAt: position.openedAt,
    closedAt: status === 'closed' ? position.closedAt : null,
    durationMinutes: status === 'closed' ? durationMinutes(position.openedAt, position.closedAt) : null,
    commission: position.commission,
    pnl: position.isFuture ? null : position.pnl,
    // Firestore rejects `undefined` field values outright, so this must always be a
    // real number — 0 for non-futures (unused, but harmless) rather than undefined.
    pnlPoints: position.isFuture ? position.pnlPoints : 0,
    pnlNeedsSpecs: position.isFuture,
    legs: position.legs,
    sourceTransactionIds: position.legs.map((l) => l.dealNumber).filter(Boolean),
    existingTradeId: position.existingTradeId,
    dataSource: 'imported',
    brokerSource: 'tinkoff',
    parseMethod: position.legs[position.legs.length - 1]?.parseMethod || 'exact',
    expiredUnclosed: status !== 'closed' && expiry ? expiry < new Date() : false,
  };
}

export function matchTransactionsToTrades(transactions, existingOpenTrades = []) {
  const matched = [];
  const unmatchedClosings = [];
  const closedExistingIds = [];

  const byTicker = new Map();
  for (const t of transactions) {
    if (!byTicker.has(t.ticker)) byTicker.set(t.ticker, []);
    byTicker.get(t.ticker).push(t);
  }

  const existingByTicker = new Map();
  for (const et of existingOpenTrades) {
    if (et.status === 'closed') continue;
    if (!existingByTicker.has(et.ticker)) existingByTicker.set(et.ticker, []);
    existingByTicker.get(et.ticker).push(et);
  }

  for (const [ticker, txs] of byTicker) {
    const sorted = [...txs].sort((a, b) => new Date(a.timestampUtc) - new Date(b.timestampUtc));
    const isFuture = sorted.some((t) => t.isFuture) || isFuturesCode(ticker);

    const candidates = (existingByTicker.get(ticker) || []).sort((a, b) => new Date(a.openedAt) - new Date(b.openedAt));
    // Each finalized position below carries its own `existingTradeId` — that's what tells
    // importTrades.js whether to update this Firestore doc or create a new one, so this
    // list is only informational (e.g. for import-summary counts), not used for branching.
    let position = candidates.length ? fromExistingTrade(candidates[0]) : null;
    if (position?.existingTradeId) closedExistingIds.push(position.existingTradeId);

    for (const tx of sorted) {
      let remaining = tx.quantity;
      const txDirection = tx.side === 'buy' ? 'long' : 'short';

      if (!position) {
        if (tx.side === 'sell' && !isFuture) {
          // Stocks can't legitimately open a short from thin air — the opening buy must
          // predate this batch and the existing trades we were given.
          unmatchedClosings.push({ ...tx, remaining });
          continue;
        }
        position = openPosition(ticker, tx.exchange, isFuture, tx, remaining);
        continue;
      }

      if (position.direction === txDirection) {
        addOpenLeg(position, tx, remaining);
        continue;
      }

      while (remaining > 0 && position && position.direction !== txDirection) {
        const closeVol = Math.min(position.remainingVolume, remaining);
        addCloseLeg(position, tx, closeVol);
        remaining -= closeVol;

        if (position.remainingVolume === 0) {
          matched.push(finalize(position, isFuture));
          position = remaining > 0 ? openPosition(ticker, tx.exchange, isFuture, { ...tx, quantity: remaining }, remaining) : null;
          remaining = 0;
        }
      }
    }

    if (position) matched.push(finalize(position, isFuture));
  }

  return { matched, unmatchedClosings, closedExistingIds };
}
