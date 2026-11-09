// src/services/futuresMargin.js
//
// ГО и плечо фьючерсов для приложения: живая таблица биржи (ISS, без токена) + состояние робота из базы (ГО Т-Банка и история изменений).
// Расчёты — в чистом модуле marketData/marginTrack.js (с тестами). Здесь только загрузка и кэш.
import { doc, getDoc } from 'firebase/firestore';
import { db } from './firebase';
import { FORTS_URL, parseFortsTable } from './marketData/marginTrack';
import { fetchRetry } from './marketData/candles';

const TABLE_TTL_MS = 45 * 1000; // не чаще раза в 45 секунд, сколько бы строк радара ни спрашивало
let cache = { at: 0, table: null, pending: null };

/** Таблица всех фьючерсов с биржи (Map<SECID, строка>). Кэшируется на 45 секунд; при сбое отдаёт прошлую, если она есть. */
export async function fetchFortsTable({ force = false } = {}) {
  const now = Date.now();
  if (!force && cache.table && now - cache.at < TABLE_TTL_MS) return cache.table;
  if (cache.pending) return cache.pending;
  cache.pending = (async () => {
    try {
      const res = await fetchRetry(FORTS_URL, {}, { tries: 2, timeoutMs: 15000 });
      if (!res.ok) throw new Error(`MOEX ISS ${res.status}`);
      const table = parseFortsTable(await res.json());
      if (table.size < 50) throw new Error('пустая таблица фьючерсов');
      cache = { at: Date.now(), table, pending: null };
      return table;
    } catch (e) {
      const keep = cache.table;
      cache = { ...cache, pending: null };
      if (keep) return keep;
      throw e;
    }
  })();
  return cache.pending;
}

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
