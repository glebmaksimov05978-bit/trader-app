import { normalizeLegs, buildTradeMarks } from './tradeMarkers';

const colors = { green: 'g', red: 'r', gold: 'y', blue: 'b' };
const day = (n) => Date.UTC(2026, 10, n) / 1000;
const iso = (n, h = 10) => new Date(Date.UTC(2026, 10, n, h)).toISOString();
const candleTimes = [1, 2, 3, 4, 5, 6].map((n) => day(n));

test('сделка системы: закрытия есть, входа в операциях нет — вход дорисовывается', () => {
  const legs = normalizeLegs(
    [{ type: 'close', quantity: 4, price: 104, timestampUtc: iso(3) }, { type: 'close', quantity: 6, price: 108, timestampUtc: iso(5) }],
    { date: iso(2), price: 100, quantity: 10 }, null,
  );
  const { markers, fillsByBar } = buildTradeMarks({ legs, direction: 'long', candleTimes, colors });
  expect(markers.map((m) => [m.time, m.shape, m.text])).toEqual([
    [day(2), 'arrowUp', 'Вход'], [day(3), 'arrowDown', 'Часть'], [day(5), 'arrowDown', 'Выход'],
  ]);
  expect(markers[0].position).toBe('belowBar');
  expect(markers.map((m) => m.color)).toEqual(['g', 'r', 'r']);
  expect(fillsByBar.get(day(3))[0].action).toBe('Частичный выход');
});

test('открытая сделка с одной частичной фиксацией: выхода нет', () => {
  const legs = normalizeLegs([{ type: 'close', quantity: 4, price: 104, timestampUtc: iso(3) }], { date: iso(2), price: 100, quantity: 10 }, null);
  const { markers } = buildTradeMarks({ legs, direction: 'long', candleTimes, colors });
  expect(markers.map((m) => m.text)).toEqual(['Вход', 'Часть']);
});

test('без операций: вход и выход из дат сделки; объём неизвестен — выход по признаку «закрыта»', () => {
  const legs = normalizeLegs(null, { date: iso(2), price: 100, quantity: 3 }, { date: iso(4), price: 95 });
  const { markers } = buildTradeMarks({ legs, direction: 'short', candleTimes, colors, closed: true });
  expect(markers.map((m) => [m.shape, m.position, m.text])).toEqual([
    ['arrowDown', 'aboveBar', 'Вход'], ['arrowUp', 'belowBar', 'Выход'],
  ]);
});

test('вход и выход внутри одной свечи — две метки, а не одна «Операции»', () => {
  const legs = [
    { type: 'open', quantity: 5, price: 100, timestampUtc: iso(3, 8) },
    { type: 'open', quantity: 5, price: 101, timestampUtc: iso(3, 9) },
    { type: 'close', quantity: 10, price: 103, timestampUtc: iso(3, 12) },
  ];
  const { markers } = buildTradeMarks({ legs, direction: 'long', candleTimes, colors });
  expect(markers.map((m) => m.text).sort()).toEqual(['Вход ×2', 'Выход']);
});

test('подписи выключены — остаются только значки', () => {
  const legs = normalizeLegs(null, { date: iso(2), price: 100, quantity: 1 }, { date: iso(4), price: 105, quantity: 1 });
  const { markers } = buildTradeMarks({ legs, direction: 'long', candleTimes, colors, showLabels: false });
  expect(markers).toHaveLength(2);
  expect(markers.every((m) => m.text === '')).toBe(true);
});

test('операция раньше первой свечи на графике не рисуется на чужой свече', () => {
  const legs = normalizeLegs(null, { date: new Date(Date.UTC(2026, 9, 1)).toISOString(), price: 100, quantity: 1 }, null);
  expect(buildTradeMarks({ legs, direction: 'long', candleTimes, colors }).markers).toEqual([]);
});

test('готовые операции с входом не дублируются датами сделки', () => {
  const legs = normalizeLegs([{ type: 'open', quantity: 2, price: 100, timestampUtc: iso(2) }], { date: iso(1), price: 99, quantity: 2 }, null);
  expect(legs).toHaveLength(1);
});
