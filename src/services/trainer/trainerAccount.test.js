import { accountState, getTrainerAccount, doneAt } from './trainerAccount';

const tr = (pnl, createdAt, extra = {}) => ({ kind: 'trainer', status: 'closed', pnlVirtual: pnl, createdAt, ...extra });

test('настройки счёта: значения по умолчанию и из профиля', () => {
  expect(getTrainerAccount({})).toEqual({ startCapital: 100000, riskPct: 1, startedAt: null });
  expect(getTrainerAccount({ trainerAccount: { startCapital: 50000, riskPct: 2 } }).startCapital).toBe(50000);
  expect(getTrainerAccount({ trainerAccount: { startCapital: -1, riskPct: 500 } })).toEqual({ startCapital: 100000, riskPct: 1, startedAt: null });
});

test('баланс, доходность, просадка и риск следующей сделки — от текущего баланса', () => {
  const trades = [
    tr(2000, '2026-11-01T10:00:00Z'),
    tr(-3000, '2026-11-02T10:00:00Z'),
    tr(-1000, '2026-11-03T10:00:00Z'),
    tr(500, '2026-11-04T10:00:00Z'),
    { kind: 'trainer', status: 'open', pnlVirtual: 999, createdAt: '2026-11-05T10:00:00Z' },
  ];
  const s = accountState(trades, { startCapital: 100000, riskPct: 1 });
  expect(s.balance).toBe(98500);
  expect(s.pnl).toBe(-1500);
  expect(s.returnPct).toBeCloseTo(-1.5, 6);
  expect(s.maxDd).toBe(4000);          // пик 102 000 → 98 000
  expect(s.maxDdPct).toBeCloseTo((4000 / 102000) * 100, 6);
  expect(s.count).toBe(4);
  expect(s.wins).toBe(2);
  expect(s.riskNow).toBe(985);
});

test('«начать заново»: учитываются только сделки после старта; живые — по времени выхода', () => {
  const live = tr(700, '2026-11-01T10:00:00Z', { dataMode: 'live', exitDate: '2026-11-10T12:00:00Z' });
  expect(doneAt(live)).toBe(Date.parse('2026-11-10T12:00:00Z'));
  const s = accountState([tr(5000, '2026-11-02T10:00:00Z'), live], { startCapital: 10000, riskPct: 2, startedAt: '2026-11-05T00:00:00Z' });
  expect(s.count).toBe(1);
  expect(s.balance).toBe(10700);
  expect(s.riskNow).toBe(214);
});

test('пробные сделки по сигналам в учебный счёт не входят', () => {
  const s = accountState([tr(1000, '2026-11-02T10:00:00Z'), tr(-500, '2026-11-03T10:00:00Z', { fromSignal: true })], { startCapital: 10000, riskPct: 1 });
  expect(s.count).toBe(1);
  expect(s.balance).toBe(11000);
});
