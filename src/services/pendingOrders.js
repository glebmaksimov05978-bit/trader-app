import { positionValueRub } from './contractMath.js';
// src/services/pendingOrders.js
//
// Заявки, которые брокер принял, но не исполнил сразу (лимитная, ждущая цены, или рыночная вне
// сессии). Раньше приложение о такой заявке забывало: в Журнале её не было вовсе, и сделку нужно
// было заводить руками после исполнения. Теперь:
//   • при отправке такая заявка записывается в Журнал со статусом «pending» («ждёт исполнения»)
//     и номером заявки;
//   • при каждом открытии Журнала/Сопровождения статус заявки спрашивается у брокера, и запись
//     превращается в обычную открытую сделку (исполнена), либо помечается «не исполнена»
//     (снята/отклонена).
// Закрывающие заявки работают так же: на сделке лежит pendingClose, и по исполнению сделка
// закрывается тем же расчётом, что и при мгновенном исполнении.
//
// planPendingUpdate и planPendingClose — чистые решения (тест test:pending); сеть и запись в
// базу — в reconcilePendingTrades.

const FILL = 'EXECUTION_REPORT_STATUS_FILL';
const PARTIAL = 'EXECUTION_REPORT_STATUS_PARTIALLYFILL';
const CANCELLED = 'EXECUTION_REPORT_STATUS_CANCELLED';
const REJECTED = 'EXECUTION_REPORT_STATUS_REJECTED';

const isFinal = (s) => s === FILL || s === CANCELLED || s === REJECTED;

/**
 * Что сделать с записью «ждёт исполнения» по ответу брокера.
 * @returns {null | { patch: object, note: string }} null — ничего не менять (всё ещё ждёт)
 */
export function planPendingUpdate(trade, state, now = new Date()) {
  if (!state || !trade) return null;
  const status = state.status;
  const executed = Number(state.lotsExecuted) || 0;
  const po = trade.pendingOrder || {};

  if (status === PARTIAL || (!isFinal(status) && executed > 0)) {
    if (executed === (po.filledLots || 0)) return null;
    return { patch: { pendingOrder: { ...po, filledLots: executed } }, note: `исполнено частично: ${executed}` };
  }
  if (status === FILL || (isFinal(status) && executed > 0)) {
    const price = Number(state.averagePrice) || Number(trade.entryPrice) || null;
    const vol = executed || Number(trade.volume) || 0;
    const lot = parseFloat(trade.lot) || 1;
    const rate = parseFloat(trade.commissionRate) || 0.0005;
    const at = now.toISOString();
    return {
      patch: {
        status: 'open',
        entryPrice: price,
        volume: vol,
        remainingVolume: vol,
        openedAt: at,
        date: at.split('T')[0],
        commission: price ? Math.round(positionValueRub({ ...trade, lot }, price, vol) * rate * 2) : trade.commission ?? null,
        pendingOrder: { ...po, filledLots: vol, filledAt: at },
        legs: [{
          type: 'open', side: trade.direction === 'short' ? 'sell' : 'buy', price, quantity: vol, commission: 0,
          timestampUtc: at, dealNumber: po.orderId || trade.orderId || null, source: 'order',
        }],
      },
      note: `исполнена: ${vol} по ${price}`,
    };
  }
  if (status === CANCELLED || status === REJECTED) {
    return { patch: { status: 'cancelled', pendingOrder: { ...po, endedAt: now.toISOString(), endStatus: status } }, note: 'заявка снята или отклонена брокером' };
  }
  return null; // NEW — всё ещё ждёт
}

/**
 * То же для закрывающей заявки (trade.pendingClose). Возвращает { qty, price } для закрытия
 * либо { clear: true } (заявка снята — убрать отметку), либо null (ещё ждёт).
 */
export function planPendingClose(trade, state) {
  if (!state || !trade?.pendingClose) return null;
  const executed = Number(state.lotsExecuted) || 0;
  const status = state.status;
  if ((status === FILL || (isFinal(status) && executed > 0)) && executed > 0) {
    const already = Number(trade.pendingClose.appliedLots) || 0;
    const qty = executed - already;
    if (qty <= 0) return { clear: true };
    return { qty, price: Number(state.averagePrice) || null, clear: true };
  }
  if (status === CANCELLED || status === REJECTED) return { clear: true };
  return null;
}

/**
 * Обходит записи «ждёт исполнения» и ставит им актуальный статус.
 * @param {object} a
 * @param {Array}  a.trades — все сделки пользователя
 * @param {(order: {orderId, accountId}) => Promise<object|null>} a.fetchState — запрос состояния у брокера
 * @param {(id: string, patch: object) => Promise<void>} a.updateTrade
 * @param {(a: object) => Promise<object>} a.applyClose — applyTradeClose
 * @param {object} a.userProfile
 * @returns {Promise<{ changed: number, notes: string[] }>}
 */
export async function reconcilePendingTrades({ trades, fetchState, updateTrade, applyClose, userProfile }) {
  const notes = [];
  let changed = 0;
  for (const t of trades || []) {
    try {
      if (t.status === 'pending' && (t.pendingOrder?.orderId || t.orderId)) {
        const orderId = t.pendingOrder?.orderId || t.orderId;
        const accountId = t.pendingOrder?.accountId || t.orderAccountId;
        const state = await fetchState({ orderId, accountId });
        const plan = planPendingUpdate(t, state);
        if (plan) { await updateTrade(t.id, plan.patch); changed += 1; notes.push(`${t.ticker}: ${plan.note}`); }
      } else if (t.pendingClose?.orderId && (t.status === 'open' || t.status === 'partial')) {
        const state = await fetchState({ orderId: t.pendingClose.orderId, accountId: t.pendingClose.accountId });
        const plan = planPendingClose(t, state);
        if (plan) {
          if (plan.qty && plan.price) {
            await applyClose({ trade: t, exitPrice: plan.price, qty: plan.qty, closedAtDate: new Date(), userProfile, source: 'order' });
            notes.push(`${t.ticker}: закрытие исполнено, ${plan.qty} по ${plan.price}`);
          }
          await updateTrade(t.id, { pendingClose: null });
          changed += 1;
        }
      }
    } catch (e) {
      // Один сбой (сеть, заявка не найдена) не должен мешать остальным записям.
      notes.push(`${t.ticker || t.id}: не удалось проверить заявку (${e.message})`);
    }
  }
  return { changed, notes };
}
