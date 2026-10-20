import React from 'react';
import { createRoot } from 'react-dom/client';
import { act } from 'react-dom/test-utils';

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
jest.mock('../context/AuthContext', () => ({ useAuth: () => ({ userProfile: {}, updateUserProfile: async () => {} }) }));
jest.mock('../services/firebase', () => ({ db: {} }));
jest.mock('../services/marketData/candles', () => ({ TIMEFRAMES: { D1: { minutes: 1440, label: 'Д1' } } }));

const CandleChart = require('./shared/CandleChart').default;

test('график монтируется, переходит в полный экран и обратно без ошибок', async () => {
  const candles = Array.from({ length: 60 }, (_, i) => ({ date: new Date(Date.UTC(2026, 0, 1 + i)), open: 100 + i, high: 102 + i, low: 98 + i, close: 101 + i, volume: 10 }));
  const host = document.createElement('div'); document.body.appendChild(host);
  const root = createRoot(host);
  const errors = [];
  const orig = console.error; console.error = (...a) => { errors.push(String(a[0])); };
  await act(async () => { root.render(<CandleChart candles={candles} patterns={null} ticker="SBER" timeframe="D1" drawingTools />); });
  expect(host.querySelector('.cc-draw')).not.toBeNull();
  const btn = [...host.querySelectorAll('button')].find((b) => b.title === 'На весь экран');
  await act(async () => { btn.click(); });
  expect(document.body.querySelector('.cc-draw')).not.toBeNull();
  await act(async () => { [...document.body.querySelectorAll('button')].find((b) => b.title === 'Свернуть').click(); });
  expect(host.querySelector('.cc-draw')).not.toBeNull();
  console.error = orig;
  expect(errors.filter((e) => !/act\(|ReactDOMTestUtils/.test(e))).toEqual([]);
});
