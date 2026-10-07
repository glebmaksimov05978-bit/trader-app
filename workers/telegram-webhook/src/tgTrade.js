// workers/telegram-webhook/src/tgTrade.js
//
// Открытие и закрытие РЕАЛЬНЫХ позиций кнопками в Telegram. Единственная часть бота, которая
// тратит деньги, поэтому устроена максимально строго:
//
//   1. Каждое действие — ДВА нажатия. Первое («Закрыть SBER») ничего не отправляет брокеру: бот
//      заглядывает в настоящую позицию у брокера и показывает, что именно уйдёт (сколько лотов,
//      в какую сторону, на какой счёт). Заявка уходит только после второго нажатия «Да».
//   2. Количество при закрытии берётся ИЗ ПОЗИЦИИ У БРОКЕРА, а не из журнала или снимка: журнал
//      может отставать, а лишний лот перевернул бы позицию вместо закрытия.
//   3. Подтверждение одноразовое и живёт 3 минуты (запись в KV с TTL). Повторное нажатие не
//      создаёт вторую заявку: брокеру уходит один и тот же orderId — ключ идемпотентности.
//   4. Перед отправкой снова проверяются стоп-кран, белый список и потолок суммы (те же проверки,
//      что и у /order), и что позиция не изменилась с момента показа.
//   5. Работает только для чата владельца — того, что записан в снимке `snap:main`.
//
// У воркера нет доступа к базе, поэтому о состоявшейся заявке он оставляет запись `fill:<id>` в KV;
// фоновый робот (scripts/telegram/applyFills.mjs) переносит её в Журнал.
//
// Все внешние действия (запросы к брокеру, хранилище, отправка сообщений) передаются снаружи
// (`deps`) — это позволяет проверять весь поток тестом, без сети и без единой настоящей заявки.
import { checkOrderGates, quotationToFloat } from './orders.js';

const CONFIRM_TTL_SEC = 180;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const dirWord = (d) => (d === 'sell' ? 'продать' : 'купить');

/**
 * Найти позицию по инструменту среди позиций счёта (ответ GetPositions).
 * balance — со знаком: плюс — лонг, минус — шорт. Для акций — штуки, для фьючерсов — контракты.
 */
export function heldBalance(positions, instrument) {
  const lists = [...(positions?.securities || []), ...(positions?.futures || [])];
  const hit = lists.find((p) => (instrument.uid && p.instrumentUid === instrument.uid) || (instrument.figi && p.figi === instrument.figi));
  return hit ? Number(hit.balance) || 0 : 0;
}

/** Из баланса у брокера — что нужно сделать для закрытия: сторона и число ЛОТОВ. */
export function closeIntent(balance, instrument, instrumentType) {
  if (!balance) return null;
  const lotSize = instrumentType === 'future' ? 1 : (Number(instrument.lot) || 1);
  const lots = Math.floor(Math.abs(balance) / lotSize);
  if (lots < 1) return { lots: 0, direction: balance > 0 ? 'sell' : 'buy', remainder: Math.abs(balance) };
  return { lots, direction: balance > 0 ? 'sell' : 'buy', remainder: Math.abs(balance) - lots * lotSize };
}

/** Что нажали: данные кнопки → разбор. Формат: x|c|<id> (закрыть), x|o|<id> (открыть), x|go|<nonce>, x|no|<nonce>. */
export function parseCallback(data) {
  const m = /^x\|(c|o|go|no)\|([\w-]{6,64})$/.exec(String(data || ''));
  return m ? { action: m[1], id: m[2] } : null;
}

export function confirmKeyboard(nonce, yesText) {
  return { inline_keyboard: [[{ text: yesText, callback_data: `x|go|${nonce}` }, { text: '✖ Отмена', callback_data: `x|no|${nonce}` }]] };
}

/**
 * Создаёт подтверждение (шаг 1). Ничего не отправляет брокеру.
 * @param {object} deps { env, tinkoff(method, body), resolveInstrument(ticker, type), listAccounts(), kvPut(key, value, ttl), newId() }
 * @param {object} a { kind: 'close'|'open', ticker, instrumentType, tradeId?, paperId?, direction?, lots?, tradeDirection }
 * @returns {{ text, keyboard } | { text, error: true }}
 */
export async function prepare(deps, a) {
  const { env } = deps;
  const ticker = String(a.ticker || '').toUpperCase();
  const type = a.instrumentType || 'stock';

  const gate = checkOrderGates(env, { ticker, direction: 'buy', lots: 1, orderType: 'market' });
  if (!gate.ok) return { error: true, text: `⛔ ${esc(gate.error)}` };

  let instrument;
  try { instrument = await deps.resolveInstrument(ticker, type); }
  catch (e) { return { error: true, text: `Не удалось найти ${esc(ticker)} у брокера: ${esc(e.message)}` }; }
  if (!instrument) return { error: true, text: `${esc(ticker)} не найден или недоступен для торговли через API.` };

  let accounts;
  try { accounts = await deps.listAccounts(); }
  catch (e) { return { error: true, text: `Нет доступа к счетам брокера: ${esc(e.message)}` }; }
  if (!accounts.length) return { error: true, text: 'У торгового токена нет открытых счетов.' };

  let direction, lots, accountId, accountName, expectedBalance = null, note = '';

  if (a.kind === 'close') {
    // Ищем позицию на счетах. Если она на нескольких — не гадаем: закрывать нужно осознанно.
    const holders = [];
    for (const acc of accounts) {
      let pos;
      try { pos = await deps.tinkoff('OperationsService/GetPositions', { accountId: acc.id }); }
      catch (e) { return { error: true, text: `Не удалось получить позиции счёта «${esc(acc.name)}»: ${esc(e.message)}` }; }
      const bal = heldBalance(pos, instrument);
      if (bal) holders.push({ acc, bal });
    }
    if (!holders.length) return { error: true, text: `По данным брокера позиции по ${esc(ticker)} нет — закрывать нечего.` };
    if (holders.length > 1) return { error: true, text: `${esc(ticker)} открыт сразу на нескольких счетах — закройте в приложении брокера, чтобы не ошибиться счётом.` };
    const { acc, bal } = holders[0];
    const intent = closeIntent(bal, instrument, type);
    if (!intent || intent.lots < 1) return { error: true, text: `У брокера по ${esc(ticker)} меньше одного лота (${Math.abs(bal)} шт.) — закройте в приложении брокера.` };
    direction = intent.direction; lots = intent.lots; accountId = acc.id; accountName = acc.name; expectedBalance = bal;
    if (intent.remainder) note = `\nОстанется ${intent.remainder} шт. (меньше лота).`;
  } else {
    // Открытие по бумажной сделке: объём и сторона — как у неё. Счёт только если он один.
    if (accounts.length > 1) return { error: true, text: 'У токена несколько счетов — открывайте в приложении, там можно выбрать счёт.' };
    direction = a.direction === 'sell' ? 'sell' : 'buy';
    lots = Math.floor(Number(a.lots));
    if (!(lots >= 1)) return { error: true, text: 'Объём бумажной сделки меньше одного лота — открыть нельзя.' };
    accountId = accounts[0].id; accountName = accounts[0].name;
    note = '\n⚠️ Стоп и цель на бирже не выставляются — закрывать придётся вручную или кнопкой здесь.';
  }

  // Оценка суммы — для глаза и для потолка MAX_ORDER_RUB; нет цены — просто без оценки.
  let estimate = null;
  try {
    const lp = await deps.tinkoff('MarketDataService/GetLastPrices', { figi: [instrument.figi] });
    const last = quotationToFloat(lp?.lastPrices?.[0]?.price);
    if (last) estimate = last * lots * (type === 'future' ? 1 : instrument.lot);
  } catch { /* оценка необязательна */ }
  const maxRub = Number(env.MAX_ORDER_RUB) || null;
  if (maxRub && estimate && estimate > maxRub) {
    return { error: true, text: `⛔ Сумма ≈ ${Math.round(estimate).toLocaleString('ru-RU')} ₽ больше разрешённой на сервере (${maxRub.toLocaleString('ru-RU')} ₽).` };
  }

  const nonce = deps.newId();
  await deps.kvPut(`x:${nonce}`, JSON.stringify({
    kind: a.kind, ticker, type, direction, lots, accountId, accountName,
    uid: instrument.uid || null, figi: instrument.figi, lotSize: instrument.lot,
    expectedBalance, tradeId: a.tradeId || null, paperId: a.paperId || null,
    tradeDirection: a.tradeDirection === 'short' ? 'short' : 'long', at: new Date().toISOString(),
  }), CONFIRM_TTL_SEC);

  const head = a.kind === 'close' ? `Закрыть позицию <b>${esc(ticker)}</b>?` : `Открыть реальную позицию по <b>${esc(ticker)}</b>?`;
  const text = `${head}\nЗаявка по рынку: <b>${dirWord(direction)} ${lots} лот.</b>`
    + `${estimate ? ` (≈ ${Math.round(estimate).toLocaleString('ru-RU')} ₽)` : ''}\nСчёт: ${esc(accountName)}${note}\n\n<i>Подтверждение действует 3 минуты.</i>`;
  return { text, keyboard: confirmKeyboard(nonce, a.kind === 'close' ? '✅ Да, закрыть' : '✅ Да, открыть'), nonce };
}

/**
 * Исполняет подтверждённое действие (шаг 2). Подтверждение одноразовое.
 * @param {object} deps то же + kvGet(key), kvDelete(key)
 * @returns {{ text }}
 */
export async function execute(deps, nonce) {
  const { env } = deps;
  const raw = await deps.kvGet(`x:${nonce}`);
  if (!raw) return { text: 'Подтверждение устарело или уже использовано. Нажмите кнопку в меню заново.' };
  await deps.kvDelete(`x:${nonce}`);
  const p = JSON.parse(raw);

  // Повторные проверки: к моменту «Да» могло пройти до 3 минут, а стоп-кран мог быть включён.
  const gate = checkOrderGates(env, { ticker: p.ticker, direction: p.direction, lots: p.lots, orderType: 'market' });
  if (!gate.ok) return { text: `⛔ ${esc(gate.error)}` };

  if (p.kind === 'close') {
    // Позиция должна остаться той же, что мы показали, — иначе количество уже не то.
    let pos;
    try { pos = await deps.tinkoff('OperationsService/GetPositions', { accountId: p.accountId }); }
    catch (e) { return { text: `Не удалось перепроверить позицию: ${esc(e.message)}. Заявка НЕ отправлена.` }; }
    const now = heldBalance(pos, { uid: p.uid, figi: p.figi });
    if (now !== p.expectedBalance) return { text: `Позиция по ${esc(p.ticker)} изменилась (было ${p.expectedBalance}, стало ${now}). Заявка НЕ отправлена — нажмите «Закрыть» заново.` };
  }

  let res;
  try {
    // orderId = nonce: если «Да» нажали дважды, брокер получит ту же заявку, а не вторую.
    res = await deps.tinkoff('OrdersService/PostOrder', {
      accountId: p.accountId,
      instrumentId: p.uid || p.figi,
      quantity: String(p.lots),
      direction: p.direction === 'sell' ? 'ORDER_DIRECTION_SELL' : 'ORDER_DIRECTION_BUY',
      orderType: 'ORDER_TYPE_MARKET',
      orderId: nonce,
    });
  } catch (e) {
    return { text: `⛔ Брокер отклонил заявку: ${esc(e.message)}\nЕсли биржа сейчас закрыта, заявка в очередь не встаёт — повторите, когда торги идут.` };
  }

  const lotsExecuted = res?.lotsExecuted != null ? Number(res.lotsExecuted) : 0;
  // Цена исполнения: средняя цена позиции из состояния заявки; нет — последняя цена с пометкой «ориентир».
  let price = null, approx = false;
  if (lotsExecuted > 0) {
    try {
      const st = await deps.tinkoff('OrdersService/GetOrderState', { accountId: p.accountId, orderId: res?.orderId || nonce });
      price = quotationToFloat(st?.averagePositionPrice) || null;
    } catch { /* ниже запасной путь */ }
    if (!price) {
      try {
        const lp = await deps.tinkoff('MarketDataService/GetLastPrices', { figi: [p.figi] });
        price = quotationToFloat(lp?.lastPrices?.[0]?.price) || null; approx = true;
      } catch { /* цены нет */ }
    }
  }

  if (lotsExecuted > 0 && price) {
    await deps.kvPut(`fill:${nonce}`, JSON.stringify({
      kind: p.kind, ticker: p.ticker, type: p.type, direction: p.direction, tradeDirection: p.tradeDirection,
      lots: lotsExecuted, price, priceApprox: approx || undefined, orderId: res?.orderId || nonce,
      accountId: p.accountId, lotSize: p.lotSize, tradeId: p.tradeId, paperId: p.paperId, at: new Date().toISOString(),
    }), 7 * 86400);
  }

  const status = res?.executionReportStatus || '';
  const done = lotsExecuted > 0
    ? `Исполнено ${lotsExecuted} из ${p.lots} лот.${price ? ` по ${price}${approx ? ' (ориентир — сверьте цену в приложении брокера)' : ''}` : ''}`
    : `Заявка принята (статус: ${esc(status) || '—'}), исполнение ещё не подтверждено.`;
  const journal = lotsExecuted > 0 && price
    ? '\n📝 В Журнал запишется при ближайшей проверке робота (до 15 минут).'
    : '\n⚠️ Цену исполнения брокер не вернул — внесите сделку в Журнал вручную или нажмите «Синхронизировать» у сделки.';
  return { text: `✅ ${p.kind === 'close' ? 'Закрытие' : 'Открытие'} ${esc(p.ticker)}: ${dirWord(p.direction)} ${p.lots} лот.\n${done}${journal}` };
}

export async function cancel(deps, nonce) {
  await deps.kvDelete(`x:${nonce}`);
  return { text: 'Отменено. Заявка не отправлялась.' };
}
