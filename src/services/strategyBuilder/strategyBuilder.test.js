import { FEATURES, emptySpec, newCondition, validateSpec, paperOnlyReasons, describeCondition, instrumentClassOf, futureGroupOf } from './ruleSpec';
import { featureSeries, supertrend, nearestLevelsSlow } from './features';
import { prepareData, evaluateCondition, evaluateAt, scanSignals, lastClosedIndex } from './evaluate';
import { matchJournal } from './journalMatch';

// --- синтетические свечи (детерминированные) ---
function rng(seed) {
  let s = seed >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 2 ** 32; };
}

// Часовые свечи 10:00–18:00 МСК (07–15 UTC), будни, со случайным блужданием и гэпами между днями.
function hourly(days = 70, seed = 7) {
  const r = rng(seed);
  const out = [];
  let price = 100;
  const d0 = Date.UTC(2026, 0, 5); // понедельник
  for (let d = 0; d < days * 1.5 && out.length < days * 9; d++) {
    const day = new Date(d0 + d * 86400000);
    const wd = day.getUTCDay();
    if (wd === 0 || wd === 6) continue;
    price *= 1 + (r() - 0.5) * 0.02; // гэп на открытии
    for (let h = 7; h <= 15; h++) {
      const open = price;
      price *= 1 + (r() - 0.48) * 0.012;
      const close = price;
      out.push({
        date: new Date(day.getTime() + h * 3600000),
        open, close,
        high: Math.max(open, close) * (1 + r() * 0.004),
        low: Math.min(open, close) * (1 - r() * 0.004),
        volume: Math.round(1000 + r() * 4000),
      });
    }
  }
  return out;
}

function fromCloses(closes, stepMin = 60, start = Date.UTC(2026, 0, 5, 7)) {
  return closes.map((c, i) => {
    const open = i ? closes[i - 1] : c;
    return { date: new Date(start + i * stepMin * 60000), open, close: c, high: Math.max(open, c) + 0.5, low: Math.min(open, c) - 0.5, volume: 1000 };
  });
}

// Дневные свечи из часовых (для проверки старшего таймфрейма): дата — 00:00 МСК дня.
function dailyFrom(h) {
  const byDay = new Map();
  for (const c of h) {
    const key = new Date(c.date.getTime() + 3 * 3600000).toISOString().slice(0, 10);
    const cur = byDay.get(key);
    if (!cur) byDay.set(key, { date: new Date(`${key}T00:00:00+03:00`), open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume });
    else { cur.high = Math.max(cur.high, c.high); cur.low = Math.min(cur.low, c.low); cur.close = c.close; cur.volume += c.volume; }
  }
  return [...byDay.values()];
}

const same = (a, b) => (a === b || (a == null || b == null ? a == null && b == null : Math.abs(a - b) < 1e-9 * Math.max(1, Math.abs(a))));

describe('признаки не заглядывают в будущее', () => {
  const candles = hourly(70);
  const refs = [];
  for (const [id, f] of Object.entries(FEATURES)) {
    if (f.kind === 'distance') { refs.push({ id, unit: 'pct' }); refs.push({ id, unit: 'atr' }); } else refs.push({ id });
  }
  refs.push({ id: 'dist_ma', params: { type: 'sma', period: 20 }, unit: 'pct' });
  refs.push({ id: 'dist_pivot', params: { level: 'R1' }, unit: 'pct' });
  refs.push({ id: 'change_pct', params: { bars: 9 } });

  test.each(refs.map((r) => [`${r.id}${r.unit ? `/${r.unit}` : ''}${r.params ? JSON.stringify(r.params) : ''}`, r]))('%s', (_, ref) => {
    const full = featureSeries(candles, ref, 60);
    expect(Array.isArray(full)).toBe(true);
    expect(full).toHaveLength(candles.length);
    const checkpoints = [5, 30, 77, 150, 233, 400, candles.length - 2, candles.length - 1];
    for (const i of checkpoints) {
      const cut = featureSeries(candles.slice(0, i + 1), ref, 60);
      if (!same(full[i], cut[i])) throw new Error(`${ref.id}: бар ${i} — по всей истории ${full[i]}, по обрезанной ${cut[i]}`);
    }
  });

  test('быстрый расчёт уровней совпадает с медленным бар за баром', () => {
    const pct = featureSeries(candles, { id: 'dist_support', unit: 'pct' }, 60);
    const pr = featureSeries(candles, { id: 'dist_resistance', unit: 'pct' }, 60);
    let seen = 0;
    for (let i = 0; i < candles.length; i += 7) {
      const slow = nearestLevelsSlow(candles, i);
      const c = candles[i].close;
      const exp = (lvl) => (lvl == null ? null : lvl === -Infinity ? Infinity : lvl === Infinity ? -Infinity : ((c - lvl) / lvl) * 100);
      if (!same(pct[i], exp(slow.support)) || !same(pr[i], exp(slow.resistance))) throw new Error(`бар ${i}: быстро ${pct[i]}/${pr[i]}, медленно ${exp(slow.support)}/${exp(slow.resistance)}`);
      if (Number.isFinite(slow.support)) seen++;
    }
    expect(seen).toBeGreaterThan(20);
  });

  test('у большинства признаков к концу истории есть значения', () => {
    const empty = refs.filter((r) => FEATURES[r.id].historical !== false)
      .filter((r) => featureSeries(candles, r, 60).slice(-50).every((v) => v == null));
    expect(empty.map((r) => r.id)).toEqual([]);
  });

  test('старший таймфрейм: берётся только закрытая дневная свеча', () => {
    const d1 = dailyFrom(candles);
    const data = prepareData({ timeframe: 'H1', candles, htf: { D1: d1 } });
    const cond = newCondition('change_pct', { feature: { id: 'change_pct', params: { bars: 1 }, tf: 'D1' }, op: '>', value: -100 });
    for (const i of [20, 100, 300, candles.length - 1]) {
      const r = evaluateCondition(data, cond, i, 0);
      const baseClose = candles[i].date.getTime() + 3600000;
      const used = d1.filter((c) => c.date.getTime() + 86400000 <= baseClose);
      const expected = used.length >= 2 ? ((used[used.length - 1].close - used[used.length - 2].close) / used[used.length - 2].close) * 100 : null;
      if (expected == null) expect(r.state).toBe('na');
      else expect(r.value).toBeCloseTo(expected, 9);
    }
  });
});

describe('формулы', () => {
  test('стохастик: закрытие на максимуме окна = 100, на минимуме = 0', () => {
    const up = fromCloses([10, 11, 12, 13, 14, 15]);
    up.forEach((c) => { c.high = c.close; c.low = c.open; });
    const k = featureSeries(up, { id: 'stoch_k', params: { period: 3, smooth: 1 } }, 60);
    expect(k[5]).toBeCloseTo(100, 9);
    const dn = fromCloses([15, 14, 13, 12, 11, 10]);
    dn.forEach((c) => { c.high = c.open; c.low = c.close; });
    expect(featureSeries(dn, { id: 'stoch_k', params: { period: 3, smooth: 1 } }, 60)[5]).toBeCloseTo(0, 9);
  });

  test('Supertrend разворачивается на сильном падении', () => {
    const closes = [...Array.from({ length: 30 }, (_, i) => 100 + i), ...Array.from({ length: 30 }, (_, i) => 129 - i * 3)];
    const { dir } = supertrend(fromCloses(closes), 10, 3);
    expect(dir[29]).toBe(1);
    expect(dir[59]).toBe(-1);
  });

  test('пробой максимума N свечей: текущая свеча в окно не входит', () => {
    const c = fromCloses([10, 11, 12, 11, 13]);
    const s = featureSeries(c, { id: 'dist_high_n', params: { bars: 3 }, unit: 'pct' }, 60);
    // максимум прошлых 3 свечей перед последней = high свечи 12 → 12.5; цена 13 выше на 4%
    expect(s[4]).toBeCloseTo(((13 - 12.5) / 12.5) * 100, 9);
  });

  test('пивоты прошлого дня и VWAP дня сбрасываются в начале нового дня', () => {
    const candles = hourly(5);
    const vwap = featureSeries(candles, { id: 'dist_vwap', unit: 'pct' }, 60);
    const first = candles.findIndex((c, i) => i > 0 && c.date.getUTCDate() !== candles[i - 1].date.getUTCDate());
    const c = candles[first];
    const tp = (c.high + c.low + c.close) / 3;
    expect(vwap[first]).toBeCloseTo(((c.close - tp) / tp) * 100, 9);
    const piv = featureSeries(candles, { id: 'dist_pivot', params: { level: 'P' }, unit: 'pct' }, 60);
    expect(piv[first - 1]).toBeNull(); // первый день — прошлого дня нет
    expect(piv[first]).not.toBeNull();
  });
});

describe('условия и допуск', () => {
  const c = fromCloses([100, 100, 100, 102]); // изменение за 1 свечу на последнем баре = 2%
  const data = prepareData({ timeframe: 'H1', candles: c });
  const cond = (op, value, extra = {}) => newCondition('change_pct', { feature: { id: 'change_pct', params: { bars: 1 } }, op, value, ...extra });

  test('точно / почти / нет при допуске 5%', () => {
    expect(evaluateCondition(data, cond('>', 1.9), 3, 5).state).toBe('exact');
    expect(evaluateCondition(data, cond('>', 2.05), 3, 5).state).toBe('near'); // 2 vs 2.05: разница 0.05 ≤ 5% от 2.05
    expect(evaluateCondition(data, cond('>', 2.2), 3, 5).state).toBe('fail');
    expect(evaluateCondition(data, cond('>', 2.05), 3, 0).state).toBe('fail'); // без допуска «почти» не бывает
    expect(evaluateCondition(data, cond('between', [2.05, 3]), 3, 5).state).toBe('near');
  });

  test('«N свечей назад» и нехватка истории', () => {
    expect(evaluateCondition(data, cond('>', 1, { ago: 1 }), 3, 0).state).toBe('fail'); // свечой раньше изменение 0
    expect(evaluateCondition(data, cond('>', 1), 0, 0).state).toBe('na');
  });

  test('пересечение: точно, запоздал на свечу, почти подошёл', () => {
    const k = fromCloses([100, 100, 100, 103, 104]);
    const d = prepareData({ timeframe: 'H1', candles: k });
    const x = newCondition('dist_ma', { feature: { id: 'dist_ma', params: { type: 'sma', period: 3 }, unit: 'pct' }, op: 'crossAbove', value: 0.5 });
    expect(evaluateCondition(d, x, 3, 5).state).toBe('exact');
    const late = evaluateCondition(d, x, 4, 5);
    expect(late.state).toBe('near');
    expect(late.late).toBe(true);
  });

  test('растёт N свечей: все шаги — точно, без одного — почти', () => {
    // изменения за свечу: 1%, ≈2%, 3%, ≈4%, затем ≈1.5% — рост ускоряется, потом сбивается
    const k = fromCloses([100, 101, 103, 106.1, 110.3, 112]);
    const d = prepareData({ timeframe: 'H1', candles: k });
    const up = (n) => newCondition('change_pct', { feature: { id: 'change_pct', params: { bars: 1 } }, op: 'rising', n });
    expect(evaluateCondition(d, up(3), 4, 0).state).toBe('exact');
    expect(evaluateCondition(d, up(3), 5, 0).state).toBe('near');
    expect(evaluateCondition(d, up(1), 5, 0).state).toBe('fail');
    expect(evaluateCondition(d, up(3), 2, 0).state).toBe('na'); // не хватает свечей
  });
});

describe('сигнал целиком', () => {
  const c = fromCloses([100, 100, 100, 102]);
  const data = prepareData({ timeframe: 'H1', candles: c });
  const ch = (op, value, extra = {}) => newCondition('change_pct', { feature: { id: 'change_pct', params: { bars: 1 } }, op, value, ...extra });

  test('режим «все условия»', () => {
    const spec = { ...emptySpec(), entry: { mode: 'all', conditions: [ch('>', 1), ch('>', 2.05)] } };
    expect(evaluateAt(spec, data, 3, 'long').state).toBe('near');
    spec.entry.conditions[1] = ch('>', 3);
    expect(evaluateAt(spec, data, 3, 'long').state).toBe('none');
  });

  test('режим «баллы» и обязательные условия', () => {
    const conds = [ch('>', 1, { weight: 2 }), ch('>', 5, { weight: 1 }), ch('<', 10, { weight: 1 })];
    const spec = { ...emptySpec(), entry: { mode: 'score', minScore: 3, conditions: conds } };
    const r = evaluateAt(spec, data, 3, 'long');
    expect(r.score).toBe(3);
    expect(r.state).toBe('exact');
    conds[1].required = true;
    expect(evaluateAt(spec, data, 3, 'long').state).toBe('none');
  });

  test('условие только для шорта не мешает лонгу; признак без истории не участвует', () => {
    const spec = { ...emptySpec(), direction: 'both', entry: { mode: 'all', conditions: [ch('>', 1), ch('>', 50, { side: 'short' }), newCondition('orderbook', { op: '>', value: 1 })] } };
    const r = evaluateAt(spec, data, 3, 'long');
    expect(r.state).toBe('exact');
    expect(r.partial).toBe(true);
    expect(evaluateAt(spec, data, 3, 'short').state).toBe('none');
  });

  test('сигнал несколько свечей подряд = один вход', () => {
    const k = fromCloses([100, 101, 102, 103, 102, 103]);
    const d = prepareData({ timeframe: 'H1', candles: k });
    const spec = { ...emptySpec(), tolerancePct: 0, entry: { mode: 'all', conditions: [newCondition('change_pct', { feature: { id: 'change_pct', params: { bars: 1 } }, op: '>', value: 0 })] } };
    expect(scanSignals(spec, d).map((s) => s.i)).toEqual([1, 5]);
  });

  test('последняя закрытая свеча перед входом', () => {
    const d = prepareData({ timeframe: 'H1', candles: c });
    expect(lastClosedIndex(d, new Date(c[2].date.getTime() + 10 * 60000))).toBe(1);
    expect(lastClosedIndex(d, c[0].date)).toBe(-1);
  });
});

describe('проверка стратегии и тексты', () => {
  const ok = () => ({ ...emptySpec(), entry: { mode: 'all', conditions: [newCondition('rsi', { op: '<', value: 30 })] } });

  test('пустая стратегия — ошибка, нормальная — без ошибок', () => {
    expect(validateSpec(emptySpec()).some((p) => p.level === 'error')).toBe(true);
    expect(validateSpec(ok()).filter((p) => p.level === 'error')).toEqual([]);
  });

  test('порог баллов больше суммы, младший ТФ в условии, стакан', () => {
    const s = ok();
    s.entry = { mode: 'score', minScore: 5, conditions: [newCondition('rsi', { op: '<', value: 30, weight: 2 })] };
    expect(validateSpec(s).some((p) => /больше суммы/.test(p.text))).toBe(true);
    const t = ok();
    t.timeframe = 'H1';
    t.entry.conditions[0].feature.tf = 'M15';
    expect(validateSpec(t).some((p) => /меньше таймфрейма/.test(p.text))).toBe(true);
    const o = ok();
    o.entry.conditions.push(newCondition('orderbook', { op: '>', value: 1.5 }));
    expect(validateSpec(o).some((p) => p.level === 'warn' && /бумажной/.test(p.text))).toBe(true);
    expect(paperOnlyReasons(o)).toHaveLength(1);
    const d = ok();
    d.entry.conditions = [newCondition('dist_ma', { op: '<', value: 1, feature: { id: 'dist_ma', params: { type: 'ema', period: 50 } } })];
    expect(validateSpec(d).some((p) => /единицу/.test(p.text))).toBe(true);
  });

  test('условие человеческим языком', () => {
    expect(describeCondition(newCondition('rsi', { op: '<', value: 30 }))).toBe('RSI(14) ниже 30');
    expect(describeCondition(newCondition('dist_ma', { op: 'between', value: [-1, 0.5], feature: { id: 'dist_ma', params: { type: 'ema', period: 50 }, unit: 'pct' } })))
      .toBe('расстояние до EMA 50 между -1% и 0,5%');
    expect(describeCondition(newCondition('dist_support', { op: '<', value: 1, feature: { id: 'dist_support', unit: 'atr' }, side: 'long' })))
      .toBe('расстояние до ближайшей поддержки ниже 1 ATR — для лонга');
    expect(describeCondition(newCondition('rsi', { op: '>', value: 50, feature: { id: 'rsi', tf: 'D1' } }))).toBe('RSI(14) на Д1 выше 50');
  });

  test('класс инструмента и группа фьючерса', () => {
    expect(instrumentClassOf({ ticker: 'SBER' })).toBe('stock');
    expect(instrumentClassOf({ ticker: 'BRZ6' })).toBe('future');
    expect(instrumentClassOf({ ticker: 'USD000UTSTOM' })).toBe('currency');
    expect(instrumentClassOf({ ticker: 'X', instrumentType: 'futures' })).toBe('future');
    expect(instrumentClassOf({ ticker: 'X', instrumentType: 'option' })).toBe('option');
    expect(futureGroupOf('BRZ6')).toBe('oil');
    expect(futureGroupOf('SiH7')).toBe('currency');
    expect(futureGroupOf('IMOEXF')).toBe('index');
    expect(futureGroupOf('MXZ6')).toBe('index');
    expect(futureGroupOf('NGF7')).toBe('gas');
    expect(futureGroupOf('GDZ6')).toBe('metals');
    expect(futureGroupOf('SRZ6')).toBe('stock');
  });
});

describe('сверка с журналом', () => {
  // Сигнал «цена выросла за свечу больше 0» на свечах 1, 2, 3 и 5.
  const c = fromCloses([100, 101, 102, 103, 102, 103, 102, 101, 100, 99]);
  const data = prepareData({ timeframe: 'H1', candles: c });
  const at = (i, min = 10) => new Date(c[i].date.getTime() + min * 60000); // вход внутри свечи i → последняя закрытая i-1
  const spec = {
    ...emptySpec(), direction: 'long', tolerancePct: 0,
    entry: { mode: 'all', conditions: [newCondition('change_pct', { feature: { id: 'change_pct', params: { bars: 1 } }, op: '>', value: 0 })] },
  };
  const tr = (id, i, pnl, extra = {}) => ({ id, ticker: 'SBER', direction: 'long', status: 'closed', pnl, openedAt: at(i).toISOString(), ...extra });

  test('группы, исключения и нет данных', () => {
    const trades = [
      tr('a', 2, 500), // сигнал на 1
      tr('b', 4, -200), // последняя закрытая 3 — сигнал
      tr('c', 9, -100), // свечи 6–8 падают — сигнала нет
      tr('d', 2, 300, { direction: 'short' }), // другая сторона
      tr('e', 2, 50, { ticker: 'SBER-OPT', instrumentType: 'option' }),
      tr('f', 2, 70, { ticker: 'GAZP' }), // свечей нет
      tr('g', 0, 10), // вход до первой закрытой свечи
      { id: 'h', ticker: 'SBER', direction: 'long', status: 'open', openedAt: at(3).toISOString() },
    ];
    const m = matchJournal(spec, trades, (t) => (t === 'SBER' ? data : null), { windowBars: 0 });
    expect(m.exact.n).toBe(2);
    expect(m.exact.pnl).toBe(300);
    expect(m.exact.winRate).toBe(0.5);
    expect(m.none.n).toBe(1);
    expect(m.excluded.otherSide).toBe(1);
    expect(m.excluded.byClass).toEqual({ option: 1 });
    expect(m.excluded.open).toBe(1);
    expect(m.noData.map((x) => x.reason).sort()).toEqual(['beforeHistory', 'noCandles']);
    expect(m.smallSample).toBe(true);
  });

  test('окно в несколько свечей: сигнал свечой раньше тоже засчитывается', () => {
    const m0 = matchJournal(spec, [tr('x', 7, 1)], () => data, { windowBars: 0 }); // последняя закрытая 6 — падение
    expect(m0.none.n).toBe(1);
    const m2 = matchJournal(spec, [tr('x', 7, 1)], () => data, { windowBars: 2 }); // свеча 5 — рост
    expect(m2.exact.n).toBe(1);
    expect(m2.exact.trades[0].barsBeforeEntry).toBe(1);
  });
});

describe('загрузка свечей для сверки', () => {
  // eslint-disable-next-line global-require
  const { planJournalLoad, loadJournalData, timeframesOf, WARMUP_DAYS } = require('./journalData');
  const spec = {
    ...emptySpec(), direction: 'long', timeframe: 'H1', instrumentClass: 'stock',
    entry: { mode: 'all', conditions: [newCondition('rsi', { op: '<', value: 30 }), newCondition('rsi', { op: '>', value: 50, feature: { id: 'rsi', tf: 'D1' } })] },
  };
  const trades = [
    { id: 'a', ticker: 'SBER', direction: 'long', status: 'closed', pnl: 1, openedAt: '2026-03-02T08:00:00Z' },
    { id: 'b', ticker: 'sber', direction: 'long', status: 'closed', pnl: 2, openedAt: '2026-03-20T08:00:00Z' },
    { id: 'c', ticker: 'GAZP', direction: 'long', status: 'closed', pnl: 3, openedAt: '2026-02-10T08:00:00Z' },
    { id: 'd', ticker: 'BRZ6', direction: 'long', status: 'closed', pnl: 4, openedAt: '2026-02-10T08:00:00Z' },
    { id: 'e', ticker: 'LKOH', direction: 'short', status: 'closed', pnl: 5, openedAt: '2026-02-10T08:00:00Z' },
  ];

  test('план: только нужные бумаги, период от первой до последней сделки', () => {
    expect(timeframesOf(spec).sort()).toEqual(['D1', 'H1']);
    const plan = planJournalLoad(spec, trades, Date.parse('2026-11-18T00:00:00Z'));
    expect(plan.map((p) => p.ticker)).toEqual(['SBER', 'GAZP']);
    expect(plan[0].trades).toBe(2);
    expect(plan[0].from.toISOString()).toBe('2026-03-02T08:00:00.000Z');
    expect(plan[0].to.toISOString()).toBe('2026-03-21T08:00:00.000Z');
  });

  test('загрузка: оба таймфрейма с разгоном, ошибка одной бумаги не роняет остальные', async () => {
    const calls = [];
    const fetcher = async (a) => {
      calls.push(a);
      if (a.ticker === 'GAZP') throw new Error('сеть');
      return fromCloses([1, 2, 3]);
    };
    const plan = planJournalLoad(spec, trades, Date.parse('2026-11-18T00:00:00Z'));
    const progress = [];
    const res = await loadJournalData(spec, plan, fetcher, { onProgress: (p) => progress.push(p.done) });
    expect(res.data.has('SBER')).toBe(true);
    expect(res.data.get('SBER').htf.D1).toHaveLength(3);
    expect(res.failed).toEqual([{ ticker: 'GAZP', error: 'сеть' }]);
    const sberH1 = calls.find((c) => c.ticker === 'SBER' && c.timeframe === 'H1');
    expect(sberH1.lookbackDays).toBe(19 + WARMUP_DAYS.H1);
    expect(calls.find((c) => c.ticker === 'SBER' && c.timeframe === 'D1').lookbackDays).toBe(19 + WARMUP_DAYS.D1);
    expect(progress.sort()).toEqual([1, 2]);
  });
});

describe('заготовки', () => {
  // eslint-disable-next-line global-require
  const { SETUP_PRESETS, specFromPreset } = require('./ruleSpec');
  test.each(SETUP_PRESETS.map((p) => [p.label, p.id]))('%s — без ошибок', (_, id) => {
    const s = specFromPreset(id);
    expect(validateSpec(s).filter((p) => p.level === 'error')).toEqual([]);
    expect(new Set(s.entry.conditions.map((c) => c.id)).size).toBe(s.entry.conditions.length);
  });
});
