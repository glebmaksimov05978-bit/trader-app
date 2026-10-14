// Проверка сравнения стратегий, доли забранного хода и общего риска (npm run test:compare).
import { excursionPct, capturedMovePct } from '../src/services/analytics/excursion.js';
import { buildStrategyComparison, comparisonNote, strategyOfTrade } from '../src/services/analytics/strategyCompare.js';
import { buildOpenRisk, positionRisk } from '../src/services/analytics/openRisk.js';
import { normalize } from '../src/services/analytics/periodReport.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) <= e;

// ---------------- ход цены ----------------
const candles = [
  { high: 101, low: 99 }, { high: 106, low: 100 }, { high: 104, low: 97 }, { high: 103, low: 98 },
];
let ex = excursionPct({ candles, fromIndex: 0, toIndex: 3, direction: 'long', entryPrice: 100 });
ok('лонг: максимум в плюс +6%', near(ex.maxFavorablePct, 6));
ok('лонг: максимум против −3%', near(ex.maxAdversePct, 3));
ex = excursionPct({ candles, fromIndex: 0, toIndex: 3, direction: 'short', entryPrice: 100 });
ok('шорт: благоприятный ход вниз — 3%', near(ex.maxFavorablePct, 3));
ok('шорт: неблагоприятный — вверх 6%', near(ex.maxAdversePct, 6));
ok('окно ограничено индексами', near(excursionPct({ candles, fromIndex: 2, toIndex: 3, direction: 'long', entryPrice: 100 }).maxFavorablePct, 4));
ok('мусор → null', excursionPct({ candles: null, fromIndex: 0, toIndex: 1, direction: 'long', entryPrice: 100 }) === null
  && excursionPct({ candles, fromIndex: 3, toIndex: 1, direction: 'long', entryPrice: 100 }) === null
  && excursionPct({ candles, fromIndex: 0, toIndex: 1, direction: 'long', entryPrice: 0 }) === null);
ok('индексы за пределами обрезаются', excursionPct({ candles, fromIndex: -5, toIndex: 99, direction: 'long', entryPrice: 100 }).maxFavorablePct === 6);

// забранный ход
ok('по ступеням: 50% по 104 и 50% по 108 → +6%', near(capturedMovePct({
  direction: 'long', entryPrice: 100,
  legs: [{ type: 'close', price: 104, quantity: 1 }, { type: 'close', price: 108, quantity: 1 }],
}), 6));
ok('ступени с разным объёмом взвешены: 3×104 + 1×108 → 105%… то есть +5', near(capturedMovePct({
  direction: 'long', entryPrice: 100,
  legs: [{ type: 'close', price: 104, quantity: 3 }, { type: 'close', price: 108, quantity: 1 }],
}), 5));
ok('шорт: выход ниже входа — плюс', near(capturedMovePct({ direction: 'short', entryPrice: 100, legs: [{ type: 'close', price: 95, quantity: 1 }] }), 5));
ok('без ступеней — по exitPrice', near(capturedMovePct({ direction: 'long', entryPrice: 100, exitPrice: 98 }), -2));
ok('открывающие ступени игнорируются', near(capturedMovePct({ direction: 'long', entryPrice: 100, legs: [{ type: 'open', price: 100, quantity: 1 }, { type: 'close', price: 101, quantity: 1 }] }), 1));
ok('нет ни ступеней, ни выхода → null', capturedMovePct({ direction: 'long', entryPrice: 100 }) === null);

// ---------------- сравнение ----------------
const strat = (id, name, horizon, timeframe) => ({ id, name, horizon, timeframe, followed: true });
const A = strat('A', 'Пробой', 'short', 'H1');
const B = strat('B', 'Откат', 'short', 'H1');
const C = strat('C', 'Тренд', 'long', 'D1');
const strategies = [A, B, C];

const T = (o) => ({
  status: 'closed', direction: 'long', entryPrice: 100, openedAt: '2026-10-02T10:00:00Z', closedAt: '2026-10-03T10:00:00Z',
  ...o,
});
const paper = [
  // A: 4 сделки, три с ходом
  T({ id: 'a1', ticker: 'SBER', entryStrategyId: 'A', pnl: 600, exitPrice: 106, maxFavorablePct: 8 }),
  T({ id: 'a2', ticker: 'GAZP', entryStrategyId: 'A', pnl: 300, exitPrice: 103, maxFavorablePct: 5 }),
  T({ id: 'a3', ticker: 'SBER', entryStrategyId: 'A', pnl: -200, exitPrice: 98, maxFavorablePct: 1 }),
  T({ id: 'a4', ticker: 'LKOH', entryStrategyId: 'A', pnl: 100, exitPrice: 101 }),
  // B: 3 сделки
  T({ id: 'b1', ticker: 'SBER', entryStrategyId: 'B', pnl: 200, exitPrice: 102, maxFavorablePct: 2.5 }),
  T({ id: 'b2', ticker: 'GAZP', entryStrategyId: 'B', pnl: 500, exitPrice: 105, maxFavorablePct: 6 }),
  T({ id: 'b3', ticker: 'VTBR', entryStrategyId: 'B', pnl: -100, exitPrice: 99, maxFavorablePct: 0.5 }),
  // C: одна
  T({ id: 'c1', ticker: 'SBER', entryStrategyId: 'C', pnl: 1500, exitPrice: 115, maxFavorablePct: 20, openedAt: '2026-09-20T10:00:00Z' }),
  // открытые
  { id: 'o1', status: 'open', ticker: 'SBER', entryStrategyId: 'A', openedAt: '2026-10-10T10:00:00Z' },
  { id: 'o2', status: 'open', ticker: 'MGNT', entryStrategyId: 'C', openedAt: '2026-10-11T10:00:00Z' },
  // вне периода
  T({ id: 'x1', ticker: 'SBER', entryStrategyId: 'A', pnl: 9999, closedAt: '2026-08-03T10:00:00Z', openedAt: '2026-08-02T10:00:00Z' }),
];
const items = normalize([], paper, 'paper').filter((x) => x.closed.getMonth() === 9); // октябрь
const cmp = buildStrategyComparison({ items, paperTrades: paper, strategies, type: 'month', key: '2026-10' });
const row = (id) => cmp.rows.find((r) => r.id === id);

ok('три стратегии в сравнении', cmp.rows.length === 3);
ok('A: 4 сделки, итог +800', row('A').stats.total === 4 && row('A').stats.pnl === 800);
ok('A: доля прибыльных 75%', row('A').stats.winrate === 75);
ok('сделка вне периода не попала', !cmp.rows.some((r) => r.stats.pnl > 5000));
ok('A: сигналов в периоде = 4 закрытых + 1 открытая', row('A').signals === 5);
ok('A: сейчас в рынке 1', row('A').openNow === 1);
ok('C: сигналов в октябре = 1 (закрытая открыта в сентябре) + 1 открытая', row('C').signals === 1 + 0 || row('C').signals === 1);
ok('C: сейчас в рынке 1', row('C').openNow === 1);
ok('подписи: горизонт и таймфрейм', row('A').caption === 'краткосрок · Ч1' && row('C').caption === 'долгосрок · Д1');
ok('срок удержания 1 день', near(row('A').avgHoldDays, 1));

// доля забранного хода: A — три сделки с ходом (a1,a2,a3): (6+3-2)/(8+5+1)=0.5
ok('A: доля хода = 0.5 по трём сделкам', row('A').capture && near(row('A').capture.ratio, 0.5) && row('A').capture.n === 3);
// B — три сделки с ходом: (2+5-1)/(2.5+6+0.5)=0.6667
ok('B: доля хода ≈ 0.667', row('B').capture && near(row('B').capture.ratio, 6 / 9, 1e-9));
ok('C: одна сделка — доля хода не показывается', row('C').capture === null);

// кластеры
ok('A и B — один сопоставимый кластер', cmp.comparableClusters.length === 1 && cmp.comparableClusters[0].rows.map((r) => r.id).sort().join() === 'A,B');
ok('C отдельно — без сравнения', cmp.clusters.some((c) => !c.comparable && c.rows[0].id === 'C'));
const cl = cmp.comparableClusters[0];
ok('лучший итог — A (800 против 600)', cl.best.pnl === 'A');
ok('лучшая доля прибыльных — A (75% против 67%)', cl.best.winrate === 'A');
ok('лучшая доля хода — B', cl.best.capture === 'B');
ok('общие тикеры: SBER и GAZP', cl.shared.map((s) => s.ticker).join() === 'GAZP,SBER');
ok('по SBER у A +400, у B +200', (() => {
  const s = cl.shared.find((x) => x.ticker === 'SBER');
  return s.rows.find((r) => r.key === 'A').pnl === 400 && s.rows.find((r) => r.key === 'B').pnl === 200;
})());
ok('VTBR и LKOH не общие', !cl.shared.some((s) => ['VTBR', 'LKOH'].includes(s.ticker)));

// текст
ok('пояснение при сопоставимых', /напрямую/.test(comparisonNote(cmp)));
const onlyDiff = buildStrategyComparison({ items: items.filter((x) => x.raw.entryStrategyId !== 'B'), paperTrades: [], strategies, type: 'month', key: '2026-10' });
ok('разные классы: факты без «лучше»', onlyDiff.hasComparable === false && /разных горизонтах/.test(comparisonNote(onlyDiff)));
ok('best у не сопоставимых нет', onlyDiff.clusters.every((c) => c.best === null));
ok('пустой период', buildStrategyComparison({ items: [], strategies, type: 'month', key: '2026-10' }).hasAny === false);

// две стратегии без паспорта не считаются «одного класса»
const noMeta = [{ id: 'P', name: 'П' }, { id: 'Q', name: 'К' }];
const p2 = [T({ id: 'p', ticker: 'SBER', entryStrategyId: 'P', pnl: 10 }), T({ id: 'q', ticker: 'SBER', entryStrategyId: 'Q', pnl: 20 })];
const c2 = buildStrategyComparison({ items: normalize([], p2, 'paper'), paperTrades: p2, strategies: noMeta, type: 'month', key: '2026-10' });
ok('без паспорта сравнения «в лоб» нет', c2.hasComparable === false && c2.rows.length === 2);

// поиск стратегии сделки
ok('по id', strategyOfTrade({ entryStrategyId: 'B' }, strategies).id === 'B');
ok('по имени, если id устарел', strategyOfTrade({ entryStrategyId: 'zzz', entryStrategyName: 'Тренд' }, strategies).id === 'C');
ok('нет — null', strategyOfTrade({}, strategies) === null);

// два одинаковых по тикеру: сделка без стратегии не создаёт строку в сигналах
const noStrat = buildStrategyComparison({ items: [], paperTrades: [{ status: 'open', ticker: 'X', openedAt: '2026-10-05T00:00:00Z' }], strategies, type: 'month', key: '2026-10' });
ok('открытая без стратегии не считается сигналом стратегии', noStrat.rows.length === 0);

// ---------------- общий риск ----------------
const stock = { id: 's1', ticker: 'sber', direction: 'long', entryPrice: 300, stopLoss: 294, volume: 10, lot: 10, status: 'open', entryStrategyName: 'Пробой', instrumentType: 'stock' };
const fut = { id: 'f1', ticker: 'BRX6', direction: 'short', entryPrice: 80, stopLoss: 81, volume: 2, lot: 1, minStep: 0.01, minStepAmount: 7.5, status: 'open', entryStrategyName: 'Откат', instrumentType: 'future' };
const pr = positionRisk(stock);
ok('акция: риск = 6 × лот 10 × 10 шт = 600 ₽', near(pr.riskRub, 600));
ok('тикер в верхнем регистре', pr.ticker === 'SBER');
ok('фьючерс: 1.0 пункта = 100 тиков × 7.5 × 2 = 1500 ₽', near(positionRisk(fut).riskRub, 1500));
ok('частично закрытая: риск на остаток', near(positionRisk({ ...stock, status: 'partial', remainingVolume: 4 }).riskRub, 240));
ok('нет стопа → риск неизвестен', positionRisk({ ...stock, stopLoss: null }).riskRub === null && positionRisk({ ...stock, stopLoss: null }).hasStop === false);

const open = buildOpenRisk({ trades: [stock, fut, { ...stock, id: 's2', status: 'closed' }], deposit: 100000, dailyLossLimitPct: 2, maxRiskPerTradePct: 1 });
ok('учтены только открытые', open.total.count === 2);
ok('сумма риска 2100 ₽ = 2.1% депозита', near(open.total.riskRub, 2100) && near(open.total.riskPct, 2.1));
ok('превышение дневного лимита → предупреждение', open.warnings.some((w) => w.code === 'over_daily_limit'));
ok('SBER: риск 0.6% — предупреждения «большая позиция» нет', !open.warnings.some((w) => w.code === 'big_position' && /SBER/.test(w.text)));
ok('по тикерам две строки', open.byTicker.length === 2 && open.byTicker[0].ticker === 'BRX6');

const twice = buildOpenRisk({ trades: [stock, { ...stock, id: 's3', entryStrategyName: 'Тренд' }], deposit: 100000 });
ok('две позиции по тикеру в одну сторону → предупреждение, риск складывается', twice.warnings.some((w) => w.code === 'same_ticker') && near(twice.byTicker[0].riskRub, 1200));
const hedge = buildOpenRisk({ trades: [stock, { ...stock, id: 's4', direction: 'short', stopLoss: 306 }], deposit: 100000 });
ok('лонг и шорт по одному тикеру — не «концентрация»', !hedge.warnings.some((w) => w.code === 'same_ticker'));
const nostop = buildOpenRisk({ trades: [stock, { ...stock, id: 's5', stopLoss: null }], deposit: 100000 });
ok('позиция без стопа — предупреждение, в сумму не входит', nostop.warnings.some((w) => w.code === 'no_stop') && near(nostop.total.riskRub, 600));
const big = buildOpenRisk({ trades: [{ ...stock, volume: 50 }], deposit: 100000, maxRiskPerTradePct: 1 });
ok('риск 3% против лимита 1% → предупреждение', big.warnings.some((w) => w.code === 'big_position'));
const noDep = buildOpenRisk({ trades: [stock], deposit: 0 });
ok('депозит не задан — проценты null, а не NaN', noDep.total.riskPct === null && noDep.total.riskRub === 600);
const withPaper = buildOpenRisk({ trades: [], paper: [stock], deposit: 100000 });
ok('бумажные считаются отдельно и в реальный риск не входят', withPaper.total.riskRub === 0 && near(withPaper.paper.riskRub, 600));
ok('пусто не падает', buildOpenRisk({}).total.count === 0 && buildOpenRisk({ trades: null, paper: null }).warnings.length === 0);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки сравнения стратегий и риска прошли ✓');
