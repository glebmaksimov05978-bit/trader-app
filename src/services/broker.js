// src/services/broker.js
//
// Отправка заявки брокеру из приложения.
//
// Главное, что здесь надо понимать: торгового токена в этом файле НЕТ и быть не может.
// Всё, что делает браузер, — описывает намерение («купить SBER, 3 лота, лимит 285») и
// прикладывает Firebase ID-токен, доказывающий, что это владелец счёта. Токен брокера
// живёт секретом воркера; проверки — тоже там. Код в браузере открыт: любой секрет в
// нём уже не секрет, и любую проверку в нём можно обойти.
//
// Поэтому всё, что этот файл показывает пользователю, — подсказка, а не разрешение.
// Настоящий ответ даёт сервер, и он же отказывает.
import { auth } from './firebase';

function workerUrlOf(userProfile) {
  const url = userProfile?.orderWorkerUrl || process.env.REACT_APP_ORDER_WORKER_URL || '';
  return url.replace(/\/+$/, '');
}

async function authHeader() {
  const user = auth.currentUser;
  if (!user) throw new Error('Нужно войти в приложение');
  // forceRefresh не нужен: SDK сам обновляет токен, а лишний запрос к Google на каждое
  // нажатие только замедлит отправку.
  const token = await user.getIdToken();
  return { Authorization: `Bearer ${token}` };
}

/**
 * Что разрешено на сервере. Возвращает null, если отправка заявок не настроена вовсе, —
 * тогда интерфейс просто не показывает кнопку, а не показывает её сломанной.
 */
export async function fetchOrderConfig(userProfile) {
  const base = workerUrlOf(userProfile);
  if (!base) return null;
  try {
    const res = await fetch(`${base}/order/config`, { headers: await authHeader() });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data) return null;
    return data;
  } catch {
    return null;
  }
}

/**
 * @param {object} a
 * @param {object} a.userProfile
 * @param {string} a.ticker
 * @param {string} a.instrumentType   - 'stock' | 'future' | 'currency'
 * @param {string} a.direction        - 'buy' | 'sell'
 * @param {number} a.lots
 * @param {string} a.orderType        - 'limit' | 'market'
 * @param {number} [a.price]          - обязательна для лимитной
 * @param {string} a.requestId        - ключ идемпотентности: два нажатия = одна заявка
 * @param {boolean} [a.dryRun]        - проверить всё, но брокеру ничего не отправлять
 * @returns {Promise<{ok:boolean, preview?:object, order?:object, error?:string}>}
 */
export async function placeOrder({
  userProfile, ticker, instrumentType, direction, lots, orderType, price, requestId, dryRun,
}) {
  const base = workerUrlOf(userProfile);
  if (!base) return { ok: false, error: 'Адрес сервера заявок не настроен' };
  try {
    const res = await fetch(`${base}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({
        ticker, instrumentType, direction, lots, orderType, price, requestId, dryRun: !!dryRun,
      }),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok) return { ok: false, error: data?.error || `Сервер ответил ${res.status}` };
    return data;
  } catch (e) {
    // Сеть отвалилась — заявка МОГЛА уйти. Идемпотентность (requestId) на стороне брокера
    // не даст задвоить её при повторе, но сказать «не отправлено» здесь было бы враньём.
    return { ok: false, error: `Связь с сервером прервалась: ${e.message}. Проверьте заявки в приложении брокера, прежде чем повторять.` };
  }
}
