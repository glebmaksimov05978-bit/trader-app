// Проверка страницы тренажёра (npm run test:smoke): монтируется без ошибок, игра «Увидеть фигуру» принимает ответ и
// сохраняет прогресс, «Переигровка» проводит сделку от заявки до закрытия и записывает её в ОТДЕЛЬНУЮ коллекцию,
// «Разбор» показывает только учебные сделки.
import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const series = () => ({ setData: jest.fn(), attachPrimitive: jest.fn(), createPriceLine: jest.fn(), removePriceLine: jest.fn(), priceScale: () => ({ applyOptions: jest.fn() }), applyOptions: jest.fn(), priceToCoordinate: () => 0, coordinateToPrice: () => 0 });
jest.mock('lightweight-charts', () => ({
  createChart: () => ({
    addSeries: () => series(), removeSeries: jest.fn(), remove: jest.fn(), resize: jest.fn(), applyOptions: jest.fn(),
    subscribeCrosshairMove: jest.fn(), unsubscribeCrosshairMove: jest.fn(), subscribeClick: jest.fn(), unsubscribeClick: jest.fn(),
    panes: () => [1], removePane: jest.fn(),
    timeScale: () => ({ setVisibleLogicalRange: jest.fn(), fitContent: jest.fn(), logicalToCoordinate: () => 0, coordinateToLogical: () => 0 }),
  }),
  CrosshairMode: { Normal: 0 }, CandlestickSeries: 1, LineSeries: 2, AreaSeries: 3, HistogramSeries: 4, BaselineSeries: 5,
  createSeriesMarkers: () => ({ setMarkers: jest.fn() }),
}));

const mockUpdate = jest.fn();
jest.mock('../../context/AuthContext', () => ({ useAuth: () => ({ user: { uid: 'u1' }, userProfile: {}, updateUserProfile: mockUpdate }) }));
jest.mock('../../services/firebase', () => ({ db: {} }));

// 400 дневных свечей, цена плавно растёт: покупка со стопом ниже — прибыльная
const mockCandles = Array.from({ length: 400 }, (_, i) => {
  const base = 100 + i * 0.5;
  return { date: new Date(Date.UTC(2020, 0, 1) + i * 86400000), open: base, high: base + 1, low: base - 1, close: base + 0.4, volume: 1000 };
});
jest.mock('../../services/marketData/candles', () => ({
  TIMEFRAMES: { D1: { minutes: 1440, label: 'Д1', lookbackDays: 960 } },
  availableTimeframes: () => [{ key: 'D1', label: 'Д1', minutes: 1440 }],
  fetchDailyCandles: jest.fn(),
}));

const mockAdd = jest.fn();
const mockSaved = [];
jest.mock('../../services/trainer/trainerTrades', () => ({
  addTrainerTrade: (...a) => { mockSaved.push(a[1]); return mockAdd(...a); },
  updateTrainerTrade: jest.fn(),
  deleteTrainerTrade: jest.fn(),
  getTrainerTrades: jest.fn(),
}));

const Trainer = require('./Trainer').default;
const trainerTrades = require('../../services/trainer/trainerTrades');
const candlesSvc = require('../../services/marketData/candles');

const sleep = (ms) => act(async () => { await new Promise((r) => setTimeout(r, ms)); });
const click = (el) => act(async () => { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); });
const byText = (text, root = document.body) => [...root.querySelectorAll('button')].find((b) => b.textContent.trim() === text);
const setValue = (el, value) => act(async () => {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event('input', { bubbles: true }));
});

let host, root, errors, origError;
beforeEach(async () => {
  // CRA сбрасывает реализации заглушек перед каждым тестом (resetMocks) — задаём их заново
  mockUpdate.mockImplementation(async () => {});
  mockAdd.mockImplementation(async () => ({ id: 't1' }));
  trainerTrades.updateTrainerTrade.mockImplementation(async () => {});
  trainerTrades.deleteTrainerTrade.mockImplementation(async () => {});
  trainerTrades.getTrainerTrades.mockImplementation(async () => []);
  candlesSvc.fetchDailyCandles.mockImplementation(async () => mockCandles);
  mockSaved.length = 0;
  errors = []; origError = console.error; console.error = (...a) => { errors.push(String(a[0])); };
  jest.spyOn(Math, 'random').mockReturnValue(0);
  host = document.createElement('div'); document.body.appendChild(host);
  root = createRoot(host);
  await act(async () => { root.render(<Trainer />); });
});
afterEach(async () => {
  await act(async () => { root.unmount(); });
  host.remove();
  console.error = origError;
  jest.restoreAllMocks();
  expect(errors.filter((e) => !/act\(|ReactDOMTestUtils|React Router Future/.test(e))).toEqual([]);
});

test('страница тренажёра открывается на игре и говорит, что всё здесь учебное', () => {
  expect(host.querySelector('.page-title').textContent).toBe('Тренажёр');
  expect(host.textContent).toMatch(/не попадает/);
  expect(host.textContent).toContain('Какая фигура на графике?');
  expect([...host.querySelectorAll('.tr-tabs [role="tab"]')].map((t) => t.textContent)).toEqual(['Увидеть фигуру', 'Переигровка истории', 'Живые цены', 'Разбор']);
});

test('игра: ответ раскрывает разбор, показывает алгоритм и сохраняет прогресс в профиль', async () => {
  const options = [...host.querySelectorAll('.tr-options button')];
  expect(options.length).toBeGreaterThanOrEqual(2);
  await click(options[0]);
  expect(host.querySelector('.tr-verdict')).not.toBeNull();
  expect(host.textContent).toContain('Что увидел алгоритм приложения');
  expect(host.textContent).toMatch(/Как выглядит/);
  expect(mockUpdate).toHaveBeenCalledTimes(1);
  const saved = mockUpdate.mock.calls[0][0].trainerPatterns;
  expect(saved.answered).toBe(1);
  expect(saved.correct === 1 || saved.correct === 0).toBe(true);
  await click(byText('Следующий график'));
  expect(host.querySelector('.tr-options')).not.toBeNull();
});

test('переигровка: заявка → вход по открытию следующей свечи → ручное закрытие → запись в отдельную коллекцию', async () => {
  await click(byText('Переигровка истории', host));
  expect(host.textContent).toContain('Новая попытка');
  await click(byText('Начать с этим тикером'));
  await sleep(10);
  // история загружена: появилась панель заявки
  expect(host.textContent).toContain('Заявка');
  // без стопа заявка не ставится
  await click(byText('Купить'));
  expect(host.textContent).not.toContain('Заявка на покупку стоит');
  // стоп ниже цены — заявка ставится
  await setValue(host.querySelector('#tr-stop'), '150');
  await click(byText('Купить'));
  expect(host.textContent).toContain('Заявка на покупку стоит');
  // следующая свеча: заявка исполняется, появляется позиция
  await click(byText('Следующая свеча'));
  expect(host.textContent).toContain('Позиция: покупка');
  // закрываем вручную
  await click([...host.querySelectorAll('button')].find((b) => /^Закрыть по/.test(b.textContent.trim())));
  await sleep(10);
  expect(host.textContent).toContain('Результат');
  expect(mockAdd).toHaveBeenCalledTimes(1);
  const doc = mockSaved[0];
  expect(doc.dataMode).toBe('history');
  expect(doc.status).toBe('closed');
  expect(doc.exitReason).toBe('manual');
  expect(doc.side).toBe('long');
  expect(Number.isFinite(doc.r)).toBe(true);
  expect(doc.ticker).toBe('SBER');
  // слепой режим по умолчанию: пока шла игра, тикер не показывался; теперь раскрыт
  expect(host.querySelector('.tr-chart-head b').textContent).toBe('SBER');
});

test('разбор: показывает только учебные сделки и пояснение, что реальные сюда не входят', async () => {
  trainerTrades.getTrainerTrades.mockResolvedValueOnce([
    { id: 'a', kind: 'trainer', status: 'closed', dataMode: 'history', ticker: 'SBER', side: 'long', r: 1.5, exitReason: 'take', barsHeld: 4, strategyId: null },
    { id: 'b', kind: 'trainer', status: 'closed', dataMode: 'history', ticker: 'GAZP', side: 'short', r: -1, exitReason: 'stop', barsHeld: 2, strategyId: null },
  ]);
  await act(async () => { root.render(<Trainer key="again" />); });
  await sleep(10);
  await click(byText('Разбор', host));
  expect(host.textContent).toContain('Здесь только учебные сделки');
  expect(host.querySelectorAll('.tr-tile').length).toBe(6);
  expect(host.textContent).toMatch(/2/);          // 2 сделки
  expect(host.textContent).toContain('Мало данных (2 из 25)');
  expect(host.textContent).toContain('Пока 2 из 25 сделок');
  expect(host.querySelectorAll('.badge-purple').length).toBeGreaterThanOrEqual(2); // у каждой строки метка «Бумага»
});

test('живые цены: заявка сохраняется как ожидающая, учебная, живая', async () => {
  await click(byText('Живые цены', host));
  await click(byText('Загрузить график'));
  await sleep(10);
  expect(host.textContent).toContain('Последняя цена');
  await click(byText('Купить'));                                   // без стопа — не ставится
  expect(mockAdd).not.toHaveBeenCalled();
  await setValue(host.querySelector('#tr-live-stop'), '250');
  await click(byText('Купить'));
  await sleep(10);
  expect(mockAdd).toHaveBeenCalledTimes(1);
  const doc = mockSaved[0];
  expect(doc.status).toBe('pending');
  expect(doc.dataMode).toBe('live');
  expect(doc.kind).toBe('trainer');
  expect(doc.side).toBe('long');
  expect(doc.orderStop).toBe(250);
  expect(doc.tfMinutes).toBe(1440);
});

test('живые цены: открытие страницы дочитывает ожидающую сделку по свежим свечам и записывает итог', async () => {
  const orderBar = mockCandles[200].date.toISOString();
  const pending = {
    id: 'live1', kind: 'trainer', dataMode: 'live', status: 'pending', ticker: 'SBER', instrumentType: 'stock', timeframe: 'D1', tfMinutes: 1440,
    side: 'long', orderStop: 190, orderTake: 250, riskMoney: 1000, feePctPerSide: 0.05, orderPrice: 200, orderBarTime: orderBar, lastBarTime: orderBar,
    stopSchedule: [{ afterMs: 0, price: 190 }], strategyId: null, strategyName: null, stopMoves: [],
  };
  trainerTrades.getTrainerTrades.mockImplementation(async () => [pending]);
  await act(async () => { root.render(<Trainer key="live" />); });
  await sleep(10);
  await click(byText('Живые цены', host));
  await sleep(50);
  expect(host.textContent).toContain('Мои живые позиции');
  expect(trainerTrades.updateTrainerTrade).toHaveBeenCalled();
  const [id, body] = trainerTrades.updateTrainerTrade.mock.calls[0];
  expect(id).toBe('live1');
  expect(body.status).toBe('closed');
  expect(body.exitReason).toBe('take');
  expect(body.r).toBeGreaterThan(0);
  expect(body.id).toBeUndefined();
});
