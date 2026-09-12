// src/services/radar.js
//
// "Радар" — a watchlist of tickers the trader wants to keep an eye on while a setup is
// forming, before it becomes a real trade. Deliberately separate from `trades`: a radar
// item is not a position, has no entry price yet, and its technical-analysis snapshot is
// live (recomputed on demand for "now"), unlike a trade's frozen "as of entry" snapshot.
import { collection, addDoc, deleteDoc, updateDoc, doc, query, where, getDocs, serverTimestamp } from 'firebase/firestore';
import { db } from './firebase';

const COLL = 'radarItems';

export async function addRadarItem(uid, { ticker, instrumentType, note, timeframe, strategyId }) {
  const upper = ticker.toUpperCase();
  // Один и тот же тикер дважды в радаре — это две одинаковые строки, которые опрашиваются
  // по очереди и показывают одно и то же (реальная жалоба со скриншотом: два IMOEXF
  // подряд). Проверка живёт ЗДЕСЬ, а не в форме, потому что добавлять умеют два разных
  // экрана — каталог в «Сопровождении» и старая форма в Журнале, — и оба должны быть
  // защищены одинаково.
  const existing = await getRadarItems(uid);
  const dup = existing.find((i) => (i.ticker || '').toUpperCase() === upper);
  if (dup) {
    const err = new Error(`${upper} уже в радаре`);
    err.code = 'radar/duplicate';
    throw err;
  }
  return addDoc(collection(db, COLL), {
    uid,
    ticker: upper,
    instrumentType: instrumentType || 'stock',
    note: note || '',
    // Which timeframe this item's conditions should be checked against — the swing
    // levels/indicators a trader had in mind when setting up a condition can look
    // completely different on D1 vs an intraday chart, and Радар silently defaulting to
    // D1 with no way to change it made a correctly-configured condition read as failed
    // (real user report: "0 из 1", turned out to be a timeframe mismatch, not a bug in
    // the condition itself). null = D1 default, same as before this field existed.
    timeframe: timeframe || null,
    // Раньше ВЕСЬ радар проверялся по одной активной стратегии профиля — трейдер не мог
    // следить за одним тикером по пробойной, а за другим по откатной одновременно
    // (реальная жалоба: «непонятно, как за какой стратегией смотрятся тикеры»).
    // null = как раньше, берётся активная стратегия профиля на момент проверки.
    strategyId: strategyId || null,
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

/**
 * Поменять поля уже добавленного тикера — сейчас это только `strategyId`. Раньше
 * стратегию можно было задать ровно один раз, при добавлении: чтобы следить за тем же
 * тикером другой стратегией, приходилось удалять его и заводить заново.
 */
export async function updateRadarItem(id, patch) {
  return updateDoc(doc(db, COLL, id), patch);
}
