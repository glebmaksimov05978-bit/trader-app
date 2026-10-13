// Проверка раскладки бумажных сделок по стратегиям (npm run test:papergroups). Сеть и база не нужны.
import { groupPaperByStrategy, paperStrategyKey } from '../src/services/analytics/paperGroups.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const paper = [
  { entryStrategyId: 's1', entryStrategyName: 'Краткосрок', status: 'open', entryTimeframe: 'H1' },
  { entryStrategyId: 's1', entryStrategyName: 'Краткосрок', status: 'closed', pnl: 300, openedAt: '2026-10-01T10:00:00Z', closedAt: '2026-10-02T10:00:00Z', entryTimeframe: 'H1' },
  { entryStrategyId: 's1', entryStrategyName: 'Краткосрок', status: 'closed', pnl: -100, openedAt: '2026-10-03T10:00:00Z', closedAt: '2026-10-06T10:00:00Z', entryTimeframe: 'H1' },
  { entryStrategyId: 's2', entryStrategyName: 'Долгосрок', status: 'closed', pnl: 1000, openedAt: '2026-09-01T10:00:00Z', closedAt: '2026-09-21T10:00:00Z', entryTimeframe: 'D1' },
  { entryStrategyName: 'Старая без id', status: 'open' },
  { status: 'open' },
  { entryStrategyId: 's2', entryStrategyName: 'Долгосрок', status: 'partial', pnl: 50 },
];
const r = groupPaperByStrategy(paper);
const g = (k) => r.groups.find((x) => x.key === k);

ok('ключ: id, иначе имя, иначе «—»', paperStrategyKey(paper[0]) === 's1' && paperStrategyKey(paper[4]) === 'Старая без id' && paperStrategyKey(paper[5]) === '—');
ok('четыре группы', r.groups.length === 4);
ok('краткосрок: 1 открыта, 2 закрыты, итог +200, прибыльных 50%', g('s1').open === 1 && g('s1').closed === 2 && g('s1').pnl === 200 && g('s1').winrate === 50);
ok('краткосрок: средний срок 2 дня', Math.abs(g('s1').avgHoldDays - 2) < 1e-9);
ok('краткосрок: таймфрейм H1', g('s1').timeframes.join() === 'H1');
ok('долгосрок: частично закрытая считается открытой, её P&L не в итоге', g('s2').open === 1 && g('s2').closed === 1 && g('s2').pnl === 1000);
ok('сделка без стратегии подписана «Без стратегии»', g('—').label === 'Без стратегии');
ok('всего: 4 открыты, 3 закрыты, итог +1200', r.total.open === 4 && r.total.closed === 3 && r.total.pnl === 1200);
ok('пустой список не падает', groupPaperByStrategy([]).groups.length === 0 && groupPaperByStrategy(null).total.open === 0);
ok('без закрытых — доля прибыльных не выдумывается', groupPaperByStrategy([{ status: 'open' }]).total.winrate === null);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки раскладки по стратегиям прошли ✓');
