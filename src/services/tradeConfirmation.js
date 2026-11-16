// src/services/tradeConfirmation.js
//
// Откуда известно, что сделка действительно была: «подтверждена брокером» или «записана вручную».
// Метка показывается только тем, у кого подключён Т-Банк: остальные могут торговать у другого брокера, и навязывать им
// сверку с Т-Банком незачем (решение владельца, 2026-11-16).
//
// Подтверждённой считается сделка, у которой и вход, и все выходы пришли от брокера:
//   • загружена из отчёта или прямо из Т-Банка (dataSource imported / hybrid, есть номера сделок брокера);
//   • открыта заявкой из приложения, а закрытия — тоже заявками или операциями брокера;
//   • подтянута кнопкой «Из Т-Банка» (ноги с source 'tinkoff');
//   • результат сверен с вариационной маржой (brokerVmChecked).
// Чистая функция.

const BROKER_LEG = new Set(['order', 'tinkoff', 'paper-repeat']);

export function tradeConfirmation(trade) {
  if (!trade || trade.status === 'pending' || trade.status === 'cancelled') return null;
  if (trade.brokerVmChecked) return { level: 'broker', text: 'Подтверждена брокером', detail: 'Результат сверен с вариационной маржой Т-Банка' };
  const imported = trade.dataSource === 'imported' || trade.dataSource === 'hybrid'
    || (Array.isArray(trade.sourceTransactionIds) && trade.sourceTransactionIds.length > 0);
  if (imported) return { level: 'broker', text: 'Подтверждена брокером', detail: 'Сделка загружена из отчёта или из Т-Банка' };

  const legs = Array.isArray(trade.legs) ? trade.legs : [];
  const legOk = (l) => BROKER_LEG.has(l?.source) || !!l?.dealNumber;
  const opens = legs.filter((l) => l?.type === 'open');
  const closes = legs.filter((l) => l?.type === 'close');
  const openOk = !!trade.orderId || (opens.length > 0 && opens.every(legOk));
  const closesOk = closes.every(legOk);
  // Закрыта, а ног закрытия нет — значит, закрытие записано руками старым способом.
  const closedWithoutLegs = (trade.status === 'closed' || trade.status === 'partial') && closes.length === 0;
  if (openOk && closesOk && !closedWithoutLegs) return { level: 'broker', text: 'Подтверждена брокером', detail: 'Вход и выходы исполнены заявками через Т-Банк' };
  if (openOk) return { level: 'manual', text: 'Вручную', detail: 'Вход — заявкой через Т-Банк, а закрытие записано вручную' };
  return { level: 'manual', text: 'Вручную', detail: 'Сделка записана вручную, у брокера не проверялась' };
}

export const isBrokerConfirmed = (trade) => tradeConfirmation(trade)?.level === 'broker';
