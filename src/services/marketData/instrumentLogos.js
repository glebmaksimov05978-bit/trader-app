// src/services/marketData/instrumentLogos.js
//
// Кэш официальных логотипов инструментов с серверов Т-Банка.
//
// Почему это вообще нужно отдельным кэшем, а не «просто спросить Т-Банк каждый раз».
// Логотип узнаётся только из ПОЛНОГО ответа Т-Инвестиций по конкретному инструменту
// (instrument.brand.logoName) — а его получают лишь в паре мест приложения (Калькулятор
// с источником цены «Т-Инвестиции», окно заявки), и только если у трейдера привязан
// токен. У MOEX логотипов нет вообще никаких. Радар, каталог, Журнал показывают тикеры
// БЕЗ обращения к Т-Банку по каждой строке — спрашивать API на каждый показ списка было
// бы и медленно, и требовало бы токен там, где сейчас он не нужен.
//
// Поэтому логотип узнаётся один раз — в любом месте, где приложение и так уже получило
// полный ответ Т-Банка по этому инструменту, — и кладётся сюда, в общую для всех
// пользователей коллекцию (это открытая справочная картинка, а не что-то личное: если
// логотип SBER узнал один трейдер, второму не нужно спрашивать Т-Банк снова).
//
// Ключ кэша — НЕ тикер фьючерса, а его базовый актив (`basicAsset`, например GAZP у
// GAZPF/GZZ6/GZH7 — все они про один и тот же газ Газпрома). Тикер фьючерса меняется
// каждый квартал при переходе на новый контракт, а логотип нефти/газа/компании — нет.
// Ключ по basicAsset означает, что при смене контракта логотип подхватится сам, без
// повторного похода в Т-Банк.
import { doc, getDoc, setDoc, collection, query, where, documentId, getDocs } from 'firebase/firestore';
import { db } from '../firebase';

const COLL = 'instrumentLogos';

// ⚠️ Путь к картинкам собран по образцу, которым пользуются сторонние проекты вокруг
// Т-Инвестиций — официально в документации API он не описан. Первое включение стоит
// проверить глазами (Калькулятор → источник «Т-Инвестиции» → любой известный тикер,
// например SBER): если появится битая картинка вместо логотипа, значит путь другой —
// правится в одном этом месте.
const LOGO_CDN = 'https://invest-brands.cdn-tinkoff.ru';

export function logoUrlFromName(logoName) {
  return logoName ? `${LOGO_CDN}/${logoName}x160.png` : null;
}

/** Ключ кэша: для фьючерса — базовый актив (переживает смену контракта), иначе тикер. */
export function logoCacheKey({ ticker, instrumentType, basicAsset }) {
  const key = instrumentType === 'future' && basicAsset ? basicAsset : ticker;
  return String(key || '').toUpperCase();
}

/** Кладёт узнанный логотип в общий кэш — вызывается там, где Т-Банк уже ответил. */
export async function cacheLogo({ ticker, instrumentType, basicAsset, logoName }) {
  if (!logoName) return;
  const key = logoCacheKey({ ticker, instrumentType, basicAsset });
  if (!key) return;
  try {
    await setDoc(doc(db, COLL, key), { logoName, updatedAt: Date.now() }, { merge: true });
  } catch { /* кэш необязателен — картинка просто не подтянется другим трейдерам */ }
}

/** Логотип одного инструмента из кэша, или null, если ещё не узнан никем. */
export async function getCachedLogo(key) {
  if (!key) return null;
  try {
    const snap = await getDoc(doc(db, COLL, key.toUpperCase()));
    return snap.exists() ? snap.data().logoName || null : null;
  } catch { return null; }
}

// Firestore ограничивает "in" тридцатью значениями за раз — список наблюдения/каталог
// режем на группы, а не спрашиваем по одному документу на каждый тикер.
const IN_CHUNK = 30;

/**
 * Логотипы сразу для списка ключей (Радар, каталог) — одним заходом на группу, а не по
 * документу на строку. Возвращает Map ключ → logoName (без записи для неузнанных).
 */
export async function getCachedLogos(keys) {
  const unique = [...new Set(keys.map((k) => String(k || '').toUpperCase()).filter(Boolean))];
  const out = new Map();
  for (let i = 0; i < unique.length; i += IN_CHUNK) {
    const chunk = unique.slice(i, i + IN_CHUNK);
    try {
      const snap = await getDocs(query(collection(db, COLL), where(documentId(), 'in', chunk)));
      snap.forEach((d) => { if (d.data().logoName) out.set(d.id, d.data().logoName); });
    } catch { /* эта группа просто останется без логотипов в кэше */ }
  }
  return out;
}
