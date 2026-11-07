import { describeLegs, weightedPrice, legDate } from './tradeLegs';

const t = (s) => new Date(`2026-10-${s}:00Z`);

test('вход, докупка, частичная фиксация и выход — по порядку времени и с понятными названиями', () => {
  const rows = describeLegs([
    { type: 'close', quantity: 1, price: 110, timestampUtc: t('12T10:00') },
    { type: 'open', quantity: 2, price: 100, timestampUtc: t('10T10:00') },
    { type: 'open', quantity: 2, price: 104, timestampUtc: t('11T10:00') },
    { type: 'close', quantity: 3, price: 112, timestampUtc: t('13T10:00') },
  ]);
  expect(rows.map((r) => r.action)).toEqual(['Вход', 'Докупка', 'Частичный выход', 'Выход']);
  expect(rows.map((r) => r.kind)).toEqual(['open', 'add', 'partial', 'exit']);
});

test('если закрыт весь объём одной операцией — это «Выход», а не частичный', () => {
  const rows = describeLegs([
    { type: 'open', quantity: 5, price: 100, timestampUtc: t('10T10:00') },
    { type: 'close', quantity: 5, price: 90, timestampUtc: t('11T10:00') },
  ]);
  expect(rows[1].action).toBe('Выход');
});

test('открытая сделка без выхода: только вход и частичные фиксации', () => {
  const rows = describeLegs([
    { type: 'open', quantity: 4, price: 100, timestampUtc: t('10T10:00') },
    { type: 'close', quantity: 1, price: 108, timestampUtc: t('11T10:00') },
  ]);
  expect(rows.map((r) => r.action)).toEqual(['Вход', 'Частичный выход']);
});

test('время из Timestamp Firestore и строки читается; мусор и пустое — null; нет операций — пустой список', () => {
  expect(legDate({ seconds: 1760000000 }).getTime()).toBe(1760000000000);
  expect(legDate('2026-10-10T10:00:00Z') instanceof Date).toBe(true);
  expect(legDate('мусор')).toBeNull();
  expect(legDate(null)).toBeNull();
  expect(describeLegs(undefined)).toEqual([]);
  expect(describeLegs([{ type: 'dividend', quantity: 1 }])).toEqual([]);
});

test('средняя цена взвешена по объёму', () => {
  expect(weightedPrice([{ price: 100, quantity: 2 }, { price: 106, quantity: 1 }])).toBeCloseTo(102);
  expect(weightedPrice([])).toBeNull();
});
