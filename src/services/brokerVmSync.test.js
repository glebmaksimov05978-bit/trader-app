import { planVmSync, vmSyncCandidates } from './brokerVmSync';
import { tradeConfirmation, isBrokerConfirmed } from './tradeConfirmation';

const mv = (v) => ({ units: String(Math.trunc(v)), nano: Math.round((v - Math.trunc(v)) * 1e9), currency: 'rub' });
const NOW = Date.parse('2026-11-20T00:00:00Z');
const FROM = Date.parse('2026-11-01T00:00:00Z');
const vm = (date, amount, ticker) => ({
  type: amount < 0 ? 'OPERATION_TYPE_WRITING_OFF_VARMARGIN' : 'OPERATION_TYPE_ACCRUING_VARMARGIN',
  state: 'OPERATION_STATE_EXECUTED', date, payment: mv(amount), ...(ticker ? { ticker } : {}),
});
const deal = (type, ticker, date, qty, price) => ({
  id: `${type}${date}`, type: `OPERATION_TYPE_${type}`, state: 'OPERATION_STATE_EXECUTED', instrumentType: 'futures', ticker, date,
  quantity: String(qty), quantityRest: '0', price: mv(price), payment: mv(0),
});
// Сделка, открытая и закрытая заявками из приложения: шорт 17 IMOEXF, ход 7 225 ₽, комиссия 100 → результат 7 125.
const appTrade = {
  id: 't1', ticker: 'IMOEXF', instrumentType: 'future', direction: 'short', status: 'closed', volume: 17, entryPrice: 2780,
  minStep: 0.5, minStepAmount: 5, pnl: 7125, commission: 100, orderId: 'o1', closedAt: '2026-11-03T08:00:00Z',
  legs: [
    { type: 'open', quantity: 17, price: 2780, timestampUtc: '2026-11-02T06:00:00Z', source: 'order' },
    { type: 'close', quantity: 17, price: 2737.5, timestampUtc: '2026-11-03T08:00:00Z', source: 'order' },
  ],
};
const brokerDeals = [deal('SELL', 'IMOEXF', '2026-11-02T06:00:00Z', 17, 2780), deal('BUY', 'IMOEXF', '2026-11-03T08:00:00Z', 17, 2737.5)];

test('кандидаты на сверку: закрытые фьючерсы без отметки', () => {
  expect(vmSyncCandidates([appTrade, { ...appTrade, id: 't2', brokerVmChecked: true }, { ...appTrade, id: 't3', instrumentType: 'stock' }, { ...appTrade, id: 't4', status: 'open' }], NOW).map((t) => t.id)).toEqual(['t1']);
});

test('сделка из приложения получает фандинг из маржи Т-Банка', () => {
  const plan = planVmSync({ trades: [appTrade], vmItems: [vm('2026-11-02T15:55:00Z', 6621.44), vm('2026-11-03T11:05:00Z', 1000)], tradeItems: brokerDeals, from: FROM, to: NOW, now: NOW });
  expect(plan.updates).toHaveLength(1);
  expect(plan.updates[0]).toMatchObject({ id: 't1', patch: { pnl: 7521.44, brokerAdjustment: 396.44, brokerVmChecked: true } });
});

test('в Журнале не все сделки (у брокера есть лишняя) — при марже «по счёту» ничего не правится', () => {
  const plan = planVmSync({
    trades: [appTrade], vmItems: [vm('2026-11-02T15:55:00Z', 6621.44), vm('2026-11-03T11:05:00Z', 1000)],
    tradeItems: [...brokerDeals, deal('BUY', 'SiZ6', '2026-11-02T07:00:00Z', 1, 92000)], from: FROM, to: NOW, now: NOW,
  });
  expect(plan.updates).toHaveLength(0);
  expect(plan.summary.reason).toMatch(/не все фьючерсные сделки/);
  expect(plan.mismatched).toEqual(['SIZ6']);
});

test('маржа «по контракту»: чужой контракт не мешает сверить свой', () => {
  const plan = planVmSync({
    trades: [appTrade], vmItems: [vm('2026-11-02T15:55:00Z', 6621.44, 'IMOEXF'), vm('2026-11-03T11:05:00Z', 1000, 'IMOEXF'), vm('2026-11-02T15:55:00Z', 50, 'SIZ6')],
    tradeItems: [...brokerDeals, deal('BUY', 'SiZ6', '2026-11-02T07:00:00Z', 1, 92000)], from: FROM, to: NOW, now: NOW,
  });
  expect(plan.updates.map((u) => u.patch.brokerAdjustment)).toEqual([396.44]);
});

test('уже сверенная сделка второй раз не меняется', () => {
  const done = { ...appTrade, pnl: 7521.44, brokerAdjustment: 396.44, brokerVmChecked: true };
  const plan = planVmSync({ trades: [done], vmItems: [vm('2026-11-02T15:55:00Z', 6621.44), vm('2026-11-03T11:05:00Z', 1000)], tradeItems: brokerDeals, from: FROM, to: NOW, now: NOW });
  expect(plan.updates).toHaveLength(0);
});

test('метка «подтверждена брокером / вручную»', () => {
  expect(tradeConfirmation(appTrade).level).toBe('broker');                                              // заявки из приложения
  expect(tradeConfirmation({ status: 'closed', dataSource: 'imported', sourceTransactionIds: ['1'] }).level).toBe('broker');
  expect(tradeConfirmation({ status: 'closed', dataSource: 'manual', legs: [] }).level).toBe('manual');
  // вход заявкой, а закрытие записано руками
  const mixed = { ...appTrade, legs: [appTrade.legs[0], { ...appTrade.legs[1], source: 'manual' }] };
  expect(tradeConfirmation(mixed)).toMatchObject({ level: 'manual' });
  expect(tradeConfirmation({ ...mixed, brokerVmChecked: true }).level).toBe('broker');
  expect(tradeConfirmation({ status: 'pending' })).toBeNull();
  expect(isBrokerConfirmed({ status: 'open', orderId: 'x', legs: [] })).toBe(true);
});
