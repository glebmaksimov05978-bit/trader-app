// Проверка учёта зафиксированной части прибыли по открытым сделкам (npm run test:realized).
import { realizedEvents, realizedOnDay, openedOnDay, partialEvents, realizedOfOpen } from '../src/services/analytics/realized.js';
import { buildPeriodReport, statsOf } from '../src/services/analytics/periodReport.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// P&L ступени: (цена − вход) × кол-во, комиссия не учитывается — чтобы цифры проверялись в уме.
const legPnl = (t, leg) => (Number(leg.price) - Number(t.entryPrice)) * Number(leg.quantity) * (t.direction === 'short' ? -1 : 1);

const partial = {
  id: 'P', ticker: 'SBER', direction: 'long', status: 'partial', entryPrice: 100, volume: 10, remainingVolume: 4, pnl: 80,
  openedAt: '2026-10-01T10:00:00Z',
  legs: [
    { type: 'open', price: 100, quantity: 10, timestampUtc: '2026-10-01T10:00:00Z' },
    { type: 'close', price: 108, quantity: 5, timestampUtc: '2026-10-05T10:00:00Z' },   // +40, 5 октября
    { type: 'close', price: 110, quantity: 1, timestampUtc: '2026-11-02T10:00:00Z' },   // +10, 2 ноября
  ],
};
const closed = { id: 'C', ticker: 'GAZP', direction: 'long', status: 'closed', pnl: 30, closedAt: '2026-10-20T10:00:00Z', openedAt: '2026-10-10T10:00:00Z' };
const open = { id: 'O', ticker: 'LKOH', direction: 'long', status: 'open', pnl: null, openedAt: '2026-10-20T08:00:00Z' };

// --- события ---
const ev = partialEvents(partial, legPnl);
ok('частичная сделка: два события по ступеням закрытия', ev.length === 2 && ev[0].pnl === 40 && ev[1].pnl === 10);
ok('без ступеней — одно событие на накопленную сумму', partialEvents({ ...partial, legs: [] , updatedAt: '2026-10-07T00:00:00Z' }, legPnl)[0].pnl === 80);
const all = realizedEvents([partial, closed, open], legPnl);
ok('события: закрытая целиком + 2 фиксации, открытая без результата не считается', all.length === 3);
ok('события отсортированы по времени', all[0].at <= all[1].at && all[1].at <= all[2].at);

// --- день ---
const d5 = realizedOnDay([partial, closed, open], new Date('2026-10-05T12:00:00Z'), legPnl);
ok('5 октября: зафиксировано +40 по частичной сделке', d5.pnl === 40 && d5.partialPnl === 40 && d5.trades === 1);
const d20 = realizedOnDay([partial, closed, open], new Date('2026-10-20T12:00:00Z'), legPnl);
ok('20 октября: закрыта GAZP +30, частичной в этот день нет', d20.pnl === 30);
ok('день без событий — ноль', realizedOnDay([partial, closed], new Date('2026-10-15T12:00:00Z'), legPnl).pnl === 0);
ok('открыто в день: открытая LKOH считается (раньше не считалась)', openedOnDay([partial, closed, open], new Date('2026-10-20T12:00:00Z')) === 1);
ok('зафиксировано по открытой сделке', realizedOfOpen(partial) === 80 && realizedOfOpen(open) === 0);

// --- отчёт ---
const oct = buildPeriodReport({ realTrades: [partial, closed, open], paperTrades: [], scope: 'real', type: 'month', key: '2026-10', legPnl });
ok('октябрь: итог +70 = закрытая +30 и фиксация по открытой +40', oct.stats.pnl === 70 && oct.stats.pnlClosed === 30 && oct.stats.realizedOpen === 40);
ok('октябрь: в числе сделок только полностью закрытые (1)', oct.stats.total === 1);
ok('октябрь: процент прибыльных не искажён частичными', oct.stats.winrate === 100);
const nov = buildPeriodReport({ realTrades: [partial, closed, open], paperTrades: [], scope: 'real', type: 'month', key: '2026-11', legPnl });
ok('ноябрь: вторая фиксация +10 попала в свой месяц, сделок 0', nov.stats.pnl === 10 && nov.stats.total === 0 && nov.empty === false);
ok('кривая октября: 5-го накоплено +40, 20-го +70', oct.curve[4].cumulative === 40 && oct.curve[19].cumulative === 70);
ok('по инструментам: SBER +40 без числа сделок', oct.byInstrument.find((x) => x.label === 'SBER').pnl === 40 && oct.byInstrument.find((x) => x.label === 'SBER').count === 0);

// после полного закрытия — один учёт, без двойного счёта
const fullyClosed = { ...partial, status: 'closed', pnl: 95, closedAt: '2026-11-02T10:00:00Z', remainingVolume: 0 };
const octAfter = buildPeriodReport({ realTrades: [fullyClosed, closed], paperTrades: [], scope: 'real', type: 'month', key: '2026-10', legPnl });
const novAfter = buildPeriodReport({ realTrades: [fullyClosed, closed], paperTrades: [], scope: 'real', type: 'month', key: '2026-11', legPnl });
ok('после закрытия целиком: итог один раз, в месяц закрытия', octAfter.stats.pnl === 30 && novAfter.stats.pnl === 95);
ok('statsOf без частичных ведёт себя как раньше', statsOf([{ pnl: 10, closed: new Date() }, { pnl: -5, closed: new Date() }]).total === 2);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки учёта фиксаций прошли ✓');
