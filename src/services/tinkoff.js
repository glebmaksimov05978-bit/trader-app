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

  async getFutureByTicker(ticker) {
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FutureBy', {
      idType: 'INSTRUMENT_ID_TYPE_TICKER',
      classCode: 'SPBFUT',
      id: ticker,
    });
    return data.instrument || null;
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
}

// Helper: Tinkoff MoneyValue to float
export function moneyToFloat(mv) {
  if (!mv) return 0;
  const units = parseInt(mv.units || 0);
  const nano = parseInt(mv.nano || 0);
  return units + nano / 1e9;
}

// Parse futures contract info — FIXED
export function parseFutureInfo(instrument) {
  if (!instrument) return null;

  // minPriceIncrement — шаг цены (например 0.01, 0.5, 10)
  const minStep = moneyToFloat(instrument.minPriceIncrement);

  // minPriceIncrementAmount — стоимость одного шага в рублях
  const stepAmount = moneyToFloat(instrument.minPriceIncrementAmount);

  // lot — лотность (количество единиц базового актива в 1 контракте)
  const lot = instrument.lot || 1;

  // ГО — берём меньшее из buy/sell (реальное ГО)
  const marginBuy = moneyToFloat(instrument.initialMarginOnBuy);
  const marginSell = moneyToFloat(instrument.initialMarginOnSell);
  const margin = Math.min(marginBuy || marginSell, marginSell || marginBuy) || marginBuy || marginSell;

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
