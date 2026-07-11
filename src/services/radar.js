// src/services/radar.js
//
// "Радар" — a watchlist of tickers the trader wants to keep an eye on while a setup is
// forming, before it becomes a real trade. Deliberately separate from `trades`: a radar
// item is not a position, has no entry price yet, and its technical-analysis snapshot is
// live (recomputed on demand for "now"), unlike a trade's frozen "as of entry" snapshot.
import { collection, addDoc, deleteDoc, doc, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

const COLL = 'radarItems';

export async function addRadarItem(uid, { ticker, instrumentType, note }) {
  return addDoc(collection(db, COLL), {
    uid,
    ticker: ticker.toUpperCase(),
    instrumentType: instrumentType || 'stock',
    note: note || '',
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
