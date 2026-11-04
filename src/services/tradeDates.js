// src/services/tradeDates.js
//
// Даты открытия/закрытия сделки — без зависимостей (ни Firebase, ни React). Вынесено из trades.js, чтобы расчётные модули
// (движок привычек, отчёты) можно было загружать в фоновых скриптах без пакета firebase. trades.js по-прежнему
// отдаёт эти функции под старыми именами.

// Fallback for trades saved before `openedAt`/`closedAt` existed: treat the
// legacy `date` field as noon MSK (UTC+3) so sorting/analytics stay stable.
export function resolveOpenedAt(trade) {
  if (trade.openedAt) {
    return trade.openedAt.seconds ? new Date(trade.openedAt.seconds * 1000) : new Date(trade.openedAt);
  }
  if (trade.date) {
    const d = trade.date.seconds ? new Date(trade.date.seconds * 1000) : new Date(trade.date);
    if (!trade.date.seconds && /^\d{4}-\d{2}-\d{2}$/.test(trade.date)) {
      return new Date(`${trade.date}T09:00:00Z`); // 12:00 MSK = 09:00 UTC
    }
    return d;
  }
  return null;
}

export function resolveClosedAt(trade) {
  if (trade.closedAt) {
    return trade.closedAt.seconds ? new Date(trade.closedAt.seconds * 1000) : new Date(trade.closedAt);
  }
  if (trade.closeDate) return new Date(trade.closeDate);
  return null;
}
