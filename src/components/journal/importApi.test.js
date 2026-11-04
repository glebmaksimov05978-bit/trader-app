// Загрузка сделок прямо из Т-Банка в окне импорта (npm run test:smoke): вкладка, список счетов, загрузка,
// предпросмотр позиции, пропущенные операции и кнопка диагностики. Т-Банк и Firebase подменены.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('lightweight-charts', () => ({ createChart: () => ({}), CrosshairMode: {} }));
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'u1' }, userProfile: { tinkoffToken: 'token-not-real' } }) }));
jest.mock('../../services/firebase', () => ({ db: {}, auth: {} }));
jest.mock('../../services/trades', () => ({
  newTradeRef: jest.fn(), tradeRefById: jest.fn(), tradeHistoryRef: jest.fn(),
  commitTradeBatch: jest.fn(async () => {}), saveImportArtifacts: jest.fn(async () => {}),
}));
jest.mock('../../services/tinkoff', () => {
  const mv = (v) => ({ currency: 'rub', units: String(v), nano: 0 });
  class TinkoffAPI {
    async getAccounts() { return [{ id: 'A1', name: 'Брокерский счёт', status: 'ACCOUNT_STATUS_OPEN' }, { id: 'A0', name: 'Закрытый', status: 'ACCOUNT_STATUS_CLOSED' }]; }
    async getOperationsPage() {
      const base = { state: 'OPERATION_STATE_EXECUTED', instrumentType: 'futures', ticker: 'SRZ6', classCode: 'SPBFUT', payment: mv(0) };
      return {
        hasNext: false, nextCursor: '',
        items: [
          { ...base, id: 'o1', type: 'OPERATION_TYPE_BUY', date: '2026-10-03T07:00:00Z', quantity: '2', quantityRest: '0', price: mv(29000), commission: mv(-4),
            tradesInfo: { trades: [{ num: 'B1', date: '2026-10-03T07:00:00Z', quantity: '2', price: mv(29000) }] } },
          { ...base, id: 'o2', type: 'OPERATION_TYPE_SELL', date: '2026-10-03T12:00:00Z', quantity: '2', quantityRest: '0', price: mv(29300), commission: mv(-4),
            tradesInfo: { trades: [{ num: 'S1', date: '2026-10-03T12:00:00Z', quantity: '2', price: mv(29300) }] } },
          { id: 'o3', state: 'OPERATION_STATE_EXECUTED', type: 'OPERATION_TYPE_BUY', instrumentType: 'bond', ticker: 'SU26238', date: '2026-10-04T07:00:00Z', quantity: '1', price: mv(950), payment: mv(-950) },
        ],
      };
    }
    async getShareByTicker() { return { lot: 10 }; }
    async getFutureByTicker() { return { ticker: 'SRZ6' }; }
  }
  return { TinkoffAPI, parseFutureInfo: (i) => (i ? { minPriceIncrement: 1, minPriceIncrementAmount: 1 } : null) };
});

const ImportModal = require('./ImportModal').default;

const flush = () => act(async () => { await new Promise((r) => setTimeout(r, 30)); });
const click = (el) => act(() => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const btn = (text) => [...document.body.querySelectorAll('button')].find((b) => b.textContent.includes(text));

test('прямо из Т-Банка: вкладка, счета, загрузка, предпросмотр, пропущенное и диагностика', async () => {
  const host = document.createElement('div');
  document.body.appendChild(host);
  const root = createRoot(host);
  await act(async () => { root.render(<ImportModal existingTrades={[]} onClose={() => {}} onImported={() => {}} />); });

  // по умолчанию — файл
  expect(document.body.textContent).toContain('Файл отчёта');
  click(btn('Прямо из Т-Банка'));
  await flush();
  const selects = [...document.body.querySelectorAll('select')];
  expect(selects[0].textContent).toContain('Брокерский счёт');
  expect(selects[0].textContent).not.toContain('Закрытый');   // закрытые счета не предлагаются

  click(btn('Загрузить сделки из Т-Банка'));
  await flush(); await flush();

  const text = document.body.textContent;
  expect(text).toContain('операций-сделок 3');
  expect(text).toContain('фьючерсы 2');                       // два исполнения фьючерса
  expect(text).toContain('Пропущено: 1');                     // облигация
  expect(text).toContain('не поддерживается');
  expect(document.body.querySelector('tbody').textContent).toContain('SRZ6');
  expect(document.body.querySelector('tbody').textContent).toContain('Лонг');
  expect(btn('Скопировать диагностику')).toBeTruthy();
  expect(text).toContain('Импортировать (1)');

  act(() => root.unmount());
  host.remove();
});
