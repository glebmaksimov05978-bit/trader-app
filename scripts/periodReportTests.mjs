// Проверка отчёта за период (npm run test:period). Сеть и база не нужны.
import { buildPeriodReport, listPeriods, prevPeriodKey, statsOf, normalize, listStrategyNames, strategyNameOf } from '../src/services/analytics/periodReport.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const real = (pnl, closedAt, o = {}) => ({ status: 'closed', pnl, closedAt, ticker: 'SBER', direction: 'long', ...o });
const paper = (pnl, closedAt, strategy, o = {}) => ({ status: 'closed', pnl, closedAt, ticker: 'GAZP', direction: 'long', entryStrategyName: strategy, ...o });

const realTrades = [
  real(100, '2026-10-02T10:00:00'), real(-40, '2026-10-05T10:00:00'), real(60, '2026-10-20T10:00:00'),   // октябрь: +120
  real(-30, '2026-09-10T10:00:00'), real(50, '2026-09-12T10:00:00'),                                      // сентябрь: +20
  { status: 'open', pnl: 999, closedAt: null },                                                           // открытая — не считается
  { status: 'closed', pnl: null, closedAt: '2026-10-03T10:00:00' },                                       // без результата — нет
];
const paperTrades = [
  paper(200, '2026-10-03T10:00:00', 'А'), paper(-50, '2026-10-04T10:00:00', 'А'), paper(80, '2026-10-06T10:00:00', 'Б'),
  { status: 'open', pnl: 500, closedAt: null, entryStrategyName: 'А' },                                    // открытая бумажная — не считается
];

ok('нормализация: реальные — 5 закрытых', normalize(realTrades, paperTrades, 'real').length === 5);
ok('нормализация: бумажные — 3 закрытых', normalize(realTrades, paperTrades, 'paper').length === 3);
// Среза «всё вместе» больше нет: реальные и условные рубли не складываются. Старое значение 'all' читается как «реальные».
ok('старое «всё вместе» читается как реальные: 5, без бумажных', normalize(realTrades, paperTrades, 'all').length === 5 && normalize(realTrades, paperTrades, 'all').every((x) => x.src !== 'paper'));

const r = buildPeriodReport({ realTrades, paperTrades, scope: 'real', type: 'month', key: '2026-10' });
ok('реальные за октябрь: 3 сделки, +120', r.stats.total === 3 && r.stats.pnl === 120);
ok('винрейт 67%', Math.round(r.stats.winrate) === 67);
ok('профит-фактор 160/40 = 4', r.stats.profitFactor === 4);
ok('прошлый период — сентябрь, +20', r.prevKey === '2026-09' && r.prevStats.pnl === 20);
ok('дельта к сентябрю = +100', r.delta.pnl === 100 && r.delta.hasPrev);
ok('просадка по порядку закрытия: 100 → 60 → 120, просадка 40', r.stats.maxDrawdown === 40);
ok('кривая: 31 день, к концу накоплено 120', r.curve.length === 31 && r.curve[30].cumulative === 120);
ok('кривая: 2-го числа накоплено 100', r.curve[1].cumulative === 100);

const p = buildPeriodReport({ realTrades, paperTrades, scope: 'paper', type: 'month', key: '2026-10' });
ok('бумажные за октябрь: +230 (открытая не в счёт)', p.stats.pnl === 230 && p.stats.total === 3);
ok('по стратегиям: А +150 (2 сделки), Б +80', p.byStrategy.find((x) => x.label === 'А').pnl === 150 && p.byStrategy.find((x) => x.label === 'Б').pnl === 80);
ok('стратегии отсортированы по результату (А первой)', p.byStrategy[0].label === 'А');
ok('сравнение «я против системы» в любом срезе', r.versus.real.pnl === 120 && r.versus.paper.pnl === 230);

const a = buildPeriodReport({ realTrades, paperTrades, scope: 'all', type: 'month', key: '2026-10' });
ok('старое «всё вместе» за октябрь = реальные: 3 сделки, +120', a.stats.total === 3 && a.stats.pnl === 120);
ok('бумажных строк в стратегиях нет', !a.byStrategy.some((x) => /бумага/.test(x.label)));

const y = buildPeriodReport({ realTrades, paperTrades, scope: 'real', type: 'year', key: '2026' });
ok('год: все 5 реальных, +140', y.stats.total === 5 && y.stats.pnl === 140);
ok('год: кривая по 12 месяцам, сентябрь +20, октябрь +140', y.curve.length === 12 && y.curve[8].cumulative === 20 && y.curve[9].cumulative === 140);
ok('прошлый год — 2025, пусто, без дельты по винрейту', y.prevKey === '2025' && y.delta.hasPrev === false && y.delta.winrate === null);

ok('список периодов: октябрь, затем сентябрь', listPeriods(realTrades, paperTrades, 'month').map((x) => x.key).join() === '2026-10,2026-09');
ok('список лет', listPeriods(realTrades, paperTrades, 'year').map((x) => x.key).join() === '2026');
ok('январь → декабрь прошлого года', prevPeriodKey('month', '2026-01') === '2025-12');
// Фильтр по стратегиям: названия и счёт сделок за всё время.
ok('название стратегии: реальная без названия — «Вручную», бумажная — «Без названия»', strategyNameOf({}, 'real') === 'Вручную' && strategyNameOf({}, 'paper') === 'Без названия');
ok('название стратегии: берётся entryStrategyName, у реальных запасной strategyName', strategyNameOf({ entryStrategyName: 'А' }, 'real') === 'А' && strategyNameOf({ strategyName: 'Б' }, 'real') === 'Б');
const names = listStrategyNames(realTrades, paperTrades, 'all');
ok('стратегии при старом «всё вместе» — только реальные', names.length > 0 && names.reduce((s2, n) => s2 + n.count, 0) === 5);
ok('стратегии только бумажных: А и Б', listStrategyNames(realTrades, paperTrades, 'paper').map((n) => n.name).join() === 'А,Б');
// Отчёт по одной стратегии: те же функции, на отфильтрованных сделках.
const onlyA = paperTrades.filter((t) => strategyNameOf(t, 'paper') === 'А');
const ra = buildPeriodReport({ realTrades: [], paperTrades: onlyA, scope: 'paper', type: 'month', key: '2026-10' });
ok('отчёт только по стратегии А: 2 закрытые, +150, одна строка в «Стратегиях»', ra.stats.total === 2 && ra.stats.pnl === 150 && ra.byStrategy.length === 1);
ok('открытая бумажная сделка в отчёт не попала («плавающего» результата нет)', ra.items.every((x) => x.raw.status === 'closed'));

ok('пустой период не падает',buildPeriodReport({ realTrades: [], paperTrades: [], scope: 'all', type: 'month', key: '2026-10' }).empty === true && statsOf([]).total === 0);

// Неделя (по понедельнику) и всё время.
{
  const wk = [
    { status: 'closed', pnl: 100, closedAt: '2026-11-16T10:00:00', ticker: 'A' },   // понедельник
    { status: 'closed', pnl: -40, closedAt: '2026-11-22T20:00:00', ticker: 'B' },   // воскресенье той же недели
    { status: 'closed', pnl: 30, closedAt: '2026-11-15T12:00:00', ticker: 'C' },    // воскресенье прошлой недели
    { status: 'closed', pnl: 7, closedAt: '2025-03-02T12:00:00', ticker: 'D' },
  ];
  const weeks = listPeriods(wk, [], 'week');
  ok('недели: по понедельнику, свежая первой', weeks[0].key === '2026-11-16' && weeks[1].key === '2026-11-09' && weeks.length === 3);
  ok('подпись недели', weeks[0].label === 'Неделя 16–22 ноября 2026');
  ok('прошлая неделя', prevPeriodKey('week', '2026-11-16') === '2026-11-09' && prevPeriodKey('week', '2026-03-02') === '2026-02-23');
  const rw = buildPeriodReport({ realTrades: wk, paperTrades: [], scope: 'real', type: 'week', key: '2026-11-16' });
  ok('неделя: две сделки, +60, против прошлой +30', rw.stats.total === 2 && rw.stats.pnl === 60 && rw.prevStats.pnl === 30 && rw.delta.hasPrev);
  ok('неделя: кривая по дням пн…вс', rw.curve.length === 7 && rw.curve[0].label === 'пн' && rw.curve[6].cumulative === 60);
  const ra2 = buildPeriodReport({ realTrades: wk, paperTrades: [], scope: 'real', type: 'all', key: 'all' });
  ok('всё время: все 4 сделки, без «прошлого периода»', ra2.stats.total === 4 && ra2.stats.pnl === 97 && ra2.prevKey === null && !ra2.delta.hasPrev && ra2.prevCurve.length === 0);
  ok('всё время: кривая по месяцам от первой сделки', ra2.curve.length === 21 && ra2.curve[0].label === 'мар 25' && ra2.curve[20].cumulative === 97);
  ok('всё время: один «период»', listPeriods(wk, [], 'all').length === 1 && listPeriods([], [], 'all').length === 0);
}
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки отчёта за период прошли ✓');
