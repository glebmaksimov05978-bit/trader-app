// src/services/tradeClose.js
//
// Закрытие/частичная фиксация сделки — вынесено из Журнала в отдельный сервис, чтобы
// этим же кодом мог пользоваться и Журнал (ручное закрытие), и Сопровождение (закрытие
// настоящей заявкой брокеру через OrderModal). Раньше вся эта логика жила внутри
// Journal.js как обработчик кнопки — с добавлением второго места, которое умеет
// закрывать сделку, дублировать её означало бы рано или поздно рассинхронизировать
// расчёт P&L между двумя формами закрытия.
import { updateTrade, resolveOpenedAt } from './trades';
import { computeTradePostmortem } from './tradePostmortem';
import { getStrategies, getActiveStrategy } from './analytics/strategy';
import { commissionRateFor, DEFAULT_TARIFF } from './analytics/commission';

/**
 * P&L и комиссия закрываемого куска — та же формула, что и раньше в Journal.js
 * calcQuickPnl, только без привязки к состоянию формы.
 */
export function computeClosePnl({ trade, exitPrice, qty, commRate }) {
  const entry = parseFloat(trade?.entryPrice);
  const vol = qty || 1;
  const lot = parseFloat(trade?.lot) || 1;
  const step = parseFloat(trade?.minStep) || 1;
  const stepAmt = parseFloat(trade?.minStepAmount) || 0;
  const rate = commRate ?? commissionRateFor(trade?.__tariff || DEFAULT_TARIFF, trade?.instrumentType || 'stock').rate;
  const dir = trade?.direction;

  if (!exitPrice || !entry) return null;

  let pnl;
  if (step && stepAmt) {
    const ticks = (exitPrice - entry) / step;
    pnl = (dir === 'long' ? ticks : -ticks) * stepAmt * vol * lot;
  } else {
    pnl = (dir === 'long' ? (exitPrice - entry) : (entry - exitPrice)) * vol * lot;
  }

  const commission = entry * vol * lot * rate * 2;
  const net = pnl - commission;
  return { pnl: Math.round(net * 100) / 100, commission: Math.round(commission * 100) / 100 };
}

/**
 * Закрывает часть или всю сделку: пишет патч в Firestore, добавляет ступень в историю
 * (legs), запускает разбор (постмортем) при полном закрытии. Используется и ручным
 * закрытием в Журнале, и закрытием настоящей заявкой из Сопровождения — единственная
 * разница между ними в том, ОТКУДА взялись exitPrice/qty (введены руками или пришли
 * от брокера как реально исполненные).
 *
 * @param {object}   a
 * @param {object}   a.trade         - текущая запись сделки (с id)
 * @param {number}   a.exitPrice
 * @param {number}   a.qty           - сколько контрактов/акций закрывается сейчас
 * @param {Date}    [a.closedAtDate] - момент закрытия, по умолчанию — сейчас
 * @param {number}  [a.commRate]     - ставка комиссии за сторону; не задана — берётся из тарифа
 * @param {object}  [a.userProfile]  - нужен для тарифа комиссии и стратегии постмортема
 * @param {string}  [a.source]       - 'manual' | 'order' — как получена цена (для истории)
 * @returns {Promise<{ patch: object, partial: boolean, remaining: number, pnl: number, commission: number }>}
 */
export async function applyTradeClose({
  trade, exitPrice, qty, closedAtDate = new Date(), commRate = null, userProfile = null, source = 'manual',
}) {
  const rate = commRate ?? commissionRateFor(
    userProfile?.brokerTariff || DEFAULT_TARIFF, trade.instrumentType || 'stock',
  ).rate;
  const result = computeClosePnl({ trade, exitPrice, qty, commRate: rate });
  if (!result) throw new Error('Не удалось посчитать P&L закрытия — проверьте цену входа и объём сделки');

  const remaining = parseFloat(trade.remainingVolume ?? trade.volume) || 0;
  const partial = qty < remaining - 1e-9;

  const patch = {
    exitPrice,
    status: partial ? 'partial' : 'closed',
    remainingVolume: partial ? remaining - qty : 0,
    // Прибавляем к тому, что сделка уже накопила от прошлых частичных фиксаций, а не
    // перезаписываем — так же, как всегда делал ручной путь в Журнале.
    pnl: (trade.pnl ?? 0) + result.pnl,
    commission: (trade.commission ?? 0) + result.commission,
  };
  if (partial) {
    delete patch.closeDate;
    delete patch.closedAt;
  } else {
    patch.closeDate = closedAtDate.toISOString();
    patch.closedAt = closedAtDate.toISOString();
  }

  const legs = Array.isArray(trade.legs) ? [...trade.legs] : [{
    type: 'open',
    side: trade.direction === 'long' ? 'buy' : 'sell',
    price: parseFloat(trade.entryPrice) || null,
    quantity: parseFloat(trade.volume) || null,
    commission: 0,
    timestampUtc: (resolveOpenedAt(trade) || closedAtDate).toISOString(),
    dealNumber: null,
  }];
  patch.legs = [...legs, {
    type: 'close',
    side: trade.direction === 'long' ? 'sell' : 'buy',
    price: exitPrice,
    quantity: qty,
    commission: result.commission,
    timestampUtc: closedAtDate.toISOString(),
    dealNumber: null,
    source, // 'order' — реально исполненная заявка брокера, 'manual' — введено руками
  }];

  await updateTrade(trade.id, patch);

  // Разбор закрытой сделки — тем же кодом и в том же месте, что и при ручном закрытии:
  // считается один раз, кладётся в саму сделку, детекторы читают готовые числа.
  if (!partial) {
    const strategyForTrade = getStrategies(userProfile)
      .find((s) => s.id === trade.entryStrategyId) || getActiveStrategy(userProfile);
    try {
      const postmortem = await computeTradePostmortem({
        trade: { ...trade, ...patch },
        openedAt: resolveOpenedAt(trade),
        closedAt: closedAtDate,
        exitRules: strategyForTrade?.exitRules,
        tinkoffToken: userProfile?.tinkoffToken,
      });
      if (postmortem) await updateTrade(trade.id, postmortem);
    } catch { /* разбор необязателен — сделка уже закрыта корректно */ }
  }

  return { patch, partial, remaining: partial ? remaining - qty : 0, pnl: result.pnl, commission: result.commission };
}
