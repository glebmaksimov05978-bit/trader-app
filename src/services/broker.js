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

/**
 * Почему кнопка «Купить/Продать сразу» не показана — человеческим языком. Раньше она просто
 * молча отсутствовала (реальная жалоба: «кнопки нет и пояснения тоже нет»), и было не понять,
 * не настроен сервер, не отвечает он или тикер не разрешён. Возвращает null, если причин нет
 * (кнопка должна быть показана).
 */
export function explainOrderUnavailable(cfg, userProfile, ticker) {
  if (!workerUrlOf(userProfile)) {
    return 'Заявки не подключены: адрес сервера не указан. Впишите его в Настройки → Заявки через сервер.';
  }
  if (!cfg) return 'Сервер заявок не ответил (выключен, неверный адрес или вы не вошли). Проверьте адрес в Настройках.';
  if (cfg.killSwitch) return 'Отправка заявок выключена стоп-краном на сервере.';
  if (!cfg.enabled) {
    if (cfg.accountsError) return `Нет доступа к счетам брокера: ${cfg.accountsError}. Проверьте торговый токен.`;
    if (cfg.reason) return `Сервер отказал: ${cfg.reason}`;
    return 'Сервер заявок настроен не полностью (нет торгового токена, счетов или белого списка).';
  }
  if (ticker && !cfg.wildcard && !cfg.whitelist?.includes(String(ticker).toUpperCase())) {
    return `${String(ticker).toUpperCase()} нет в белом списке разрешённых инструментов на сервере.`;
  }
  return null;
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
 * @param {string} [a.accountId]      - на какой счёт; если счёт один — сервер подставит сам
 * @param {string} a.requestId        - ключ идемпотентности: два нажатия = одна заявка
 * @param {boolean} [a.dryRun]        - проверить всё, но брокеру ничего не отправлять
 * @returns {Promise<{ok:boolean, preview?:object, order?:object, error?:string, accounts?:object[]}>}
 */
export async function placeOrder({
  userProfile, ticker, instrumentType, direction, lots, orderType, price, accountId, requestId, dryRun,
}) {
  const base = workerUrlOf(userProfile);
  if (!base) return { ok: false, error: 'Адрес сервера заявок не настроен' };
  try {
    const res = await fetch(`${base}/order`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(await authHeader()) },
      body: JSON.stringify({
        ticker, instrumentType, direction, lots, orderType, price, accountId, requestId, dryRun: !!dryRun,
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
