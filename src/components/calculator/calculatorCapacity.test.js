// Калькулятор, фьючерс: сразу после выбора контракта (до ввода стопа) видно, сколько можно купить на мои деньги в каждую сторону, и плечо.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import fs from 'fs';
import path from 'path';

jest.mock('../../context/AuthContext', () => {
  const { SAMPLE: S } = require('../../qa/sampleData');
  const value = { user: { uid: 'qa', email: 'qa@example.com', emailVerified: true }, userProfile: { ...S.profile, depositSize: 300000, maxMarginPercent: 30, tinkoffToken: '' }, updateUserProfile: async () => {}, isAdmin: false, isPro: true, logout: () => {}, isEmailVerified: true };
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
  return { ...real, getUserTrades: async () => [], addTrade: jest.fn(async () => ({ id: 't1' })) };
});
jest.mock('../../services/paperTrades', () => ({ getPaperTrades: async () => [], getOpenPaperTrades: async () => [], addPaperTrade: jest.fn(), updatePaperTrade: jest.fn(), deletePaperTrade: jest.fn(), addPaperDecision: jest.fn() }));
jest.mock('../../services/radar', () => ({ getRadarItems: async () => [], addRadarItem: jest.fn(), deleteRadarItem: jest.fn(), updateRadarItem: jest.fn() }));
jest.mock('../../services/marketData/candles', () => {
  const real = jest.requireActual('../../services/marketData/candles');
  const { SAMPLE: S } = require('../../qa/sampleData');
  return { ...real, fetchDailyCandles: async () => S.candles() };
});
jest.mock('../../services/marketData/fortsTable', () => ({ fetchFortsTable: async () => new Map() }));
jest.mock('../../services/broker', () => ({ fetchOrderConfig: async () => ({ enabled: false }), fetchOrderState: async () => null, placeOrder: jest.fn(), explainOrderUnavailable: () => '' }));
jest.mock('../../services/tinkoff', () => ({ TinkoffAPI: class {}, moneyToFloat: () => 0, parseFutureInfo: () => ({}), parseShareInfo: () => ({}) }));

global.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof global.ResizeObserver === 'undefined') global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
Element.prototype.scrollIntoView = jest.fn();

const Calculator = require('./Calculator').default;

async function mount(draft) {
  try { sessionStorage.setItem('traderpro-calculator-draft', JSON.stringify(draft)); } catch { /* нет хранилища */ }
  const host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter><Calculator /></MemoryRouter>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 200)); });
  return { host, unmount: () => act(() => root.unmount()) };
}

// MXI: цена 2 469,15, шаг 0,05, стоимость шага 0,5 ₽ → контракт 24 691,5 ₽; ГО лонг 2 750,56, шорт 3 300; депозит 300 000, лимит ГО 30 %.
const FUT = { instrumentType: 'future', priceSource: 'moex', form: { ticker: 'MMZ6', entryPrice: '2469.15', stopLoss: '', takeProfit: '', depositSize: '300000', riskPercent: '1', lot: '1', minStep: '0.05', minStepAmount: '0.5', initialMargin: '', initialMarginBuy: '2750.56', initialMarginSell: '3300' } };

test('фьючерс без стопа: видно «на ваши деньги» — лонг до 32, шорт до 27, плечо и ГО по каждой стороне', async () => {
  const { host, unmount } = await mount(FUT);
  const box = host.querySelector('[data-testid="calc-capacity"]');
  expect(box).toBeTruthy();
  const rows = [...box.querySelectorAll('.calc-capacity-row')];
  expect(rows.length).toBe(2);
  expect(rows[0].textContent).toMatch(/ЛОНГ/);
  expect(rows[0].textContent).toMatch(/до\s32\sконтр/);
  expect(rows[0].textContent).toMatch(/плечо\s8,98×/);
  expect(rows[0].textContent).toMatch(/ГО\s2\s750,56\s₽/);   // копейки не теряются
  expect(rows[1].textContent).toMatch(/ШОРТ/);
  expect(rows[1].textContent).toMatch(/до\s27\sконтр/);   // шорт считается по СВОЕМУ ГО (3 300), а не по ГО лонга
  expect(rows[1].textContent).toMatch(/плечо\s7,48×/);
  expect(box.textContent).toMatch(/300\s000/);
  expect(box.textContent).toMatch(/не больше 30 %/);
  unmount();
});

test('ГО введено руками — главнее: обе стороны считаются по нему', async () => {
  const { host, unmount } = await mount({ ...FUT, form: { ...FUT.form, initialMargin: '5000' } });
  const rows = [...host.querySelectorAll('.calc-capacity-row')];
  expect(rows[0].textContent).toMatch(/до\s18\sконтр/);   // 90 000 / 5 000
  expect(rows[1].textContent).toMatch(/до\s18\sконтр/);
  unmount();
});

test('денег мало (ГО 120 000 ₽ при лимите 90 000): честно «не хватает денег» и пояснение, а не ноль контрактов молча', async () => {
  const { host, unmount } = await mount({ ...FUT, form: { ...FUT.form, initialMargin: '120000' } });
  const rows = [...host.querySelectorAll('.calc-capacity-row')];
  expect(rows[0].textContent).toMatch(/не хватает денег/);
  expect(rows[0].textContent).toMatch(/весь депозит под ГО вместил бы 2/);
  unmount();
});

test('акция: блока «на ваши деньги» нет', async () => {
  const { host, unmount } = await mount({ ...FUT, instrumentType: 'stock', form: { ...FUT.form, ticker: 'SBER' } });
  expect(host.querySelector('[data-testid="calc-capacity"]')).toBeNull();
  unmount();
});

// Для глаз (QA_PREVIEW=1): страница Калькулятора с блоком «на ваши деньги» → scripts/_preview/calc-capacity-<тема>.html
const preview = process.env.QA_PREVIEW ? test : test.skip;
preview('страница для просмотра: Калькулятор с блоком «на ваши деньги»', async () => {
  const root = path.resolve(__dirname, '../../..');
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.css')) files.push(p);
  });
  walk(path.join(root, 'src'));
  files.sort((a, b) => (a.includes('globals.css') ? -1 : b.includes('globals.css') ? 1 : a.localeCompare(b)));
  const css = files.map((f) => fs.readFileSync(f, 'utf8')).join(' ');
  const { host, unmount } = await mount(FUT);
  fs.mkdirSync(path.join(root, 'scripts/_preview'), { recursive: true });
  for (const theme of ['light', 'dark']) {
    const html = `<!doctype html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>calc</title><style>${css}</style></head><body><div style="max-width:760px;margin:20px auto">${host.innerHTML}</div></body></html>`;
    fs.writeFileSync(path.join(root, 'scripts/_preview', `calc-capacity-${theme}.html`), html, 'utf8');
  }
  unmount();
});
