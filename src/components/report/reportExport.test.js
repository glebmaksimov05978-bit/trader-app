// Проверка окна «Выгрузить отчёт» (npm run test:smoke): открывается, показывает период и итог, выбор разделов и среза влияет
// на модель, кнопки запускают сборку PDF/Word и скачивание. Сами библиотеки PDF/Word в тесте заменены заглушками.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

jest.mock('react-hot-toast', () => { const t = jest.fn(); t.success = jest.fn(); t.error = jest.fn(); return { __esModule: true, default: t }; });
const mockPdf = jest.fn();
const mockDocx = jest.fn();
const mockDownload = jest.fn();
jest.mock('../../services/report/exportClient', () => ({
  buildPdfBlob: (...a) => mockPdf(...a),
  buildDocxBlob: (...a) => mockDocx(...a),
  downloadBlob: (...a) => mockDownload(...a),
  reportFileName: (m, ext) => `TraderPro_report_${m.meta.period.from}.${ext}`,
}));

const ReportExportModal = require('./ReportExportModal').default;

const NOW = Date.now();
const iso = (daysAgo) => new Date(NOW - daysAgo * 86400000).toISOString();
const trades = [
  { status: 'closed', pnl: 1500, closedAt: iso(40), ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой' },
  { status: 'closed', pnl: -600, closedAt: iso(38), ticker: 'GAZP', direction: 'short', entryStrategyName: 'Отскок' },
  { status: 'closed', pnl: 900, closedAt: iso(5), ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой' },
];

const click = (el) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const byText = (text, root = document.body) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim().includes(text));
const change = (el, value) => act(async () => {
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
});

let host, root, onClose;
async function mount(props = {}) {
  onClose = jest.fn();
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => {
    root.render(<ReportExportModal open onClose={onClose} realTrades={trades} paperTrades={[]} strategyList={[{ name: 'Пробой', count: 2 }, { name: 'Отскок', count: 1 }]}
      defaultScope="real" defaultStrategies={[]} pageRange={null} {...props} />);
  });
}
beforeEach(() => {
  localStorage.clear();
  mockPdf.mockReset(); mockDocx.mockReset(); mockDownload.mockReset();
  mockPdf.mockImplementation(async () => new Blob(['pdf']));
  mockDocx.mockImplementation(async () => new Blob(['docx']));
});
afterEach(async () => { await act(async () => { root.unmount(); }); host.remove(); document.body.innerHTML = ''; });

test('окно открывается: период, срез, стратегии, девять разделов, две кнопки', async () => {
  await mount();
  const dlg = document.body.querySelector('[role="dialog"]');
  expect(dlg).not.toBeNull();
  expect(dlg.textContent).toContain('Выгрузить отчёт');
  expect(dlg.querySelectorAll('.rx-check').length).toBe(9);
  expect([...dlg.querySelectorAll('.rx-seg button')].map((b) => b.textContent)).toEqual(['Реальные', 'Бумажные', 'Всё вместе']);
  expect(byText('Скачать PDF')).toBeTruthy();
  expect(byText('Скачать Word')).toBeTruthy();
  expect(dlg.textContent).toContain('Пробой');
});

test('по умолчанию включены главные разделы, «Список всех сделок» выключен', async () => {
  await mount();
  const boxes = [...document.body.querySelectorAll('.rx-check')];
  const on = (label) => boxes.find((b) => b.textContent.includes(label)).querySelector('input').checked;
  expect(on('Итоги периода')).toBe(true);
  expect(on('Динамика результата')).toBe(true);
  expect(on('Список всех сделок')).toBe(false);
});

test('свои даты: без дат кнопки выключены и видно пояснение; с датами — итог за период', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'custom');
  expect(document.body.textContent).toContain('Укажите обе даты');
  expect(byText('Скачать PDF').disabled).toBe(true);
  const d = (ms) => new Date(ms).toISOString().slice(0, 10);
  const inputs = document.body.querySelectorAll('.rx-dates input[type="date"]');
  await change(inputs[0], d(NOW - 60 * 86400000));
  await change(document.body.querySelectorAll('.rx-dates input[type="date"]')[1], d(NOW));
  expect(document.body.querySelector('.rx-summary').textContent).toMatch(/3 сделки/);
  expect(byText('Скачать PDF').disabled).toBe(false);
});

test('конец периода раньше начала — понятная ошибка', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'custom');
  await change(document.body.querySelectorAll('.rx-dates input[type="date"]')[0], '2026-10-20');
  await change(document.body.querySelectorAll('.rx-dates input[type="date"]')[1], '2026-10-10');
  expect(document.body.textContent).toContain('Дата конца раньше даты начала');
});

test('«Скачать PDF» собирает модель выбранного периода и запускает скачивание', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  await click(byText('Скачать PDF'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(mockPdf).toHaveBeenCalledTimes(1);
  const model = mockPdf.mock.calls[0][0];
  expect(model.stats.total).toBe(3);
  expect(model.meta.scope).toBe('real');
  expect(model.sections).toContain('summary');
  expect(mockDownload).toHaveBeenCalledTimes(1);
  expect(mockDownload.mock.calls[0][1]).toMatch(/\.pdf$/);
  expect(mockDocx).not.toHaveBeenCalled();
});

test('«Скачать Word» собирает Word; снятые разделы не попадают в модель; выбор стратегии фильтрует сделки', async () => {
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  const boxes = [...document.body.querySelectorAll('.rx-check')];
  await click(boxes.find((b) => b.textContent.includes('Динамика результата')).querySelector('input'));
  await click([...document.body.querySelectorAll('.rx-chip')].find((c) => c.textContent === 'Отскок'));
  await click(byText('Скачать Word'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(mockDocx).toHaveBeenCalledTimes(1);
  const model = mockDocx.mock.calls[0][0];
  expect(model.sections).not.toContain('curve');
  expect(model.stats.total).toBe(1);
  expect(model.meta.strategiesText).toBe('Отскок');
  expect(mockDownload.mock.calls[0][1]).toMatch(/\.docx$/);
});

test('если выбран период «как на странице», он совпадает с открытым в отчёте', async () => {
  await mount({ pageRange: { type: 'month', key: '2026-09', label: 'Сентябрь 2026' } });
  const sel = document.body.querySelector('select[aria-label="Период"]');
  expect(sel.textContent).toContain('Как на странице: Сентябрь 2026');
  await change(sel, 'page');
  expect(document.body.textContent).toContain('1–30 сентября 2026');
});

test('выбранные разделы запоминаются, Esc закрывает окно', async () => {
  await mount();
  const boxes = [...document.body.querySelectorAll('.rx-check')];
  await click(boxes.find((b) => b.textContent.includes('Список всех сделок')).querySelector('input'));
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  await click(byText('Скачать PDF'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(JSON.parse(localStorage.getItem('tp_report_export_v1')).sections).toContain('trades');
  act(() => { window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' })); });
  expect(onClose).toHaveBeenCalled();
});

test('ошибка сборки показывается сообщением, кнопки снова доступны', async () => {
  const toast = require('react-hot-toast').default;
  mockPdf.mockImplementation(async () => { throw new Error('сломалось'); });
  await mount();
  await change(document.body.querySelector('select[aria-label="Период"]'), 'last_90');
  await click(byText('Скачать PDF'));
  await act(async () => { await new Promise((r) => setTimeout(r, 10)); });
  expect(toast.error).toHaveBeenCalled();
  expect(mockDownload).not.toHaveBeenCalled();
  expect(byText('Скачать PDF').disabled).toBe(false);
});
