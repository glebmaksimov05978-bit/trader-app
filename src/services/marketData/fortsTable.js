// src/services/marketData/fortsTable.js
//
// Живая таблица всех фьючерсов биржи (ISS, один запрос, без токена) с кэшем на 45 секунд. Отдельный файл БЕЗ Firebase: её подтягивают график
// (линейка в рублях и % от ГО), радар, Сопровождение и Калькулятор, и тащить из-за этого базу данных в каждый из них незачем.
import { FORTS_URL, parseFortsTable } from './marginTrack';
import { fetchRetry } from './candles';

const TABLE_TTL_MS = 45 * 1000; // не чаще раза в 45 секунд, сколько бы подписей на экране ни спрашивало
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
