// Визуальная проверка страниц без входа в аккаунт: каждая страница приложения отрисовывается
// в тестовом браузере (jsdom) на примерных данных, и результат вместе со всеми стилями пишется в
// scripts/_preview/<страница>.html — его можно открыть в обычном браузере и посмотреть глазами.
// Запуск: QA_PREVIEW=1 npx react-scripts test --watchAll=false src/qa
// Без QA_PREVIEW тест пропускается (в обычном прогоне файлы не пишутся).
import React from 'react';
import fs from 'fs';
import path from 'path';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import { SAMPLE } from './sampleData';

jest.mock('../context/AuthContext', () => {
  const { SAMPLE: S } = require('./sampleData');
  // Один и тот же объект на все вызовы — как у настоящего контекста (иначе эффекты с [user] крутятся бесконечно).
  const value = {
    user: { uid: 'qa', email: 'qa@example.com', emailVerified: true },
    userProfile: S.profile, updateUserProfile: async () => {}, isAdmin: false, isPro: true,
    logout: () => {}, isEmailVerified: true,
  };
  return {
    useAuth: () => value,
    AuthProvider: ({ children }) => children,
  };
});
jest.mock('../services/firebase', () => ({ db: {}, auth: {} }));
jest.mock('firebase/firestore', () => new Proxy({}, { get: (_, k) => (k === '__esModule' ? true : jest.fn()) }));
jest.mock('lightweight-charts', () => {
  const series = () => ({ setData: jest.fn(), attachPrimitive: jest.fn(), createPriceLine: jest.fn(), removePriceLine: jest.fn(), priceScale: () => ({ applyOptions: jest.fn() }), applyOptions: jest.fn(), priceToCoordinate: () => 0, coordinateToPrice: () => 0 });
  return {
    createChart: () => ({
      addSeries: () => series(), removeSeries: jest.fn(), remove: jest.fn(), resize: jest.fn(), applyOptions: jest.fn(),
      subscribeCrosshairMove: jest.fn(), unsubscribeCrosshairMove: jest.fn(), subscribeClick: jest.fn(), unsubscribeClick: jest.fn(),
      panes: () => [1], removePane: jest.fn(),
      timeScale: () => ({ setVisibleLogicalRange: jest.fn(), fitContent: jest.fn(), logicalToCoordinate: () => 0, coordinateToLogical: () => 0 }),
    }),
    CrosshairMode: { Normal: 0 }, CandlestickSeries: 1, LineSeries: 2, AreaSeries: 3, HistogramSeries: 4, BaselineSeries: 5,
    createSeriesMarkers: () => ({ setMarkers: jest.fn() }),
  };
});
jest.mock('../services/trades', () => {
  const real = jest.requireActual('../services/trades');
  const { SAMPLE: S } = require('./sampleData');
  return { ...real, getUserTrades: async () => S.trades, getImportArtifacts: async () => [] };
});
jest.mock('../services/paperTrades', () => {
  const { SAMPLE: S } = require('./sampleData');
  return {
    getPaperTrades: async () => S.paper,
    getOpenPaperTrades: async () => S.paper.filter((t) => t.status === 'open' || t.status === 'partial'),
    addPaperTrade: jest.fn(), updatePaperTrade: jest.fn(), deletePaperTrade: jest.fn(), addPaperDecision: jest.fn(),
  };
});
jest.mock('../services/radar', () => {
  const { SAMPLE: S } = require('./sampleData');
  return { getRadarItems: async () => S.radar, addRadarItem: jest.fn(), deleteRadarItem: jest.fn(), updateRadarItem: jest.fn() };
});
jest.mock('../services/marketData/candles', () => {
  const real = jest.requireActual('../services/marketData/candles');
  const { SAMPLE: S } = require('./sampleData');
  return { ...real, fetchDailyCandles: async () => S.candles() };
});
jest.mock('../services/broker', () => ({
  fetchOrderConfig: async () => ({ enabled: false }), fetchOrderState: async () => null,
  placeOrder: jest.fn(), explainOrderUnavailable: () => 'Заявки в тесте выключены',
}));
jest.mock('../services/tinkoff', () => ({ TinkoffAPI: class {}, moneyToFloat: () => 0 }));

const ROOT = path.resolve(__dirname, '../..');
const OUT = path.join(ROOT, 'scripts/_preview');

function allCss() {
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.css')) files.push(p);
  });
  walk(path.join(ROOT, 'src'));
  files.sort((a, b) => (a.includes('globals.css') ? -1 : b.includes('globals.css') ? 1 : a.localeCompare(b)));
  return files.map((f) => `/* ${path.basename(f)} */\n${fs.readFileSync(f, 'utf8')}`).join('\n');
}

const run = process.env.QA_PREVIEW ? describe : describe.skip;
// recharts (графики дашборда) просит ResizeObserver, которого в jsdom нет.
if (typeof global.ResizeObserver === 'undefined') {
  global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };
}

run('страницы для просмотра глазами', () => {
  const Sidebar = require('../components/layout/Sidebar').default;
  const { ThemeProvider } = require('../context/ThemeContext');
  const { RadarLiveProvider } = require('../context/RadarLiveContext');
  const pages = {
    dashboard: ['/', require('../components/dashboard/Dashboard').default],
    capital: ['/capital', require('../components/capital/Capital').default],
    journal: ['/journal', require('../components/journal/Journal').default],
    report: ['/report', require('../components/report/MonthlyReport').default],
    cockpit: ['/cockpit', require('../components/cockpit/Cockpit').default],
    calculator: ['/calculator', require('../components/calculator/Calculator').default],
    settings: ['/settings', require('../components/settings/Settings').default],
  };
  const css = allCss();
  fs.mkdirSync(OUT, { recursive: true });

  for (const theme of ['light', 'dark']) {
    for (const [name, [route, Page]] of Object.entries(pages)) {
      test(`${name} (${theme})`, async () => {
        localStorage.setItem('theme', theme);
        document.documentElement.setAttribute('data-theme', theme);
        const host = document.createElement('div');
        document.body.innerHTML = '';
        document.body.appendChild(host);
        const errors = [];
        const origErr = console.error;
        console.error = (...a) => { const m = String(a[0]); if (!/act\(|ReactDOMTestUtils|width\(0\)|height\(0\)|useLayoutEffect/.test(m)) errors.push(m.slice(0, 300)); };
        const root = createRoot(host);
        await act(async () => {
          root.render(
            <ThemeProvider>
              <MemoryRouter initialEntries={[route]}>
                <RadarLiveProvider>
                  <div className="app-layout">
                    <Sidebar />
                    <main className="main-content"><Page /></main>
                  </div>
                </RadarLiveProvider>
              </MemoryRouter>
            </ThemeProvider>,
          );
        });
        await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
        await act(async () => { await new Promise((r) => setTimeout(r, 300)); });
        const html = `<!doctype html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${name}</title><style>${css}</style></head><body>${document.body.innerHTML}</body></html>`;
        fs.writeFileSync(path.join(OUT, `${name}-${theme}.html`), html, 'utf8');
        fs.writeFileSync(path.join(OUT, `${name}-${theme}.errors.txt`), errors.join('\n---\n'), 'utf8');
        console.error = origErr;
        act(() => root.unmount());
      }, 30000);
    }
  }
});
