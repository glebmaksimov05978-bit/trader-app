// src/services/futuresMargin.js
//
// ГО и плечо фьючерсов для приложения: живая таблица биржи (marketData/fortsTable.js) + состояние робота из базы (ГО Т-Банка и история изменений).
// Расчёты — в чистых модулях marketData/marginTrack.js и leverageMath.js (с тестами). Здесь только чтение состояния из базы.
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';

export { fetchFortsTable } from './marketData/fortsTable';

/** Состояние робота по ГО (futuresMargin/<uid>) или null — если робот ещё не работал, нет прав или нет сети. */
export async function getMarginState(uid) {
  if (!uid) return null;
  try {
    const snap = await getDoc(doc(db, 'futuresMargin', uid));
    return snap && snap.exists && snap.exists() ? snap.data() : null;
  } catch {
    return null;
  }
}
