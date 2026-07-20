// src/services/radar.js
//
// "Радар" — a watchlist of tickers the trader wants to keep an eye on while a setup is
// forming, before it becomes a real trade. Deliberately separate from `trades`: a radar
// item is not a position, has no entry price yet, and its technical-analysis snapshot is
// live (recomputed on demand for "now"), unlike a trade's frozen "as of entry" snapshot.
import { collection, addDoc, deleteDoc, doc, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

const COLL = 'radarItems';

export async function addRadarItem(uid, { ticker, instrumentType, note, timeframe }) {
  return addDoc(collection(db, COLL), {
    uid,
    ticker: ticker.toUpperCase(),
    instrumentType: instrumentType || 'stock',
    note: note || '',
    // Which timeframe this item's conditions should be checked against — the swing
    // levels/indicators a trader had in mind when setting up a condition can look
    // completely different on D1 vs an intraday chart, and Радар silently defaulting to
    // D1 with no way to change it made a correctly-configured condition read as failed
    // (real user report: "0 из 1", turned out to be a timeframe mismatch, not a bug in
    // the condition itself). null = D1 default, same as before this field existed.
    timeframe: timeframe || null,
    createdAt: serverTimestamp(),
  });
}

export async function getRadarItems(uid) {
  const q = query(collection(db, COLL), where('uid', '==', uid));
  const snap = await getDocs(q);
  return snap.docs.map((d) => ({ id: d.id, ...d.data() }));
}

export async function deleteRadarItem(id) {
  return deleteDoc(doc(db, COLL, id));
}
