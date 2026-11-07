import {
  decodeExample, splitExample, pickNext, buildOptions, emptyRealProgress, applyVerdict, realSummary, movementText,
} from './realPatterns';

const raw = {
  id: 'SBER-20000-double_top', t: 'SBER', truth: 'double_top', det: 'double_top', conf: 72, cut: 2,
  d0: 20000, dd: [1, 1, 3, 1],
  b: [[10, 11, 9, 10.5], [10.5, 12, 10, 11], [11, 13, 10.8, 12], [12, 12.5, 11, 11.2], [11.2, 11.4, 10, 10.1]],
  pts: [[0, 11, 'high'], [2, 13, 'high'], [9, 5, 'low']],
  up: 0.4, down: 3.1,
};

describe('decodeExample / splitExample', () => {
  test('даты восстанавливаются по разностям в днях (пропуск выходных), свечи и точки на месте', () => {
    const ex = decodeExample(raw);
    expect(ex.candles).toHaveLength(5);
    const days = ex.candles.map((c) => Math.round(c.date.getTime() / 86400000));
    expect(days).toEqual([20000, 20001, 20002, 20005, 20006]);
    expect(ex.candles[1]).toMatchObject({ open: 10.5, high: 12, low: 10, close: 11 });
    expect(ex.points.map((p) => p.index)).toEqual([0, 2]); // точка за пределами данных отброшена
    expect(ex.ticker).toBe('SBER');
  });
  test('видимая часть кончается на cut, остальное — скрытое продолжение', () => {
    const { visible, hidden } = splitExample(decodeExample(raw));
    expect(visible).toHaveLength(3);
    expect(hidden).toHaveLength(2);
  });
  test('мусор не роняет', () => {
    expect(decodeExample(null)).toBeNull();
    expect(decodeExample({ b: [] })).toBeNull();
  });
});

describe('pickNext', () => {
  const items = [{ id: 'a', truth: 'x' }, { id: 'b', truth: 'x' }, { id: 'c', truth: 'y' }];
  test('не показывает уже виденные, пока есть новые', () => {
    for (let i = 0; i < 20; i++) expect(['c']).toContain(pickNext(items, { seen: ['a', 'b'] }).id);
  });
  test('не повторяет подряд ту же фигуру, если есть выбор', () => {
    for (let i = 0; i < 20; i++) expect(pickNext(items, { lastTruth: 'x' }).truth).toBe('y');
  });
  test('все виденные — круг начинается заново; пустой набор — null', () => {
    expect(pickNext(items, { seen: ['a', 'b', 'c'] })).not.toBeNull();
    expect(pickNext([], {})).toBeNull();
  });
  test('фильтр по фигуре', () => {
    expect(pickNext(items, { only: 'y' }).id).toBe('c');
  });
});

describe('buildOptions', () => {
  test('есть ответ алгоритма и «фигуры нет», без повторов', () => {
    const o = buildOptions('double_top');
    expect(o).toContain('double_top');
    expect(o).toContain('none');
    expect(new Set(o).size).toBe(o.length);
    expect(o.length).toBeGreaterThanOrEqual(4);
  });
});

describe('согласие с алгоритмом', () => {
  test('счёт и разбивка по фигурам', () => {
    let p = emptyRealProgress();
    p = applyVerdict(p, { truth: 'double_top' }, 'double_top').progress;
    const r2 = applyVerdict(p, { truth: 'double_top' }, 'none');
    expect(r2.agree).toBe(false);
    const s = realSummary(r2.progress);
    expect(s.n).toBe(2);
    expect(s.agreement).toBe(0.5);
    expect(s.rows[0]).toMatchObject({ id: 'double_top', n: 2, agree: 1 });
  });
  test('спорные — только при 4+ ответах и согласии реже половины', () => {
    let p = emptyRealProgress();
    for (let i = 0; i < 4; i++) p = applyVerdict(p, { truth: 'wedge_rising' }, 'none').progress;
    for (let i = 0; i < 4; i++) p = applyVerdict(p, { truth: 'double_top' }, 'double_top').progress;
    p = applyVerdict(p, { truth: 'flag_bull' }, 'none').progress;
    expect(realSummary(p).disputed.map((r) => r.id)).toEqual(['wedge_rising']);
  });
  test('исходный прогресс не меняется, пустой — без падения', () => {
    const p0 = emptyRealProgress();
    applyVerdict(p0, { truth: 'x' }, 'x');
    expect(p0.n).toBe(0);
    expect(realSummary(null).agreement).toBeNull();
  });
});

test('текст про движение: направление и размер в ATR', () => {
  expect(movementText({ up: 0.4, down: 3.1 })).toMatch(/вниз на 3,1 ATR/);
  expect(movementText({ up: 4, down: 1 })).toMatch(/вверх на 4 ATR/);
});
