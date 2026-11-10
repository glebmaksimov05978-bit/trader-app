// src/services/marketData/brokerMarginClient.js
//
// ГО фьючерсов у БРОКЕРА (Т-Банк) прямо из приложения — по токену трейдера, который он сохранил в Настройках (тот же путь, что у Калькулятора).
//
// Зачем. Сделки идут через Т-Банк, а биржевое ГО у него обычно ниже на несколько процентов (у шорта бывает заметно выше). Робот на GitHub
// ходит к Т-Банку только через посредника (RELAY_*), которого может не быть, а сам браузер владельца с Т-Банком связывается и так. Поэтому
// радар, строка контракта у графика и линейка спрашивают ГО у брокера сами и подписывают его «Т-Банк»; если спросить не вышло (нет токена,
// брокер недоступен) — остаётся биржевое с подписью «биржа».
//
// Запросов немного: каждый контракт спрашивается раз в полчаса (кэш в памяти вкладки), неудача запоминается на 5 минут, чтобы не долбить брокера.
import { TinkoffAPI } from '../tinkoff';
import { parseBrokerFutureMargin } from './brokerMargin';

const OK_TTL_MS = 30 * 60 * 1000;
const FAIL_TTL_MS = 5 * 60 * 1000;
const PARALLEL = 3;
const MAX_PER_CALL = 30;

let cache = { token: '', items: new Map() }; // SECID → { at, ok, buy, sell }

/** Забыть всё (смена токена, выход из аккаунта, тесты). */
export function resetBrokerMarginCache() { cache = { token: '', items: new Map() }; }

async function fetchOne(api, secid) {
  let raw = await api.getFutureByTicker(secid);
  if (!raw) return null;
  raw = await api.withFuturesMargin(raw);
  return parseBrokerFutureMargin(raw);
}

/**
 * ГО Т-Банка по списку контрактов (SECID). Берёт из кэша то, что свежее; остальное спрашивает у брокера.
 * @param {string} token   токен Т-Инвестиций из профиля (нет токена — пустая карта)
 * @param {string[]} secids
 * @returns {Promise<Map<string,{buy:number, sell:number}>>} только те контракты, по которым брокер ГО прислал
 */
export async function fetchBrokerMargins(token, secids) {
  const out = new Map();
  if (!token || !Array.isArray(secids) || !secids.length) return out;
  if (cache.token !== token) cache = { token, items: new Map() };
  const now = Date.now();
  const need = [];
  for (const secid of [...new Set(secids.filter(Boolean))].slice(0, MAX_PER_CALL)) {
    const hit = cache.items.get(secid);
    if (hit && now - hit.at < (hit.ok ? OK_TTL_MS : FAIL_TTL_MS)) continue;
    need.push(secid);
  }
  if (need.length) {
    const api = new TinkoffAPI(token);
    let i = 0;
    const worker = async () => {
      while (i < need.length) {
        const secid = need[i++];
        try {
          const m = await fetchOne(api, secid);
          cache.items.set(secid, m ? { at: Date.now(), ok: true, buy: m.initialMarginBuy, sell: m.initialMarginSell } : { at: Date.now(), ok: false });
        } catch {
          cache.items.set(secid, { at: Date.now(), ok: false });
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(PARALLEL, need.length) }, worker));
  }
  for (const secid of secids) {
    const hit = cache.items.get(secid);
    if (hit && hit.ok) out.set(secid, { buy: hit.buy, sell: hit.sell });
  }
  return out;
}
