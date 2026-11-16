import { applyApiVarMargin, vmOperationsFromApi, isAdjustable } from './varMarginApi';

const leg = (type, price, quantity, timestampUtc) => ({ type, price, quantity, timestampUtc });
function fut(ticker, direction, legs, rubPerPoint, commission = 0) {
  const sign = direction === 'long' ? 1 : -1;
  const opens = legs.filter((l) => l.type === 'open');
  const opened = opens.reduce((s, l) => s + l.quantity, 0);
  const entry = opens.reduce((s, l) => s + l.price * l.quantity, 0) / opened;
  const closes = legs.filter((l) => l.type === 'close');
  const closed = closes.reduce((s, l) => s + l.quantity, 0);
  const gross = closes.reduce((s, l) => s + (l.price - entry) * sign * l.quantity, 0) * rubPerPoint;
  return {
    ticker, isFuture: true, direction, legs, volume: opened, entryPrice: entry, commission, gross, rubPerPoint,
    status: closed >= opened ? 'closed' : 'partial', pnl: Math.round((gross - commission) * 100) / 100,
  };
}
const opts = { grossOf: (t) => t.gross, notionalOf: (t) => t.entryPrice * t.volume * t.rubPerPoint, asOf: Date.parse('2026-12-01T00:00:00Z') };
const op = (at, amount, ticker = null) => ({ at: Date.parse(at), amount, ticker });
const mv = (v) => ({ units: String(Math.trunc(v)), nano: Math.round((v - Math.trunc(v)) * 1e9), currency: 'rub' });

test('какие контракты могут расходиться с ходом цены', () => {
  expect(isAdjustable('SiZ6')).toBe(false);
  expect(isAdjustable('GZU5')).toBe(false);
  expect(isAdjustable('IMOEXF')).toBe(true);
  expect(isAdjustable('BRZ6')).toBe(true);
});

test('операции маржи из API: знак по типу, тикер если есть', () => {
  const ops = vmOperationsFromApi([
    { type: 'OPERATION_TYPE_WRITING_OFF_VARMARGIN', state: 'OPERATION_STATE_EXECUTED', date: '2026-11-03T15:50:00Z', payment: mv(-120.5) },
    { type: 'OPERATION_TYPE_ACCRUING_VARMARGIN', state: 'OPERATION_STATE_EXECUTED', date: '2026-11-02T15:50:00Z', payment: mv(300), ticker: 'imoexf' },
    { type: 'OPERATION_TYPE_BUY', date: '2026-11-02T10:00:00Z', payment: mv(-1) },
  ]);
  expect(ops).toEqual([
    { at: Date.parse('2026-11-02T15:50:00Z'), amount: 300, ticker: 'IMOEXF' },
    { at: Date.parse('2026-11-03T15:50:00Z'), amount: -120.5, ticker: null },
  ]);
});

test('по счёту: обычный контракт сошёлся — помечен сверенным без поправки', () => {
  const t = fut('SiZ6', 'long', [leg('open', 92000, 2, '2026-11-02T08:00:00Z'), leg('close', 92150, 2, '2026-11-02T09:00:00Z')], 1, 8);
  const { trades, report } = applyApiVarMargin([t], [op('2026-11-02T11:05:00Z', 300)], opts);
  expect(trades[0]).toMatchObject({ brokerVmChecked: true, brokerAdjustment: 0, pnl: 292 });
  expect(report[0]).toMatchObject({ applied: true, residual: 0 });
});

test('по счёту: вечный фьючерс через ночь получает фандинг, обычный рядом — нет', () => {
  const a = fut('IMOEXF', 'short', [leg('open', 2780, 17, '2026-11-02T06:00:00Z'), leg('close', 2737.5, 17, '2026-11-03T08:00:00Z')], 10, 100);
  const b = fut('SiZ6', 'long', [leg('open', 92000, 1, '2026-11-02T07:00:00Z'), leg('close', 92100, 1, '2026-11-02T12:00:00Z')], 1, 4);
  // ход: 7 225 + 100 = 7 325; брокер начислил 7 721,44 → поправка +396,44 целиком вечному
  const { trades, summary } = applyApiVarMargin([a, b], [op('2026-11-02T11:05:00Z', 4000), op('2026-11-02T15:55:00Z', 2721.44), op('2026-11-03T11:05:00Z', 1000)], opts);
  expect(trades[0].brokerAdjustment).toBe(396.44);
  expect(trades[0].pnl).toBe(7521.44);
  expect(trades[1].brokerAdjustment).toBe(0);
  expect(trades[1].pnl).toBe(96);
  expect(summary.mode).toBe('по счёту');
});

test('по контракту: каждая операция со своим тикером, сделки разных контрактов не смешиваются', () => {
  const a = fut('IMOEXF', 'long', [leg('open', 2700, 1, '2026-11-02T08:00:00Z'), leg('close', 2710, 1, '2026-11-03T08:00:00Z')], 10);
  const b = fut('BRZ6', 'long', [leg('open', 70, 1, '2026-11-02T08:00:00Z'), leg('close', 71, 1, '2026-11-02T09:00:00Z')], 800);
  const { trades, summary } = applyApiVarMargin([a, b], [
    op('2026-11-02T15:55:00Z', 60, 'IMOEXF'), op('2026-11-03T11:05:00Z', 25, 'IMOEXF'), op('2026-11-02T11:05:00Z', 812.3, 'BRZ6'),
  ], opts);
  expect(summary.mode).toBe('по контракту');
  expect(trades[0].brokerAdjustment).toBe(-15);
  expect(trades[1].brokerAdjustment).toBe(12.3);
});

test('обычные контракты не сходятся — значит, формат понят неверно: не правится ничего', () => {
  const mk = (day, ticker) => fut(ticker, 'long', [leg('open', 100, 1, `2026-11-${day}T08:00:00Z`), leg('close', 110, 1, `2026-11-${day}T09:00:00Z`)], 10);
  const list = [mk('02', 'SiZ6'), mk('03', 'GZZ6'), mk('04', 'IMOEXF')];
  const { trades, summary, report } = applyApiVarMargin(list, [op('2026-11-02T11:05:00Z', 55), op('2026-11-03T11:05:00Z', 31), op('2026-11-04T11:05:00Z', 90)], opts);
  expect(summary.blocked).toBe(true);
  expect(trades).toBe(list);
  expect(report.every((r) => !r.applied)).toBe(true);
});

test('клиринг ещё не прошёл или позиция открыта до периода — сделка не трогается', () => {
  const t = fut('IMOEXF', 'long', [leg('open', 2700, 1, '2026-11-30T08:00:00Z'), leg('close', 2710, 1, '2026-11-30T16:30:00Z')], 10);
  const early = applyApiVarMargin([t], [op('2026-11-30T11:05:00Z', 40)], opts);
  expect(early.trades[0].brokerVmChecked).toBeUndefined();
  expect(early.report[0].reason).toMatch(/клиринг/);
  const before = applyApiVarMargin([t], [op('2026-11-30T11:05:00Z', 40), op('2026-11-30T16:55:00Z', 70)], { ...opts, periodStart: Date.parse('2026-11-30T09:00:00Z') });
  expect(before.report[0].reason).toMatch(/раньше периода/);
});

test('закрыл одну позицию и тут же открыл другую: общий клиринг, сумма точная, деление помечено', () => {
  const a = fut('IMOEXF', 'short', [leg('open', 2783, 16, '2026-11-02T06:14:00Z'), leg('close', 2775, 16, '2026-11-03T13:16:00Z')], 10);
  const b = fut('IMOEXF', 'long', [leg('open', 2782, 20, '2026-11-03T13:18:00Z'), leg('close', 2831, 20, '2026-11-05T10:21:00Z')], 10);
  const ops = [op('2026-11-02T15:55:00Z', 4161.56), op('2026-11-03T15:55:00Z', -10883), op('2026-11-04T15:55:00Z', 6796.4), op('2026-11-05T11:05:00Z', 1800)];
  const { trades } = applyApiVarMargin([a, b], ops, opts);
  expect(Math.round((trades[0].pnl + trades[1].pnl) * 100) / 100).toBe(1874.96);
  expect(trades.every((t) => t.brokerVmShared)).toBe(true);
});

test('расхождение больше 5 % стоимости позиции не применяется', () => {
  const t = fut('IMOEXF', 'long', [leg('open', 2700, 1, '2026-11-02T08:00:00Z'), leg('close', 2710, 1, '2026-11-03T08:00:00Z')], 10);
  const { trades, report } = applyApiVarMargin([t], [op('2026-11-03T11:05:00Z', 5000)], opts);
  expect(trades[0].brokerVmChecked).toBeUndefined();
  expect(report[0].applied).toBe(false);
});

test('нет операций маржи — сделки возвращаются как были', () => {
  const t = fut('SiZ6', 'long', [leg('open', 1, 1, '2026-11-02T08:00:00Z'), leg('close', 2, 1, '2026-11-02T09:00:00Z')], 1);
  const list = [t];
  expect(applyApiVarMargin(list, [], opts).trades).toBe(list);
});
