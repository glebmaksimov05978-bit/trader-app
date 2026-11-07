// Надёжность загрузки и добавления в радар:
//  • fetchRetry — обрыв связи на телефоне («Load failed») не должен ронять график с первой попытки;
//  • checkTradable — истёкший фьючерс (MMU5) и несуществующий тикер распознаются при добавлении, а не ночью роботом;
//  • isRadarDuplicate — радар у каждой стратегии свой.
jest.mock('../tinkoff', () => ({ moneyToFloat: () => 0, TinkoffAPI: class {} }));

const { fetchRetry, describeLoadError } = require('./candles');
const { checkTradable } = require('./tradability');
const { isRadarDuplicate } = require('../radarRules');

const okResp = (body, status = 200) => ({ ok: status < 400, status, json: async () => body });

describe('fetchRetry', () => {
  afterEach(() => { delete global.fetch; });

  test('первая попытка оборвалась («Load failed»), вторая прошла — вернёт ответ', async () => {
    global.fetch = jest.fn().mockRejectedValueOnce(new TypeError('Load failed')).mockResolvedValueOnce(okResp({ a: 1 }));
    const r = await fetchRetry('https://x/y', undefined, { tries: 3 });
    expect(r.ok).toBe(true);
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('ошибка сервера 503 повторяется, обычный 404 — нет (его разбирает вызывающий)', async () => {
    global.fetch = jest.fn().mockResolvedValueOnce(okResp({}, 503)).mockResolvedValueOnce(okResp({ ok: 1 }));
    expect((await fetchRetry('https://x/y', undefined, { tries: 2 })).status).toBe(200);
    global.fetch = jest.fn().mockResolvedValue(okResp({}, 404));
    expect((await fetchRetry('https://x/y', undefined, { tries: 3 })).status).toBe(404);
    expect(global.fetch).toHaveBeenCalledTimes(1);
  });

  test('все попытки провалились — бросает последнюю ошибку', async () => {
    global.fetch = jest.fn().mockRejectedValue(new TypeError('Load failed'));
    await expect(fetchRetry('https://x/y', undefined, { tries: 2 })).rejects.toThrow('Load failed');
    expect(global.fetch).toHaveBeenCalledTimes(2);
  });

  test('«Load failed» превращается в понятный текст с подсказкой «Повторить»', () => {
    expect(describeLoadError(new TypeError('Load failed'))).toMatch(/Повторить/);
    expect(describeLoadError(new Error('Failed to fetch'))).toMatch(/Повторить/);
    expect(describeLoadError(new Error('Нет свечей по этому тикеру'))).toBe('Нет свечей по этому тикеру');
  });
});

describe('checkTradable', () => {
  const iss = (rows) => jest.fn().mockResolvedValue(okResp({ securities: { data: rows } }));

  test('действующая акция — ок, тип по данным биржи', async () => {
    const r = await checkTradable('sber', 'stock', { fetchImpl: iss([['SBER', 'Сбербанк', 1, 'stock_shares']]) });
    expect(r).toEqual({ ok: true, type: 'stock' });
  });

  test('истёкший фьючерс ММU5 — нельзя, предлагается корень MM (как делает ночной чистильщик)', async () => {
    const r = await checkTradable('MMU5', undefined, { fetchImpl: iss([['MMU5', 'MXI-9.25', 0, 'futures_forts']]) });
    expect(r.ok).toBe(false);
    expect(r.replaceWith).toBe('MM');
    expect(r.reason).toMatch(/MM/);
  });

  test('тип вводимого вручную тикера определяется по коду: MMU5 — фьючерс, а не акция', async () => {
    const r = await checkTradable('MMU5', undefined, { fetchImpl: iss([]) });
    expect(r.type).toBe('future');
  });

  test('такого тикера на бирже нет — нельзя, с понятной причиной', async () => {
    const r = await checkTradable('VTBRF', undefined, { fetchImpl: iss([]) });
    expect(r.ok).toBe(false);
    expect(r.reason).toMatch(/не найден/);
  });

  test('корень (BR, MM…) всегда подходит и сеть не трогает', async () => {
    const f = jest.fn();
    expect((await checkTradable('BR', 'future', { fetchImpl: f })).ok).toBe(true);
    expect(f).not.toHaveBeenCalled();
  });

  test('сеть или биржа не ответили — «не знаю», добавление не блокируется', async () => {
    expect(await checkTradable('SBER', 'stock', { fetchImpl: jest.fn().mockRejectedValue(new TypeError('Load failed')) })).toMatchObject({ ok: true, unknown: true });
    expect(await checkTradable('SBER', 'stock', { fetchImpl: jest.fn().mockResolvedValue(okResp({}, 500)) })).toMatchObject({ ok: true, unknown: true });
  });
});

describe('isRadarDuplicate — радар у каждой стратегии свой', () => {
  const items = [{ ticker: 'SBER', strategyId: 'a' }, { ticker: 'GAZP', strategyId: null }];

  test('тот же тикер в той же стратегии — дубль', () => {
    expect(isRadarDuplicate(items, 'sber', 'a')).toBe(true);
  });
  test('тот же тикер в другой стратегии — НЕ дубль (раньше мешал и нельзя было добавить «Моей стратегии»)', () => {
    expect(isRadarDuplicate(items, 'SBER', 'b')).toBe(false);
  });
  test('запись без стратегии считается записью активной стратегии', () => {
    expect(isRadarDuplicate(items, 'GAZP', 'a', 'a')).toBe(true);
    expect(isRadarDuplicate(items, 'GAZP', 'b', 'a')).toBe(false);
    expect(isRadarDuplicate(items, 'GAZP', null, 'a')).toBe(true);
  });
  test('пустой радар — не дубль', () => {
    expect(isRadarDuplicate([], 'SBER', 'a')).toBe(false);
    expect(isRadarDuplicate(null, 'SBER', 'a')).toBe(false);
  });
});
