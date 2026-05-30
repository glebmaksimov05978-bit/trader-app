// src/services/trades.js
import {
  collection, addDoc, updateDoc, deleteDoc,
  doc, query, where, orderBy, getDocs, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';

const COLL = 'trades';

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

export async function getUserTrades(uid) {
  const q = query(
    collection(db, COLL),
    where('uid', '==', uid),
    orderBy('date', 'desc')
  );
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

// Statistics calculation
export function calcStats(trades) {
  const closed = trades.filter((t) => t.status === 'closed' && t.pnl !== undefined);
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
    .filter((t) => t.status === 'closed' && t.pnl !== undefined)
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
