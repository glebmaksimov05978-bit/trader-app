// Радар в Сопровождении: у фьючерсов под тикером видны ГО и плечо (живая таблица биржи + состояние робота), у акций — ничего лишнего.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';
import { MemoryRouter } from 'react-router-dom';
import fs from 'fs';
import path from 'path';

// Токен Т-Инвестиций в профиле: пустой — ГО только биржевое; задан — приложение спрашивает ГО у брокера (подставной ответ ниже).
let mockToken = '';
jest.mock('../../context/AuthContext', () => {
  const { SAMPLE: S } = require('../../qa/sampleData');
  const value = { user: { uid: 'qa', email: 'qa@example.com', emailVerified: true }, userProfile: { ...S.profile, get tinkoffToken() { return mockToken; } }, updateUserProfile: async () => {}, isAdmin: false, isPro: true };
  return { useAuth: () => value, AuthProvider: ({ children }) => children };
});
jest.mock('../../services/marketData/brokerMarginClient', () => ({
  fetchBrokerMargins: async (token, ids) => (token ? new Map(ids.map((id) => [id, { buy: 2900.12, sell: 3300.5 }])) : new Map()),
  resetBrokerMarginCache: () => {},
}));
jest.mock('../../services/firebase', () => ({ db: {}, auth: {} }));
jest.mock('firebase/firestore', () => new Proxy({}, { get: (_, k) => (k === '__esModule' ? true : jest.fn()) }));
jest.mock('../../services/radar', () => {
  const real = jest.requireActual('../../services/radarRules');
  return {
    ...real,
    getRadarItems: async () => [
      { id: 'r1', uid: 'qa', ticker: 'MM', instrumentType: 'future', timeframe: 'D1' },
      { id: 'r2', uid: 'qa', ticker: 'SBER', instrumentType: 'stock', timeframe: 'D1' },
    ],
    addRadarItem: jest.fn(), deleteRadarItem: jest.fn(), updateRadarItem: jest.fn(),
  };
});
jest.mock('../../services/paperTrades', () => ({ getOpenPaperTrades: async () => [], getPaperTrades: async () => [] }));
jest.mock('../../services/trades', () => ({ getUserTrades: async () => [] }));
jest.mock('../../services/marketData/instrumentLogos', () => ({
  getCachedLogos: async () => new Map(), logoUrlFromName: () => null, logoCacheKey: ({ ticker }) => ticker,
}));
// Таблица биржи: контракт с экспирацией в далёком будущем, чтобы тест не зависел от даты.
jest.mock('../../services/futuresMargin', () => {
  const M = jest.requireActual('../../services/marketData/marginTrack');
  const SC = ['SECID', 'SHORTNAME', 'ASSETCODE', 'LASTTRADEDATE', 'MINSTEP', 'STEPPRICE', 'INITIALMARGIN', 'LOTVOLUME', 'BUYSELLFEE', 'SECTYPE', 'PREVSETTLEPRICE', 'LOWLIMIT', 'HIGHLIMIT'];
  const table = M.parseFortsTable({
    securities: { columns: SC, data: [['MMZ9', 'MXI-12.29', 'MXI', '2099-12-17', 0.05, 0.5, 2750.56, 1, 1.63, 'MM', 2466.6, 2330, 2602]] },
    marketdata: { columns: ['SECID', 'LAST', 'SETTLEPRICE', 'UPDATETIME'], data: [['MMZ9', 2469.15, 2469.05, '20:26']] },
  });
  const state = {
    at: new Date().toISOString(),
    items: { MMZ9: { buy: 2750.56, sell: 2750.56, src: 'moex', prevBuy: 2292.13, prevSell: 2292.13, since: new Date(Date.now() - 86400000).toISOString() } },
  };
  return { fetchFortsTable: async () => table, getMarginState: async () => state };
});

global.IS_REACT_ACT_ENVIRONMENT = true;
if (typeof global.ResizeObserver === 'undefined') global.ResizeObserver = class { observe() {} unobserve() {} disconnect() {} };

const RadarPanel = require('./RadarPanel').default;

async function mount() {
  const host = document.createElement('div');
  document.body.innerHTML = '';
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<MemoryRouter><RadarPanel /></MemoryRouter>); });
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  return { host, unmount: () => act(() => root.unmount()) };
}

beforeEach(() => { mockToken = ''; });

test('у фьючерса в радаре видны ГО, плечо, значок «ГО выросло» и пометка про биржу; у акции — нет', async () => {
  const { host, unmount } = await mount();
  const rows = [...host.querySelectorAll('.ck-radar-item')];
  expect(rows.length).toBe(2);
  const fut = rows.find((r) => /MM/.test(r.textContent) && !/SBER/.test(r.textContent));
  const stock = rows.find((r) => /SBER/.test(r.textContent));
  const line = fut.querySelector('.ck-radar-margin');
  expect(line).toBeTruthy();
  expect(line.textContent).toMatch(/^плечо\s8,98×\s·\sГО\s2\s750,56\s₽/); // плечо первым и без округления, ГО вторым и с копейками: 24 691,5 / 2 750,56 = 8,98×
  expect(line.textContent).toMatch(/биржа/);                      // источник подписан
  expect(line.textContent).toMatch(/было\s10,77×/);               // ГО выросло с 2 292,13 до 2 750,56: плечо стало 8,98×, а было 10,77×
  expect(line.getAttribute('title')).toMatch(/MMZ9/);              // подсказка называет конкретный контракт за корнем «MM»
  expect(stock.querySelector('.ck-radar-margin')).toBeNull();
  unmount();
});

test('токен Т-Инвестиций сохранён: в радаре ГО Т-Банка (лонг и шорт отдельно), с копейками, подпись «Т-Банк», без пометки «биржа»', async () => {
  mockToken = 'tok';
  const { host, unmount } = await mount();
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  const fut = [...host.querySelectorAll('.ck-radar-item')].find((r) => /MM/.test(r.textContent) && !/SBER/.test(r.textContent));
  const line = fut.querySelector('.ck-radar-margin');
  expect(line.textContent).toMatch(/^плечо\s8,51×\s\/\s7,48×\s·\sГО\sлонг\s2\s900,12\s\/\sшорт\s3\s300,50\s₽/);   // 24 691,5 / 2 900,12 и / 3 300,5
  expect(line.textContent).toMatch(/Т-Банк/);
  expect(line.textContent).not.toMatch(/биржа/);
  expect(line.textContent).not.toMatch(/было/);                    // история робота — биржевая, с числами брокера её не смешиваем
  unmount();
});

// Для глаз (QA_PREVIEW=1): строка радара в узкой колонке в обеих темах → scripts/_preview/radar-margin-<тема>.html
const preview = process.env.QA_PREVIEW ? test : test.skip;
preview('страница для просмотра: радар с ГО и плечом', async () => {
  const root = path.resolve(__dirname, '../../..');
  const files = [];
  const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).forEach((e) => {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p); else if (p.endsWith('.css')) files.push(p);
  });
  walk(path.join(root, 'src'));
  files.sort((a, b) => (a.includes('globals.css') ? -1 : b.includes('globals.css') ? 1 : a.localeCompare(b)));
  const css = files.map((f) => fs.readFileSync(f, 'utf8')).join(' ');
  if (process.env.QA_TBANK) mockToken = 'tok';   // QA_TBANK=1 — вариант с ГО Т-Банка
  const { host, unmount } = await mount();
  await act(async () => { await new Promise((r) => setTimeout(r, 100)); });
  for (const theme of ['light', 'dark']) {
    const html = `<!doctype html><html lang="ru" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>radar</title><style>${css}</style></head><body><div style="width:330px;margin:20px">${host.innerHTML}</div></body></html>`;
    fs.mkdirSync(path.join(root, 'scripts/_preview'), { recursive: true });
    fs.writeFileSync(path.join(root, 'scripts/_preview', `radar-margin${process.env.QA_TBANK ? '-tbank' : ''}-${theme}.html`), html, 'utf8');
  }
  unmount();
});
