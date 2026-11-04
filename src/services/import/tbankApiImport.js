// src/services/import/tbankApiImport.js
//
// Автоимпорт истории сделок из API Т-Банка: операции по счёту (GetOperationsByCursor) превращаются в те же
// «транзакции», что даёт разбор брокерского отчёта, и дальше идут тем же путём (дубли → FIFO → позиции с
// ногами → предпросмотр → запись). Поэтому журнал из API и журнал из файла устроены одинаково.
//
// ГЛАВНОЕ ПРАВИЛО: ничего не угадывать молча. Главная неясность — в каких единицах Т-Банк присылает количество
// акций (в лотах или в штуках): в отчёте всегда штуки. Поэтому единицы определяются по самой операции:
// сумма операции должна равняться цене × количество (× лот, если количество в лотах). Если не сходится ни так,
// ни так — операция НЕ импортируется, а попадает в список пропущенных с причиной (виден в предпросмотре).
//
// Модуль чистый (без зависимостей), кроме функций, которым передают объект API.

const money = (v) => (v ? Number(v.units || 0) + Number(v.nano || 0) / 1e9 : 0);
const num = (v) => { const n = Number(v); return Number.isFinite(n) ? n : 0; };

// Типы операций-сделок. Комиссии, дивиденды, налоги и т.п. — не сделки и в журнал не идут.
const SIDE = {
  OPERATION_TYPE_BUY: 'buy', OPERATION_TYPE_BUY_CARD: 'buy', OPERATION_TYPE_BUY_MARGIN: 'buy',
  OPERATION_TYPE_SELL: 'sell', OPERATION_TYPE_SELL_CARD: 'sell', OPERATION_TYPE_SELL_MARGIN: 'sell',
};
export const API_TRADE_OPERATION_TYPES = Object.keys(SIDE);

/** Вид инструмента для журнала: 'stock' | 'future' | null (остальное пока не поддерживается). */
export function kindOf(item) {
  const raw = String(item.instrumentType || '').toLowerCase()
    || String(item.instrumentKind || '').replace('INSTRUMENT_TYPE_', '').toLowerCase();
  if (raw === 'share' || raw === 'etf') return 'stock';
  if (raw === 'futures' || raw === 'future') return 'future';
  return null;
}

/** Сделки (исполнения) внутри операции: из массива сделок, а если его нет — сама операция одной сделкой. */
export function operationDeals(item) {
  const trades = item.tradesInfo?.trades || [];
  const deals = trades
    .map((t) => ({ num: String(t.num || ''), date: t.date, quantity: num(t.quantity), price: money(t.price) }))
    .filter((d) => d.quantity > 0 && d.price > 0);
  if (deals.length) return deals;
  const done = num(item.quantityDone) || (num(item.quantity) - num(item.quantityRest));
  if (done > 0 && money(item.price) > 0) {
    return [{ num: String(item.id || ''), date: item.date, quantity: done, price: money(item.price) }];
  }
  return [];
}

/**
 * Сколько штук в одной единице «количества» операции — по сумме операции.
 * @returns {{factor:number|null, how:string}} factor null — определить не удалось.
 */
export function stockUnitFactor(item, deals, lot) {
  if (!(lot > 0)) return { factor: null, how: 'лотность инструмента неизвестна' };
  if (lot === 1) return { factor: 1, how: 'лот 1' };
  const pay = Math.abs(money(item.payment));
  const sum = deals.reduce((s, d) => s + d.price * d.quantity, 0);
  if (!(pay > 0) || !(sum > 0)) return { factor: null, how: 'в операции нет суммы, единицы количества не проверить' };
  const ratio = pay / sum;
  if (Math.abs(ratio - lot) / lot < 0.03) return { factor: lot, how: 'количество в лотах (сумма = цена × количество × лот)' };
  if (Math.abs(ratio - 1) < 0.03) return { factor: 1, how: 'количество в штуках (сумма = цена × количество)' };
  return { factor: null, how: `сумма операции не сходится ни с лотами, ни со штуками (отношение ${ratio.toFixed(3)})` };
}

// Комиссия операции: поле commission, а если оно пустое — сумма дочерних операций (комиссии вынесены в них).
function operationCommission(item) {
  const own = Math.abs(money(item.commission));
  if (own > 0) return own;
  return (item.childOperations || []).reduce((s, c) => s + Math.abs(money(c.payment)), 0);
}

/**
 * @param {Array} items — операции из GetOperationsByCursor (REST, camelCase)
 * @param {{lotByTicker?: Object<string, number>}} ctx — лотность акций по тикеру (для определения единиц)
 */
export function tbankOperationsToTransactions(items, ctx = {}) {
  const lots = ctx.lotByTicker || {};
  const transactions = [];
  const skipped = [];
  const stats = { operations: items.length, tradeOperations: 0, deals: 0, byKind: { stock: 0, future: 0 } };
  const skip = (item, reason) => skipped.push({ id: item.id || '', type: item.type, ticker: item.ticker || '', date: item.date || '', reason });

  for (const item of items) {
    const side = SIDE[item.type];
    if (!side) continue; // комиссии, дивиденды и пр. — не сделки, молча
    if (item.state && item.state !== 'OPERATION_STATE_EXECUTED') continue;
    stats.tradeOperations += 1;

    const kind = kindOf(item);
    if (!kind) { skip(item, `тип инструмента «${item.instrumentType || item.instrumentKind || '?'}» пока не поддерживается`); continue; }
    const ticker = String(item.ticker || '').toUpperCase();
    if (!ticker) { skip(item, 'у операции нет тикера'); continue; }
    const deals = operationDeals(item);
    if (!deals.length) { skip(item, 'нет исполненного количества или цены'); continue; }

    let factor = 1;
    if (kind === 'stock') {
      const f = stockUnitFactor(item, deals, num(lots[ticker]));
      if (f.factor == null) { skip(item, f.how); continue; }
      factor = f.factor;
    }

    const totalQty = deals.reduce((s, d) => s + d.quantity, 0);
    const commission = operationCommission(item);
    const currency = String(item.payment?.currency || item.price?.currency || 'rub').toUpperCase();
    for (const d of deals) {
      const quantity = d.quantity * factor;
      transactions.push({
        dealNumber: d.num || String(item.id),
        ticker, isin: null, exchange: 'MOEX', side,
        assetName: item.name || ticker,
        price: d.price, quantity, amount: d.price * quantity, currency,
        commission: totalQty > 0 ? commission * (d.quantity / totalQty) : 0,
        timestampUtc: new Date(d.date || item.date),
        isFuture: kind === 'future', instrumentType: kind,
        tradeMode: item.classCode || null, parseMethod: 'tbank-api', needsReview: false,
      });
      stats.deals += 1;
      stats.byKind[kind] += 1;
    }
  }
  transactions.sort((a, b) => a.timestampUtc - b.timestampUtc);
  return { transactions, skipped, stats };
}

/** Все операции-сделки за период: страницы по 1000, пока Т-Банк говорит, что есть следующая. */
export async function fetchTradeOperations(api, { accountId, from, to, onProgress }) {
  const items = [];
  let cursor = '';
  for (let page = 0; page < 100; page += 1) {
    const r = await api.getOperationsPage({ accountId, from, to, cursor, operationTypes: API_TRADE_OPERATION_TYPES });
    items.push(...(r.items || []));
    if (onProgress) onProgress(items.length);
    if (!r.hasNext || !r.nextCursor) break;
    cursor = r.nextCursor;
  }
  return items;
}

/** Лотность акций по тикерам операций (один запрос на тикер). Не нашлась — тикер остаётся без записи. */
export async function resolveStockLots(api, items) {
  const tickers = [...new Set(items.filter((i) => SIDE[i.type] && kindOf(i) === 'stock').map((i) => String(i.ticker || '').toUpperCase()).filter(Boolean))];
  const out = {};
  for (let i = 0; i < tickers.length; i += 5) {
    await Promise.all(tickers.slice(i, i + 5).map(async (t) => {
      try {
        const share = await api.getShareByTicker(t);
        if (share?.lot) out[t] = Number(share.lot);
      } catch { /* лотность не определилась — операции по этому тикеру будут пропущены с причиной */ }
    }));
  }
  return out;
}

/**
 * Полный путь: операции → лотность → транзакции. Результат совместим с результатом разбора отчёта.
 * @returns {Promise<{ok:true, transactions, repoOperations:[], reportPeriod, parseMethod, apiInfo}>}
 */
export async function importFromTbankApi(api, { accountId, from, to, onProgress }) {
  const items = await fetchTradeOperations(api, { accountId, from, to, onProgress });
  const lotByTicker = await resolveStockLots(api, items);
  const { transactions, skipped, stats } = tbankOperationsToTransactions(items, { lotByTicker });
  return {
    ok: true,
    transactions,
    repoOperations: [],
    reportPeriod: { start: new Date(from), end: new Date(to) },
    parseMethod: 'tbank-api',
    flaggedForReview: [],
    unparsedDealNumbers: [],
    apiInfo: { stats, skipped, rawItems: items, lotByTicker },
  };
}

/** Короткий текст-диагностика для вставки в чат при расхождении: без счёта, токена и личных данных. */
export function buildApiDiagnostics(apiInfo, limit = 30) {
  const sample = (apiInfo.rawItems || []).slice(0, limit).map((i) => {
    const { brokerAccountId, cursor, ...rest } = i;
    return rest;
  });
  return JSON.stringify({ stats: apiInfo.stats, skipped: apiInfo.skipped.slice(0, 30), lotByTicker: apiInfo.lotByTicker, sampleOperations: sample }, null, 1);
}
