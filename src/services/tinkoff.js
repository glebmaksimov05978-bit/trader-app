// src/services/tinkoff.js
// Tinkoff Invest API v2 (REST sandbox/prod)
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

  // Search instruments by ticker or name
  async findInstrument(query) {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
      query,
      instrumentKind: 'INSTRUMENT_TYPE_FUTURES',
      apiTradeAvailableFlag: true,
    });
    return data.instruments || [];
  }

  // Get futures by ticker
  async getFutureByTicker(ticker) {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy', {
      idType: 'INSTRUMENT_ID_TYPE_TICKER',
      classCode: 'SPBFUT',
      id: ticker,
    });
    return data.instrument || null;
  }

  // Get last price for instrument
  async getLastPrice(figi) {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.MarketDataService/GetLastPrices', {
      figi: [figi],
    });
    const lp = data.lastPrices?.[0];
    if (!lp) return null;
    return moneyToFloat(lp.price);
  }

  // Get orderbook for spread estimation
  async getOrderBook(figi, depth = 5) {
    return this.request('/tinkoff.public.invest.api.contract.v1.MarketDataService/GetOrderBook', {
      figi,
      depth,
    });
  }

  // Get accounts (for import)
  async getAccounts() {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.UsersService/GetAccounts', {});
    return data.accounts || [];
  }

  // Get operations (for trade import)
  async getOperations(accountId, from, to) {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.OperationsService/GetOperations', {
      accountId,
      from,
      to,
      state: 'OPERATION_STATE_EXECUTED',
    });
    return data.operations || [];
  }

  // Get portfolio
  async getPortfolio(accountId) {
    return this.request('/tinkoff.public.invest.api.contract.v1.OperationsService/GetPortfolio', {
      accountId,
    });
  }
}

// Helper: Tinkoff MoneyValue to float
export function moneyToFloat(mv) {
  if (!mv) return 0;
  return (mv.units || 0) + (mv.nano || 0) / 1e9;
}

// Parse futures contract info
export function parseFutureInfo(instrument) {
  if (!instrument) return null;
  return {
    ticker: instrument.ticker,
    name: instrument.name,
    figi: instrument.figi,
    lot: instrument.lot || 1,
    minPriceIncrement: moneyToFloat(instrument.minPriceIncrement),
    initialMarginOnBuy: moneyToFloat(instrument.initialMarginOnBuy),
    initialMarginOnSell: moneyToFloat(instrument.initialMarginOnSell),
    minPriceIncrementAmount: moneyToFloat(instrument.minPriceIncrementAmount),
    currency: instrument.currency,
    expirationDate: instrument.expirationDate,
    basicAsset: instrument.basicAsset,
    basicAssetSize: moneyToFloat(instrument.basicAssetSize),
  };
}
