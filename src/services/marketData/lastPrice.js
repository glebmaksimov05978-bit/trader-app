// src/services/marketData/lastPrice.js
//
// Текущая рыночная цена инструмента — для подстановки в окно закрытия сделки и для живых
// цифр в Сопровождении. Источник по приоритету:
//   1. Т-Банк (GetLastPrices) — настоящая последняя цена, без задержки; нужен токен.
//   2. Мосбиржа, закрытие самой свежей часовой свечи — бесплатно, но с задержкой ~15 минут.
// Ответ всегда говорит, откуда цена и насколько она свежая, чтобы интерфейс не выдавал
// отложенную цену за живую.
import { TinkoffAPI } from '../tinkoff';
import { fetchDailyCandles } from './candles';

export async function fetchMarketPrice({ ticker, instrumentType = 'stock', tinkoffToken }) {
  if (!ticker) return null;

  if (tinkoffToken && (instrumentType === 'stock' || instrumentType === 'future')) {
    try {
      const api = new TinkoffAPI(tinkoffToken);
      const info = await api.getInstrumentByTicker(ticker, instrumentType);
      if (info?.figi) {
        const price = await api.getLastPrice(info.figi);
        if (Number.isFinite(price) && price > 0) {
          return { price, source: 'Т-Банк', delayed: false, at: new Date() };
        }
      }
    } catch { /* падаем на Мосбиржу */ }
  }

  try {
    const candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: 'H1', lookbackDays: 7 });
    const last = candles?.[candles.length - 1];
    if (last && Number.isFinite(last.close)) {
      return { price: last.close, source: 'Мосбиржа', delayed: true, at: new Date() };
    }
  } catch { /* цены нет */ }
  return null;
}
