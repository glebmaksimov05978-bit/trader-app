import { buildExitReplay, barIndexAt, rubPerUnitMove } from './exitReplay';

// Дневные свечи 1–10 ноября. Лонг 10 лотов по 100 (лот 10 → 100 ₽ за пункт на весь объём), стоп 95, выход 104 на 4-й свече.
const day = (d) => `2026-11-${String(d).padStart(2, '0')}T07:00:00Z`;
const bars = [
  { date: day(1), open: 99, high: 101, low: 98, close: 100 },
  { date: day(2), open: 100, high: 103, low: 99, close: 102 },
  { date: day(3), open: 102, high: 108, low: 101, close: 107 },
  { date: day(4), open: 107, high: 107, low: 103, close: 104 },
  { date: day(5), open: 104, high: 105, low: 96, close: 97 },
  { date: day(6), open: 96, high: 97, low: 93, close: 94 },
  { date: day(7), open: 94, high: 112, low: 94, close: 111 },
];
const trade = {
  direction: 'long', entryPrice: 100, exitPrice: 104, stopLoss: 95, volume: 10, lot: 10, instrumentType: 'stock',
  status: 'closed', commission: 20.4, pnl: 379.6, // (104−100)×100 = 400 − комиссия 20,4
};

test('номер свечи по времени', () => {
  expect(barIndexAt(bars, '2026-11-01T10:00:00Z')).toBe(0);
  expect(barIndexAt(bars, '2026-11-04T12:00:00Z')).toBe(3);
  expect(barIndexAt(bars, '2026-10-30T10:00:00Z')).toBe(-1);
});

test('рубли за ход цены выводятся из факта сделки', () => {
  const { k, source } = rubPerUnitMove(trade);
  expect(source).toBe('fact');
  expect(k).toBeCloseTo(100, 6);
});

test('переигровка: факт, лучшая/худшая цена, «если выйти здесь», стоп, после выхода', () => {
  const r = buildExitReplay({ trade, candles: bars, openedAt: new Date('2026-11-01T10:00:00Z'), closedAt: new Date('2026-11-04T12:00:00Z') });
  expect(r.entryIdx).toBe(0);
  expect(r.exitIdx).toBe(3);
  // Фактический выход по цене 104 даёт ровно результат сделки.
  expect(r.actual.rub).toBeCloseTo(379.6, 2);
  expect(r.actual.r).toBeCloseTo(0.8, 6);
  // Лучшая цена в сделке — 108 на 3-й свече: +8 R·0,2 = 1,6R, рублей ≈ 800 − комиссия.
  expect(r.inTrade.best.price).toBe(108);
  expect(r.inTrade.best.r).toBeCloseTo(1.6, 6);
  expect(r.captured).toBeCloseTo(0.5, 6);
  // Худшая — 98 на свече входа.
  expect(r.inTrade.worst.price).toBe(98);
  // Если выйти по закрытию 3-й свечи (107): +700 ₽ до комиссии.
  const x = r.exitAtBar(2);
  expect(x.price).toBe(107);
  expect(x.rub).toBeCloseTo(700 - 20.4 * (207 / 204), 2);
  // Стоп 95 задет на 6-й свече (минимум 93), открытие 96 — выше стопа, значит по цене стопа.
  expect(r.stopHit.idx).toBe(5);
  expect(r.stopHit.price).toBe(95);
  expect(r.stopHit.r).toBeCloseTo(-1, 6);
  // После выхода цена доходила до 112.
  expect(r.afterExit.best.price).toBe(112);
  expect(r.barsAfterExit).toBe(3);
  // Ползунок не уходит раньше входа и дальше последней свечи.
  expect(r.exitAtBar(-5).idx).toBe(0);
  expect(r.exitAtBar(99).idx).toBe(6);
});

test('шорт: стоп выше, лучшая цена — минимум', () => {
  const s = { ...trade, direction: 'short', entryPrice: 107, exitPrice: 97, stopLoss: 110, pnl: 980, commission: 20 };
  const r = buildExitReplay({ trade: s, candles: bars, openedAt: new Date(day(3)), closedAt: new Date('2026-11-05T12:00:00Z') });
  expect(r.inTrade.best.price).toBe(96);
  expect(r.actual.rub).toBeCloseTo(980, 2);
  expect(r.stopHit.idx).toBe(6); // 7-я свеча: максимум 112 ≥ 110
  expect(r.stopHit.price).toBe(110);
});

test('без стопа R не считается, без свечей — пусто', () => {
  const r = buildExitReplay({ trade: { ...trade, stopLoss: null }, candles: bars, openedAt: new Date(day(1)), closedAt: new Date(day(4)) });
  expect(r.riskPerUnit).toBeNull();
  expect(r.exitAtBar(2).r).toBeNull();
  expect(r.stopHit).toBeNull();
  expect(buildExitReplay({ trade, candles: [], openedAt: new Date(day(1)) })).toBeNull();
});

test('поправка брокера (фандинг) не попадает в «рубли за ход»', () => {
  const t = { ...trade, pnl: 379.6 - 50, brokerAdjustment: -50 };
  expect(rubPerUnitMove(t).k).toBeCloseTo(100, 6);
  const r = buildExitReplay({ trade: t, candles: bars, openedAt: new Date(day(1)), closedAt: new Date('2026-11-04T12:00:00Z') });
  expect(r.actual.rub).toBeCloseTo(379.6, 2); // по ценам, без фандинга
});
