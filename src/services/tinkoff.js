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

  // ГО фьючерса у Т-Банка есть не во всех ответах FutureBy (и не всегда актуально) — отдельный метод
  // GetFuturesMargin отдаёт именно ГО на покупку и продажу. Дополняем инструмент, только если ГО в нём
  // нет совсем; при любой ошибке возвращаем инструмент как есть (ГО тогда можно ввести руками).
  async withFuturesMargin(instrument) {
    if (!instrument) return instrument;
    if (moneyToFloat(instrument.initialMarginOnBuy) > 0 || moneyToFloat(instrument.initialMarginOnSell) > 0) return instrument;
    try {
      const m = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/GetFuturesMargin', {
        instrumentId: instrument.uid || instrument.figi,
      });
      return {
        ...instrument,
        initialMarginOnBuy: m.initialMarginOnBuy ?? instrument.initialMarginOnBuy,
        initialMarginOnSell: m.initialMarginOnSell ?? instrument.initialMarginOnSell,
        minPriceIncrementAmount: instrument.minPriceIncrementAmount ?? m.minPriceIncrementAmount,
      };
    } catch {
      return instrument;
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

  // Свободный поиск инструментов для каталога: не «найди мне ровно этот тикер», а
  // «покажи, что вообще есть по такому запросу». Ищет и по тикеру, и по названию —
  // трейдер, который помнит «Северсталь», но не помнит CHMF, найдёт бумагу.
  //
  // apiTradeAvailableFlag НЕ ставим: следить можно и за тем, чем через API не торгуют
  // (мини-контракты, часть бумаг), — радар только смотрит на график.
  async findInstruments(query, limit = 30) {
    try {
      const data = await this.request('/tinkoff.public.invest.api.contract.v1.InstrumentsService/FindInstrument', {
        query,
      });
      const list = data.instruments || [];
      // Только MOEX: приложение считает свечи по московским площадкам, инструмент с
      // другой биржи в радаре превратится в строку с ошибкой.
      return list
        .filter((i) => !i.exchange || /MOEX|SPB|FORTS/i.test(i.exchange))
        .slice(0, limit);
    } catch {
      return [];
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

  // Страница истории операций по счёту (для автоимпорта сделок): курсорная выгрузка, до 1000 операций за раз.
  // Только чтение. Возвращает { items, hasNext, nextCursor }. Список типов сужает выдачу до сделок.
  async getOperationsPage({ accountId, from, to, cursor = '', operationTypes = [], limit = 1000 }) {
    const body = {
      accountId,
      from: (from instanceof Date ? from : new Date(from)).toISOString(),
      to: (to instanceof Date ? to : new Date(to ?? Date.now())).toISOString(),
      limit,
      state: 'OPERATION_STATE_EXECUTED',
      withoutCommissions: false,
      withoutTrades: false,
      withoutOvernights: true,
    };
    if (cursor) body.cursor = cursor;
    if (operationTypes.length) body.operationTypes = operationTypes;
    const data = await this.request('/tinkoff.public.invest.api.contract.v1.OperationsService/GetOperationsByCursor', body);
    return { items: data.items || [], hasNext: !!data.hasNext, nextCursor: data.nextCursor || '' };
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
    // Вариационная маржа открытой фьючерсной позиции в рублях — результат «как у брокера». Нужна, чтобы
    // сверять наш расчёт прибыли по позиции с брокерским (у акций поля нет — тогда 0).
    varMargin: moneyToFloat(p.varMargin),
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
  // ГО у Т-Банка разное для покупки и для продажи и меняется со временем. Для расчёта объёма
  // нужно брать значение стороны сделки (initialMarginOnBuy / initialMarginOnSell); `initialMargin`
  // оставлен как одно «безопасное» число для старых вызовов — БОЛЬШЕЕ из двух (раньше брали меньшее,
  // и у шорта ГО выходило заниженным).
  const margin    = Math.max(marginBuy, marginSell) || 0;

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
    // Ставка риска начальной маржи с учётом текущего уровня риска портфеля клиента (лонг/шорт):
    // у Т-Банка именно она определяет персональное плечо. Для фьючерсов может отсутствовать.
    dlongClient: moneyToFloat(instrument.dlongClient) || null,
    dshortClient: moneyToFloat(instrument.dshortClient) || null,
    // Доступность направлений: у части контрактов шорт или покупка закрыты.
    shortEnabled: instrument.shortEnabledFlag ?? null,
    buyAvailable: instrument.buyAvailableFlag ?? null,
    sellAvailable: instrument.sellAvailableFlag ?? null,
    currency: instrument.currency,
    expirationDate: instrument.expirationDate,
    basicAsset: instrument.basicAsset,
    // Логотип базового актива — приходит в ответе Т-Банка, раньше просто отбрасывался.
    // См. services/marketData/instrumentLogos.js про то, почему кэшируется по basicAsset,
    // а не по тикеру контракта.
    logoName: instrument.brand?.logoName || null,
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
    logoName: instrument.brand?.logoName || null,
  };
}
