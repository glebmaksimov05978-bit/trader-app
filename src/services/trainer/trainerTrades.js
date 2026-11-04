// src/services/trainer/trainerTrades.js
//
// Хранилище бумажных сделок тренажёра «Тренд». ОТДЕЛЬНАЯ коллекция `trainerTrades` — не `trades` (реальные сделки:
// Журнал, депозит, отчёты, капитал, статистика стратегий) и не `paperTrades` (бумажные сделки фонового робота).
// Это даёт гарантию по построению: ни один экран, считающий реальные деньги, эту коллекцию не читает, поэтому
// учебные сделки физически не могут попасть в реальную статистику. Каждая запись к тому же помечена `kind: 'trainer'`,
// а разбор (`trainerStats.js`) принимает только такие записи.
//
// Поле пользователя — `uid` (как в trades и paperTrades): правила и фоновые скрипты ищут сделки по нему.
import {
  collection, addDoc, updateDoc, deleteDoc, doc, query, where, getDocs, serverTimestamp,
} from 'firebase/firestore';
import { db } from '../firebase';

const COLL = 'trainerTrades';

// Firestore отклоняет undefined в полях целиком — прогон через JSON выкидывает такие ключи
// (и заодно превращает Date в строку ISO).
const clean = (obj) => JSON.parse(JSON.stringify(obj));

export async function addTrainerTrade(uid, trade) {
  return addDoc(collection(db, COLL), {
    ...clean(trade),
    uid,
    kind: 'trainer',
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
  });
}

export async function updateTrainerTrade(tradeId, data) {
  return updateDoc(doc(db, COLL, tradeId), { ...clean(data), updatedAt: serverTimestamp() });
}

export async function deleteTrainerTrade(tradeId) {
  return deleteDoc(doc(db, COLL, tradeId));
}

const ms = (v) => {
  if (!v) return 0;
  if (v.seconds) return v.seconds * 1000;
  const n = new Date(v).getTime();
  return Number.isFinite(n) ? n : 0;
};

/** Все учебные сделки пользователя, новые сверху (сортировка здесь — без составного индекса, как у paperTrades). */
export async function getTrainerTrades(uid) {
  const snap = await getDocs(query(collection(db, COLL), where('uid', '==', uid)));
  return snap.docs
    .map((d) => ({ id: d.id, ...d.data() }))
    .sort((a, b) => (ms(b.createdAt) || ms(b.exitDate)) - (ms(a.createdAt) || ms(a.exitDate)));
}
