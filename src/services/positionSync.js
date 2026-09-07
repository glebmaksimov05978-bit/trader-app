// src/services/positionSync.js
//
// Подтягивает из Т-Банка реальную историю операций по открытой сделке журнала и
// превращает её в те же «ступени» (legs), что раньше появлялись только при импорте
// брокерского отчёта. Нужно «Сопровождению»: лесенка фиксаций должна заполняться сама,
// а не вводом руками после каждой частичной продажи.
//
// Сознательные ограничения:
//  • только чтение — GetPortfolio/GetOperations, никаких заявок;
//  • деньги здесь НЕ считаются. P&L и комиссию считает Журнал своей формулой
//    (calcQuickPnl), которая уже умеет шаг цены и стоимость шага для фьючерсов.
//    Вторая формула в проекте гарантированно разъедется с первой — см. договорённость
//    не дублировать расчёты между Калькулятором и кабиной.
import { TinkoffAPI } from './tinkoff';

/**
 * Какой счёт спрашивать. Профиль хранит только токен (id счёта до сих пор нигде не
 * заводился), поэтому: сохранённый id → единственный счёт → внятная ошибка с просьбой
 * выбрать, если счетов несколько. Молча брать первый из нескольких нельзя: операции
 * уедут не с того счёта, а трейдер этого не заметит.
 */
export async function resolveAccountId({ token, profile }) {
  if (profile?.tinkoffAccountId) return profile.tinkoffAccountId;
  const accounts = (await new TinkoffAPI(token).getAccounts())
    .filter((a) => a.status !== 'ACCOUNT_STATUS_CLOSED');
  if (accounts.length === 0) throw new Error('У токена нет доступных счетов');
  if (accounts.length === 1) return accounts[0].id;
  const names = accounts.map((a) => `${a.name || a.id}`).join(', ');
  throw new Error(`Счетов несколько (${names}) — выберите нужный в Настройках`);
}

// Сторона операции, которой сделка ОТКРЫВАЕТСЯ, и та, которой закрывается.
function sidesFor(direction) {
  return direction === 'short'
    ? { open: 'sell', close: 'buy' }
    : { open: 'buy', close: 'sell' };
}

// Операции берём с небольшим запасом до времени открытия сделки: время в журнале
// проставляется руками и может отставать от брокерского на несколько минут.
const LOOKBEHIND_MS = 6 * 60 * 60 * 1000;

/**
 * @param {object} args
 * @param {string} args.token       - токен Т-Банка (достаточно «только чтение»)
 * @param {string} args.accountId   - счёт, по которому смотреть операции
 * @param {object} args.trade       - сделка из журнала (ticker, direction, volume, ...)
 * @param {Date}   [args.openedAt]  - когда сделка открыта (обычно resolveOpenedAt(trade))
 * @returns {Promise<{figi, legs, openedQuantity, closedQuantity, remainingVolume,
 *                    averageEntryPrice, operations}>}
 */
export async function fetchTradeLegs({ token, accountId, trade, openedAt }) {
  if (!token) throw new Error('Не задан токен Т-Банка');
  if (!accountId) throw new Error('Не выбран счёт');
  if (!trade?.ticker) throw new Error('У сделки нет тикера');

  const api = new TinkoffAPI(token);
  const instrument = await api.getInstrumentByTicker(
    trade.ticker,
    trade.instrumentType === 'future' ? 'future' : 'stock',
  );
  if (!instrument?.figi) throw new Error(`Инструмент ${trade.ticker} не найден в Т-Банке`);

  const from = new Date((openedAt ? openedAt.getTime() : Date.now()) - LOOKBEHIND_MS);
  const operations = await api.getOperations(accountId, from, new Date(), instrument.figi);

  const sides = sidesFor(trade.direction);
  const sorted = [...operations].sort((a, b) => new Date(a.date) - new Date(b.date));

  let openedQuantity = 0;
  let closedQuantity = 0;
  let entryCost = 0; // сумма price*qty по операциям открытия — для средней цены входа

  const legs = sorted.map((op) => {
    const isOpen = op.side === sides.open;
    if (isOpen) {
      openedQuantity += op.quantity;
      entryCost += op.price * op.quantity;
    } else {
      closedQuantity += op.quantity;
    }
    return {
      type: isOpen ? 'open' : 'close',
      side: op.side,
      price: op.price,
      quantity: op.quantity,
      commission: 0, // комиссия приходит отдельными операциями; Журнал считает свою
      timestampUtc: op.date,
      dealNumber: op.id ?? null,
      source: 'tinkoff',
    };
  });

  return {
    figi: instrument.figi,
    legs,
    openedQuantity,
    closedQuantity,
    remainingVolume: Math.max(0, openedQuantity - closedQuantity),
    averageEntryPrice: openedQuantity > 0 ? entryCost / openedQuantity : null,
    operations: sorted,
  };
}

/**
 * Текущие открытые позиции счёта — чтобы «Сопровождение» могло показать расхождение
 * между тем, что записано в журнале, и тем, что реально висит у брокера.
 */
export async function fetchOpenPositions({ token, accountId }) {
  if (!token || !accountId) return [];
  const api = new TinkoffAPI(token);
  const positions = await api.getPortfolio(accountId);
  return positions.filter((p) => p && Math.abs(p.quantity) > 0);
}

/**
 * Сверяет одну сделку журнала с портфелем брокера. Ничего не меняет — только сообщает,
 * что разошлось, чтобы решение принимал трейдер, а не автоматика.
 */
export function compareWithPortfolio(trade, positions) {
  const pos = positions.find((p) => p.ticker === trade.ticker);
  const journalRemaining = parseFloat(trade.remainingVolume ?? trade.volume) || 0;
  if (!pos) {
    return journalRemaining > 0
      ? { status: 'missing', message: 'В журнале позиция открыта, у брокера её нет' }
      : { status: 'ok', message: 'Позиция закрыта и там, и там' };
  }
  const brokerQty = Math.abs(pos.quantity);
  if (Math.abs(brokerQty - journalRemaining) < 1e-6) {
    return { status: 'ok', message: 'Совпадает с брокером', brokerQuantity: brokerQty };
  }
  return {
    status: 'mismatch',
    message: `В журнале ${journalRemaining}, у брокера ${brokerQty}`,
    brokerQuantity: brokerQty,
  };
}
