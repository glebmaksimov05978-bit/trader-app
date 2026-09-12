// src/services/paperTrades.js
//
// Бумажные сделки — те, что открывает и ведёт фоновый робот по списку радара. Реальных
// денег они не касаются: ни одной заявки брокеру по ним не уходит, робот физически этого
// не умеет (торгового токена у него нет).
//
// Зачем отдельная коллекция, а не флаг `paper: true` внутри trades. Флаг пришлось бы
// помнить в КАЖДОМ месте, которое читает сделки: Журнал, депозит, отчёт за месяц,
// корзины портфеля, статистика стратегий, импорт. Забыть его хоть в одном — значит
// незаметно испортить реальную статистику трейдера бумажными цифрами, причём задним
// числом и без возможности отличить одно от другого. Отдельная коллекция делает это
// невозможным по построению: перечисленные экраны читают trades и про paperTrades просто
// не знают.
//
// Поле пользователя называется `uid` — ровно так же, как в trades. Это не косметика:
// фоновый робот однажды уже искал сделки по полю `userId`, которого в базе нет, молча
// получал ноль документов и не слал уведомлений вообще ни разу за всё время работы.
import {
  collection, addDoc, updateDoc, deleteDoc, doc, query, where, getDocs, serverTimestamp,
} from 'firebase/firestore';
import { db } from './firebase';

const COLL = 'paperTrades';

// Firestore отклоняет undefined в полях целиком — прогон через JSON выкидывает такие
// ключи за один проход (и заодно превращает Date в строку ISO).
function stripUndefined(obj) {
  return JSON.parse(JSON.stringify(obj));
}

export async function addPaperTrade(uid, trade) {
  return addDoc(collection(db, COLL), {
    ...stripUndefined(trade),
    uid,
    // Явный признак в самом документе — чтобы при отладке было видно, что это за запись,
    // даже если смотреть на неё вне контекста коллекции.
    paper: true,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updatePaperTrade(tradeId, data) {
  return updateDoc(doc(db, COLL, tradeId), {
    ...stripUndefined(data),
    updatedAt: serverTimestamp(),
  });
}

export async function deletePaperTrade(tradeId) {
  return deleteDoc(doc(db, COLL, tradeId));
}

// Дата открытия в том же виде, в каком её понимает остальное приложение: Firestore отдаёт
// Timestamp, робот может записать строку ISO.
function openedAtMs(t) {
  const v = t.openedAt || t.date;
  if (!v) return 0;
  if (v.seconds) return v.seconds * 1000;
  const ms = new Date(v).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/**
 * Все бумажные сделки пользователя, новые сверху.
 *
 * Сортировка СОЗНАТЕЛЬНО делается здесь, а не в запросе: пара where + orderBy требует в
 * Firestore отдельного составного индекса (у trades такой есть, см. firestore.indexes.json).
 * Лишний индекс — это ещё один шаг развёртывания, про который легко забыть, и тогда запрос
 * начинает падать в проде, хотя локально всё выглядело рабочим. Бумажных сделок на одного
 * трейдера немного, сортировать их в памяти дешевле, чем заводить такую зависимость.
 */
export async function getPaperTrades(uid) {
  const q = query(collection(db, COLL), where('uid', '==', uid));
  const snap = await getDocs(q);
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => openedAtMs(b) - openedAtMs(a));
}

/** Только те, что ещё в рынке, — их ведёт «Сопровождение». */
export async function getOpenPaperTrades(uid) {
  const all = await getPaperTrades(uid);
  return all.filter((t) => t.status === 'open' || t.status === 'partial');
}
