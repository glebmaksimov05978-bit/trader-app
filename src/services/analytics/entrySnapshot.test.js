import { entrySnapshot } from './entrySnapshot';

test('условия: только применимые, с отметкой сошлось/нет; значения индикаторов — плоско и без undefined', () => {
  const snap = entrySnapshot({
    results: [
      { id: 'rsi_above', label: 'RSI выше 60', passed: true, detail: 'RSI 64.2' },
      { id: 'vol', label: 'Объём выше среднего', passed: false },
      { id: 'only_short', label: 'Только шорт', na: true },
      { id: 'c1', label: 'Новость проверена', custom: true, passed: undefined, detail: undefined },
    ],
    indicators: { date: new Date(), close: 301.123456789, rsi14: 64.2, macdHistogram: null, atr14: undefined, bollinger: { upper: 310, lower: 290, mid: undefined }, list: [1, 2] },
    marketContext: { trend: 'up', aboveSma200: true, nested: { adx: 27.5 }, nan: NaN },
  });
  expect(snap.entryConditions).toEqual([
    { id: 'rsi_above', label: 'RSI выше 60', passed: true, detail: 'RSI 64.2' },
    { id: 'vol', label: 'Объём выше среднего', passed: false },
    { id: 'c1', label: 'Новость проверена', passed: false, custom: true },
  ]);
  expect(snap.entryIndicators).toEqual({ close: 301.12346, rsi14: 64.2, bollinger_upper: 310, bollinger_lower: 290 });
  expect(snap.entryMarketContext).toEqual({ trend: 'up', aboveSma200: true, nested_adx: 27.5 });
  expect(JSON.stringify(snap)).not.toMatch(/undefined|NaN|null/);
});

test('пустые входные данные не роняют робота', () => {
  expect(entrySnapshot({})).toEqual({ entryConditions: [], entryIndicators: {}, entryMarketContext: {} });
});
