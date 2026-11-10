// Сопровождение: у открытой фьючерсной сделки в шапке — плечо при входе, ГО под позицию и доля депозита; у контракта из радара (до сделки) — строка
// «плечо · ГО · на ваши деньги: лонг до N, шорт до M».
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../context/AuthContext', () => {
  const { SAMPLE: S } = require('../../qa/sampleData');
  const value = {
    user: { uid: 'qa', email: 'qa@example.com', emailVerified: true },
    userProfile: { ...S.profile, depositSize: 300000, maxMarginPercent: 30 }, updateUserProfile: async () => {}, isAdmin: false, isPro: true, logout: () => {}, isEmailVerified: true,
  };
  return { useAuth: () => value, AuthProvider: ({ children }) => children };
});
jest.mock('../../services/firebase', () => ({ db: {}, auth: {} }));
jest.mock('firebase/firestore', () => new Proxy({}, { get: (_, k) => (k === '__esModule' ? true : jest.fn()) }));
jest.mock('lightweight-charts', () => {
  const series = () => ({ setData: jest.fn(), attachPrimitive: jest.fn(), createPriceLine: jest.fn(), removePriceLine: jest.fn(), priceScale: () => ({ applyOptions: jest.fn() }), applyOptions: jest.fn(), priceToCoordinate: () => 0, coordinateToPrice: () => 0 });
  return {
    createChart: () => ({
      addSeries: () => series(), removeSeries: jest.fn(), remove: jest.fn(), resize: jest.fn(), applyOptions: jest.fn(),
      subscribeCrosshairMove: jest.fn(), unsubscribeCrosshairMove: jest.fn(), subscribeClick: jest.fn(), unsubscribeClick: jest.fn(),
      panes: () => [{ getHeight: () => 300 }], removePane: jest.fn(),
      priceScale: () => ({ width: () => 50, setAutoScale: jest.fn(), getVisibleRange: () => null, options: () => ({ autoScale: true }), applyOptions: jest.fn() }),
      timeScale: () => ({ setVisibleLogicalRange: jest.fn(), fitContent: jest.fn(), logicalToCoordinate: () => 0, coordinateToLogical: () => 0 }),
    }),
    CrosshairMode: { Normal: 0 }, CandlestickSeries: 1, LineSeries: 2, AreaSeries: 3, HistogramSeries: 4, BaselineSeries: 5,
    createSeriesMarkers: () => ({ setMarkers: jest.fn() }),
  };
});
jest.mock('../../services/trades', () => {
  const real = jest.requireActual('../../services/trades');
  const { SAMPLE: S } = require('../../qa/sampleData');
  const openFut = {
    id: 'tf1', ticker: 'MMZ9', direction: 'long', status: 'open', instrumentType: 'future', isFuture: true, entryPrice: 2469.15, volume: 3, remainingVolume: 3, lot: 1,
    minStep: 0.05, minStepAmount: 0.5, stopLoss: 2400, takeProfit: 2600, pnl: null, commissionRate: 0.0004, depositSize: 300000,
    marginPerContract: 2750.56, marginSide: 'long', marginSource: 'tbank', leverageAtEntry: 8.9769,
    openedAt: new Date(Date.now() - 3600e3).toISOString(), date: new Date().toISOString().slice(0, 10), entryTimeframe: 'D1',
  };
  return { ...real, getUserTrades: async () => [openFut, ...S.trades], getImportArtifacts: async () => [] };
});
jest.mock('../../services/paperTrades', () => ({
  getPaperTrades: async () => [], getOpenPaperTrades: async () => [],
  addPaperTrade: jest.fn(), updatePaperTrade: jest.fn(), deletePaperTrade: jest.fn(), addPaperDecision: jest.fn(),
}));
jest.mock('../../services/radar', () => {
  const real = jest.requireActual('../../services/radarRules');
  return { ...real, getRadarItems: async () => [], addRadarItem: jest.fn(), deleteRadarItem: jest.fn(), updateRadarItem: jest.fn() };
});
jest.mock('../../services/marketData/candles', () => {
  const real = jest.requireActual('../../services/marketData/candles');
  const { SAMPLE: S } = require('../../qa/sampleData');
  return { ...real, fetchDailyCandles: async () => S.candles() };
});
// Таблица биржи: контракт с экспирацией в далёком будущем (тест не зависит от даты). MXI: цена 2469,15, шаг 0,05, стоимость шага 0,5 → 24 691,5 ₽.
jest.mock('../../services/marketData/fortsTable', () => {
  const M = jest.requireActual('../../services/marketData/marginTrack');
  const SC = ['SECID', 'SHORTNAME', 'ASSETCODE', 'LASTTRADEDATE', 'MINSTEP', 'STEPPRICE', 'INITIALMARGIN', 'LOTVOLUME', 'BUYSELLFEE', 'SECTYPE', 'PREVSETTLEPRICE', 'LOWLIMIT', 'HIGHLIMIT'];
  const table = M.parseFortsTable({
    securities: { columns: SC, data: [['MMZ9', 'MXI-12.29', 'MXI', '2099-12-17', 0.05, 0.5, 2750.56, 1, 1.63, 'MM', 2466.6, 2330, 2602]] },
    marketdata: { columns: ['SECID', 'LAST', 'SETTLEPRICE', 'UPDATETIME'], data: [['MMZ9', 2469.15, 2469.05, '20:26']] },
  });
  return { fetchFortsTable: async () => table };
});
jest.mock('../../services/futuresMargin', () => ({ fetchFortsTable: async () => (await require('../../services/marketData/fortsTable').fetchFortsTable()), getMarginState: async () => null }));
jest.mock('../../services/broker', () => ({ fetchOrderConfig: async () => ({ enabled: false }), fetchOrderState: async () => null, placeOrder: jest.fn(), explainOrderUnavailable: () => '' }));
jest.mock('../../services/tinkoff', () => ({ TinkoffAPI: class {}, moneyToFloat: () => 0 }));

global.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof global.ResizeObserver === 'undefined') global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView = jest.fn();

const Cockpit = require('./Cockpit').default;
const { RadarLiveProvider } = require('../../context/RadarLiveContext');

async function mount(url) {
  const host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter initialEntries={[url]}><RadarLiveProvider><Cockpit /></RadarLiveProvider></MemoryRouter>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  return { host, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => { try { sessionStorage.clear(); } catch { /* нет хранилища */ } });

test('открытая фьючерсная сделка: в шапке плечо при входе, ГО под позицию и доля депозита; в списке позиций — плечо', async () => {
  const { host, unmount } = await mount('/cockpit?activeId=tf1');
  const lev = host.querySelector('[data-testid="ck-head-lev"]');
  expect(lev).toBeTruthy();
  expect(lev.textContent).toMatch(/Плечо при входе\s8,98×/);   // не «9×»: на нескольких контрактах округление до целого — уже ошибка
  expect(lev.textContent).toMatch(/ГО\s2\s750,56\s₽\s×\s3\s=\s8\s251,68\s₽/);   // копейки сохранены: 2 750,56 × 3 = 8 251,68
  expect(lev.textContent).toMatch(/\(2,8\s%\sдепозита\)/);                 // 8 251,68 / 300 000 = 2,75 % → 2,8 % (с десятой, не «3 %»)
  expect(lev.textContent).toMatch(/Т-Банк/);                               // источник ГО записан при открытии и подписан
  expect(host.querySelector('.ck-pos-list').textContent).toMatch(/плечо\s8,98×/);
  unmount();
});

test('контракт из радара до сделки: строка «плечо · ГО · на ваши деньги: лонг до N, шорт до M»', async () => {
  const { host, unmount } = await mount('/cockpit?previewTicker=MM&previewType=future');
  const strip = host.querySelector('[data-testid="ck-contract-strip"]');
  expect(strip).toBeTruthy();
  expect(strip.textContent).toMatch(/MMZ9/);
  expect(strip.textContent).toMatch(/плечо\s8,98×/);
  expect(strip.textContent).toMatch(/ГО\s2\s750,56\s₽/);
  expect(strip.textContent).toMatch(/\(биржа\)/);                           // токена в профиле нет — ГО биржевое, и это подписано
  expect(strip.textContent).toMatch(/лонг до 32 контр\./);                 // 300 000 × 30 % / 2 750,56
  expect(strip.textContent).toMatch(/шорт до 32 контр\./);                 // биржевое ГО одно на обе стороны
  unmount();
});

test('акция из радара: строки контракта нет', async () => {
  const { host, unmount } = await mount('/cockpit?previewTicker=SBER&previewType=stock');
  expect(host.querySelector('[data-testid="ck-contract-strip"]')).toBeNull();
  unmount();
});
