import { strategyReadiness } from './strategyReadiness';

const full = {
  id: 's1', name: 'Пробой', horizon: 'medium', timeframe: 'H1', followed: true,
  conditions: [{ id: 'rsi_below', enabled: true, param: 35 }, { id: 'min_rr', enabled: true, param: 2 }],
  customConditions: [{ id: 'c1', label: 'нет новостей' }],
  exitRules: { stopType: 'atr', stopAtrMult: 1.5, takeType: 'pct', takePct: 4, trailEnabled: false },
};

test('полностью настроенная стратегия с сигналами — «работает»', () => {
  const r = strategyReadiness(full, {
    radarItems: [{ ticker: 'SBER', strategyId: 's1' }],
    paperTrades: [{ entryStrategyId: 's1', status: 'open' }, { entryStrategyId: 's2', status: 'open' }],
  });
  expect(r.ready).toBe(true);
  expect(r.done).toBe(6);
  expect(r.nextStep).toBeNull();
  expect(r.steps.find((x) => x.id === 'working').detail).toBe('Сделок системы: 1, открыто 1');
  expect(r.steps.find((x) => x.id === 'entry').detail).toMatch(/1 — робот проверяет их сам; ещё 1 своих/);
});

test('по шагам: чего не хватает', () => {
  const bare = { id: 's2', name: 'Новая', conditions: [], customConditions: [{ id: 'c', label: 'на глаз' }], exitRules: { stopType: 'none', takeType: 'none' } };
  const r = strategyReadiness(bare, { radarItems: [{ ticker: 'GAZP' }], activeStrategyId: 's2' });
  expect(r.ready).toBe(false);
  expect(r.nextStep.id).toBe('timeframe');
  const by = Object.fromEntries(r.steps.map((x) => [x.id, x.ok]));
  expect(by).toEqual({ timeframe: false, entry: false, stop: false, exit: false, radar: true, robot: false, working: false });
  expect(r.steps.find((x) => x.id === 'entry').detail).toMatch(/Только свои условия/);
});

test('робот включён списком из Настроек, выход — только следящий', () => {
  const s = { ...full, followed: false, exitRules: { stopType: 'pct', stopPct: 2, takeType: 'none', trailEnabled: true } };
  const r = strategyReadiness(s, { paperStrategyIds: ['s1'], radarItems: [{ strategyId: 's1' }] });
  expect(r.steps.find((x) => x.id === 'robot').ok).toBe(true);
  expect(r.steps.find((x) => x.id === 'exit').detail).toBe('следящий выход');
  expect(r.ready).toBe(true);
  expect(r.steps.find((x) => x.id === 'working').ok).toBe(false);
});

test('стоп выключен намеренно при следящем выходе — не пробел', () => {
  const s = { ...full, exitRules: { stopType: 'none', takeType: 'none', trailEnabled: true, trailAdverseEnabled: true } };
  const st = strategyReadiness(s, { radarItems: [{ strategyId: 's1' }] }).steps.find((x) => x.id === 'stop');
  expect(st.ok).toBe(true);
  expect(st.detail).toMatch(/намеренно/);
});
