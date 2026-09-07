// src/services/tinkoff.js
const BASE_URL = 'https://invest-public-api.tinkoff.ru/rest';

export class TinkoffAPI {
  constructor(token) {
    this.token = token;
  }

  async request(endpoint, body = {}) {
    const response = await fetch(`${BASE_URL}${endpoint}`, {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${this.token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
    if (!response.ok) {
      const err = await response.json().catch(() => ({}));
      throw new Error(err.message || `API error ${response.status}`);
    }
    return response.json();
  }

  // Фьючерс по тикеру. Большинство FORTS-контрактов торгуются под classCode 'SPBFUT',
  // но не все — например, товарные фьючерсы (Brent и др.) у части аккаунтов резолвятся
  // только через общий поиск, а не прямой FutureBy с этим classCode (real user report:
  // "через API Тинькофф не могу ввести фьючерс на Brent, хотя через MOEX могу"). Тот же
  // паттерн, что уже используется в getShareByTicker — прямой метод, затем FindInstrument.
  async getFutureByTicker(ticker) {
    try {
      const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy', {
        idType: 'INSTRUMENT_ID_TYPE_TICKER',
        classCode: 'SPBFUT',
        id: ticker,
      });
      if (data.instrument) return data.instrument;
    } catch {
      // Falls through to FindInstrument below.
    }

    try {
      const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
        query: ticker.toUpperCase(),
        instrumentKind: 'INSTRUMENT_TYPE_FUTURES',
        apiTradeAvailableFlag: true,
      });
      const instruments = data.instruments || [];
      const exact = instruments.find(i => i.ticker?.toUpperCase() === ticker.toUpperCase());
      const match = exact || instruments[0];
      if (!match) return null;
      const full = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy', {
        idType: 'INSTRUMENT_ID_TYPE_FIGI',
        id: match.figi,
      });
      return full.instrument || match;
    } catch {
      return null;
    }
  }

  // Акция по тикеру — ищем через FindInstrument
  async getShareByTicker(ticker) {
    try {
      // Сначала пробуем прямой метод ShareBy
      const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/ShareBy', {
        idType: 'INSTRUMENT_ID_TYPE_TICKER',
        classCode: 'TQBR', // основная секция MOEX акций
        id: ticker.toUpperCase(),
      });
      if (data.instrument) return data.instrument;
    } catch {
      // Если не нашли — ищем через общий поиск
    }

    try {
      const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
        query: ticker.toUpperCase(),
        instrumentKind: 'INSTRUMENT_TYPE_SHARE',
        apiTradeAvailableFlag: true,
      });
      const instruments = data.instruments || [];
      // Ищем точное совпадение по тикеру на MOEX
      const exact = instruments.find(i =>
        i.ticker?.toUpperCase() === ticker.toUpperCase() &&
        (i.classCode === 'TQBR' || i.exchange === 'MOEX' || i.exchange === 'MOEX_PLUS')
      );
      if (exact) {
        // Получаем полную информацию
        const full = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/ShareBy', {
          idType: 'INSTRUMENT_ID_TYPE_FIGI',
          classCode: exact.classCode || 'TQBR',
          id: exact.figi,
        });
        return full.instrument || exact;
      }
      return instruments[0] || null;
    } catch {
      return null;
    }
  }

  // Универсальный поиск — пробует фьючерс, потом акцию
  async getInstrumentByTicker(ticker, type = 'future') {
    if (type === 'future') {
      return this.getFutureByTicker(ticker);
    } else {
      return this.getShareByTicker(ticker);
    }
  }

  async getLastPrice(figi) {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices', {
      figi: [figi],
    });
    const lp = data.lastPrices?.[0];
    if (!lp) return null;
    return moneyToFloat(lp.price);
  }

  async getAccounts() {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts', {});
    return data.accounts || [];
  }

  // --- Позиции и сделки счёта -----------------------------------------------------------
  //
  // Нужны «Сопровождению»: панель ведения открытой позиции должна знать, что реально
  // открыто и по каким ценам трейдер фиксировал часть — иначе «лесенку фиксаций» пришлось
  // бы заполнять руками. Оба метода только читают: права на выставление заявок токену НЕ
  // нужны, и намеренно не используются нигде в приложении.

  // Текущий портфель: что открыто, сколько штук, по какой средней цене.
  async getPortfolio(accountId) {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio', {
      accountId,
    });
    return (data.positions || []).map(parsePortfolioPosition);
  }

  // Исполненные операции за период. `figi` не обязателен — без него приходят все
  // инструменты, что и нужно, когда сопоставляем сразу несколько открытых сделок.
  // Пагинация у GetOperations отсутствует, ответ ограничен периодом — поэтому запрашиваем
  // окно от даты открытия сделки, а не «всю историю».
  async getOperations(accountId, from, to, figi = null) {
    const body = {
      accountId,
      from: (from instanceof Date ? from : new Date(from)).toISOString(),
      to: (to instanceof Date ? to : new Date(to ?? Date.now())).toISOString(),
      state: 'OPERATION_STATE_EXECUTED',
    };
    if (figi) body.figi = figi;
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.OperationsService/GetOperations', body);
    return (data.operations || []).map(parseOperation).filter((op) => op.isTrade);
  }
}

// Позиция портфеля в понятном приложению виде. Количество у Tinkoff приходит как
// Quotation (units/nano), а не числом, — та же ловушка, что с деньгами.
export function parsePortfolioPosition(p) {
  if (!p) return null;
  const quantity = moneyToFloat(p.quantity);
  return {
    figi: p.figi,
    ticker: p.ticker ?? null,
    instrumentType: p.instrumentType ?? null,
    quantity,
    direction: quantity < 0 ? 'short' : 'long',
    averagePrice: moneyToFloat(p.averagePositionPrice),
    currentPrice: moneyToFloat(p.currentPrice),
    expectedYield: moneyToFloat(p.expectedYield),
  };
}

// Операция по счёту. Нас интересуют только сделки купли-продажи: комиссии, налоги и
// пополнения приходят тем же списком и к «лесенке» отношения не имеют.
const TRADE_OPERATION_TYPES = new Set([
  'OPERATION_TYPE_BUY',
  'OPERATION_TYPE_SELL',
  'OPERATION_TYPE_BUY_CARD',
  'OPERATION_TYPE_BUY_MARGIN',
  'OPERATION_TYPE_SELL_MARGIN',
]);

export function parseOperation(op) {
  if (!op) return null;
  const type = op.operationType;
  const isSell = type === 'OPERATION_TYPE_SELL' || type === 'OPERATION_TYPE_SELL_MARGIN';
  return {
    id: op.id,
    figi: op.figi,
    date: op.date,
    isTrade: TRADE_OPERATION_TYPES.has(type),
    side: isSell ? 'sell' : 'buy',
    // `quantity` — сколько лотов запрошено, `quantityRest` — сколько НЕ исполнилось.
    // Реально исполненный объём — разница, иначе частично исполненная заявка запишется
    // в историю целиком и остаток позиции разъедется с брокерским.
    quantity: (parseInt(op.quantity || 0, 10) - parseInt(op.quantityRest || 0, 10)) || parseInt(op.quantity || 0, 10),
    price: moneyToFloat(op.price),
    payment: moneyToFloat(op.payment),
    currency: op.currency,
    operationType: type,
  };
}

// Helper: Tinkoff MoneyValue to float
export function moneyToFloat(mv) {
  if (!mv) return 0;
  const units = parseInt(mv.units || 0);
  const nano = parseInt(mv.nano || 0);
  return units + nano / 1e9;
}

// Parse futures contract info
export function parseFutureInfo(instrument) {
  if (!instrument) return null;
  const minStep   = moneyToFloat(instrument.minPriceIncrement);
  const stepAmount = moneyToFloat(instrument.minPriceIncrementAmount);
  const lot       = instrument.lot || 1;
  const marginBuy  = moneyToFloat(instrument.initialMarginOnBuy);
  const marginSell = moneyToFloat(instrument.initialMarginOnSell);
  const margin    = Math.min(marginBuy || marginSell, marginSell || marginBuy) || marginBuy || marginSell;

  return {
    ticker: instrument.ticker,
    name: instrument.name,
    figi: instrument.figi,
    lot,
    minPriceIncrement: minStep,
    minPriceIncrementAmount: stepAmount,
    initialMarginOnBuy: marginBuy,
    initialMarginOnSell: marginSell,
    initialMargin: margin,
    currency: instrument.currency,
    expirationDate: instrument.expirationDate,
    basicAsset: instrument.basicAsset,
  };
}

// Parse share (акция) info
export function parseShareInfo(instrument) {
  if (!instrument) return null;
  const lot = instrument.lot || 1;
  // Для акций минимальный шаг цены
  const minStep = moneyToFloat(instrument.minPriceIncrement) || 0.01;

  return {
    ticker: instrument.ticker,
    name: instrument.name,
    figi: instrument.figi,
    lot,
    minPriceIncrement: minStep,
    minPriceIncrementAmount: 0, // для акций не нужно
    initialMargin: 0,           // ГО нет
    currency: instrument.currency,
    isin: instrument.isin,
    sector: instrument.sector,
    isShare: true,
  };
}
