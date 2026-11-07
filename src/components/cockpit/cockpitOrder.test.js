// Сопровождение, инструмент из радара: порядок блоков — «Готовность к входу» → график → кнопка «Технический анализ»
// (раньше технический анализ шёл первым, а график — в самом конце). И: вид запоминается при уходе на другую вкладку.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';

jest.mock('../../context/AuthContext', () => {
  const { SAMPLE: S } = require('../../qa/sampleData');
  const value = {
    user: { uid: 'qa', email: 'qa@example.com', emailVerified: true },
    userProfile: S.profile, updateUserProfile: async () => {}, isAdmin: false, isPro: true, logout: () => {}, isEmailVerified: true,
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
  return { ...real, getUserTrades: async () => S.trades, getImportArtifacts: async () => [] };
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
jest.mock('../../services/broker', () => ({
  fetchOrderConfig: async () => ({ enabled: false }), fetchOrderState: async () => null, placeOrder: jest.fn(), explainOrderUnavailable: () => '',
}));
jest.mock('../../services/tinkoff', () => ({ TinkoffAPI: class {}, moneyToFloat: () => 0 }));

global.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

// В jsdom нет прокрутки к элементу, которую вкладка вызывает после загрузки графика
Element.prototype.scrollIntoView = jest.fn();

const Cockpit = require('./Cockpit').default;
const { RadarLiveProvider } = require('../../context/RadarLiveContext');

async function mount(url) {
  const host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => {
    root.render(<MemoryRouter initialEntries={[url]}><RadarLiveProvider><Cockpit /></RadarLiveProvider></MemoryRouter>);
  });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
  return { host, unmount: () => act(() => root.unmount()) };
}
const before = (a, b) => !!(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

beforeEach(() => { try { sessionStorage.clear(); } catch { /* нет хранилища — не страшно */ } });

test('инструмент из радара: готовность к входу, затем график, затем кнопка «Технический анализ»', async () => {
  const { host, unmount } = await mount('/cockpit?previewTicker=SBER&previewType=stock');
  const chart = host.querySelector('#ck-chart');
  const ta = [...host.querySelectorAll('button')].find((b) => /Технический анализ/.test(b.textContent));
  const readiness = [...host.querySelectorAll('h3')].find((h) => /Готовность к входу/.test(h.textContent));
  expect(chart).toBeTruthy();
  expect(ta).toBeTruthy();
  expect(readiness).toBeTruthy();
  expect(before(readiness, chart)).toBe(true);
  expect(before(chart, ta)).toBe(true);
  unmount();
});

test('после ухода и возврата (адрес без параметров) открывается тот же инструмент', async () => {
  const first = await mount('/cockpit?previewTicker=GAZP&previewType=stock');
  expect(first.host.querySelector('#ck-chart')).toBeTruthy();
  first.unmount();
  const back = await mount('/cockpit'); // как вернуться из «Капитала» через меню
  expect(back.host.querySelector('#ck-chart')).toBeTruthy();
  expect(back.host.textContent).toContain('GAZP');
  back.unmount();
});
