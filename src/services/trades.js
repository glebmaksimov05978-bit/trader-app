// src/services/trades.js
import {
  collection, addDoc, updateDoc, deleteDoc,
  doc, query, where, orderBy, getDocs, serverTimestamp, writeBatch,
} from 'firebase/firestore';
import { db } from './firebase';

const COLL = 'trades';
const IMPORT_ARTIFACTS_COLL = 'importArtifacts';

// Firestore rejects `undefined` field values outright — round-tripping through JSON
// drops any undefined keys (and turns Date objects into ISO strings) in one pass.
function stripUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

// Persists transactions the importer couldn't fold into a position (unmatched closings)
// or that were REPO legs (kept separate from real trades) — previously these were only
// counted for the import summary toast and then discarded. Kept around so a future
// "rebuild journal" feature can re-derive positions without re-uploading the report.
// `kind` dedup happens against dealNumber, since the same transaction can reappear when
// re-importing an overlapping period.
export async function saveImportArtifacts(uid, items, kind) {
  if (!items?.length) return 0;
  const existingDealNumbers = new Set(
    (await getImportArtifacts(uid, kind)).map((a) => a.dealNumber).filter(Boolean)
  );
  const fresh = items.filter((it) => !it.dealNumber || !existingDealNumbers.has(it.dealNumber));
  if (!fresh.length) return 0;

  const batch = writeBatch(db);
  for (const item of fresh) {
    const ref = doc(collection(db, IMPORT_ARTIFACTS_COLL));
    batch.set(ref, { ...stripUndefined(item), uid, kind, createdAt: serverTimestamp() });
  }
  await batch.commit();
  return fresh.length;
}

export async function getImportArtifacts(uid, kind) {
  const q = query(
    collection(db, IMPORT_ARTIFACTS_COLL),
    where('uid', '==', uid),
    where('kind', '==', kind)
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Fallback for trades saved before `openedAt`/`closedAt` existed: treat the
// legacy `date` field as noon MSK (UTC+3) so sorting/analytics stay stable.
export function resolveOpenedAt(trade) {
  if (trade.openedAt) {
    return trade.openedAt.seconds ? new Date(trade.openedAt.seconds * 1000) : new Date(trade.openedAt);
  }
  if (trade.date) {
    const d = trade.date.seconds ? new Date(trade.date.seconds * 1000) : new Date(trade.date);
    if (!trade.date.seconds && /^\d{4}-\d{2}-\d{2}$/.test(trade.date)) {
      return new Date(`${trade.date}T09:00:00Z`); // 12:00 MSK = 09:00 UTC
    }
    return d;
  }
  return null;
}

export function resolveClosedAt(trade) {
  if (trade.closedAt) {
    return trade.closedAt.seconds ? new Date(trade.closedAt.seconds * 1000) : new Date(trade.closedAt);
  }
  if (trade.closeDate) return new Date(trade.closeDate);
  return null;
}

export async function addTrade(uid, trade) {
  return addDoc(collection(db, COLL), {
    ...trade,
    uid,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateTrade(tradeId, data) {
  return updateDoc(doc(db, COLL, tradeId), {
    ...data,
    updatedAt: serverTimestamp(),
  });
}

export async function deleteTrade(tradeId) {
  return deleteDoc(doc(db, COLL, tradeId));
}

export async function addTradeHistoryEntry(tradeId, entry) {
  return addDoc(collection(db, COLL, tradeId, 'history'), {
    ...entry,
    at: serverTimestamp(),
  });
}

// Pre-allocates a document ref for a new trade without writing anything yet, so a batch
// caller (e.g. bulk import) can reference the same doc id across its own set/update ops.
export function newTradeRef() {
  return doc(collection(db, COLL));
}

export function tradeRefById(tradeId) {
  return doc(db, COLL, tradeId);
}

export function tradeHistoryRef(tradeId) {
  return doc(collection(db, COLL, tradeId, 'history'));
}

// Firestore caps a single batch at 500 writes — chunk transparently so a large import
// (many trades × several history entries each) never hits that ceiling.
const BATCH_CHUNK_SIZE = 450;

export async function commitTradeBatch(operations) {
  for (let i = 0; i < operations.length; i += BATCH_CHUNK_SIZE) {
    const batch = writeBatch(db);
    for (const op of operations.slice(i, i + BATCH_CHUNK_SIZE)) {
      if (op.type === 'set') {
        batch.set(op.ref, { ...op.data, createdAt: serverTimestamp(), updatedAt: serverTimestamp() });
      } else if (op.type === 'update') {
        batch.update(op.ref, { ...op.data, updatedAt: serverTimestamp() });
      } else if (op.type === 'history') {
        batch.set(op.ref, { ...op.data, at: serverTimestamp() });
      }
    }
    await batch.commit();
  }
}

export async function getUserTrades(uid) {
  const q = query(
    collection(db, COLL),
    where('uid', '==', uid),
    orderBy('date', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// A partially closed position (some volume still open) already has realized P&L from the
// portion that's been closed — it counts toward stats the same as a fully closed one.
function hasRealizedPnl(t) {
  return (t.status === 'closed' || t.status === 'partial') && t.pnl !== undefined && t.pnl !== null;
}

// Statistics calculation
export function calcStats(trades) {
  const closed = trades.filter(hasRealizedPnl);
  if (!closed.length) return null;

  const wins = closed.filter((t) => t.pnl > 0);
  const losses = closed.filter((t) => t.pnl < 0);
  const totalPnl = closed.reduce((s, t) => s + (t.pnl || 0), 0);
  const winrate = (wins.length / closed.length) * 100;
  const avgWin = wins.length ? wins.reduce((s, t) => s + t.pnl, 0) / wins.length : 0;
  const avgLoss = losses.length ? losses.reduce((s, t) => s + t.pnl, 0) / losses.length : 0;
  const expectancy = (winrate / 100) * avgWin + ((1 - winrate / 100)) * avgLoss;

  // Max drawdown
  let peak = 0, balance = 0, maxDD = 0;
  const sorted = [...closed].sort((a, b) => new Date(a.date) - new Date(b.date));
  sorted.forEach((t) => {
    balance += t.pnl;
    if (balance > peak) peak = balance;
    const dd = peak - balance;
    if (dd > maxDD) maxDD = dd;
  });

  // Streak
  let maxWinStreak = 0, maxLossStreak = 0, ws = 0, ls = 0;
  sorted.forEach((t) => {
    if (t.pnl > 0) { ws++; ls = 0; maxWinStreak = Math.max(maxWinStreak, ws); }
    else { ls++; ws = 0; maxLossStreak = Math.max(maxLossStreak, ls); }
  });

  // Profit factor
  const grossProfit = wins.reduce((s, t) => s + t.pnl, 0);
  const grossLoss = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = grossLoss > 0 ? grossProfit / grossLoss : grossProfit > 0 ? Infinity : 0;

  return {
    total: closed.length,
    wins: wins.length,
    losses: losses.length,
    winrate,
    totalPnl,
    avgWin,
    avgLoss,
    expectancy,
    maxDrawdown: maxDD,
    maxWinStreak,
    maxLossStreak,
    profitFactor,
    grossProfit,
    grossLoss,
  };
}

// Equity curve data
export function buildEquityCurve(trades, initialBalance = 100000) {
  const sorted = [...trades]
    .filter(hasRealizedPnl)
    .sort((a, b) => new Date(a.date) - new Date(b.date));

  let balance = initialBalance;
  const curve = [{ date: 'Start', balance }];
  sorted.forEach((t) => {
    balance += t.pnl;
    curve.push({
      date: t.date ? new Date(t.date?.seconds * 1000 || t.date).toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit' }) : '',
      balance: Math.round(balance),
      pnl: t.pnl,
    });
  });
  return curve;
}
