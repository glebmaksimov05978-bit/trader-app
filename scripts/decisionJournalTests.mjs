// Проверка журнала решений (npm run test:decisions).
import { buildDecisionJournal, ENTRY_KIND_LABELS } from '../src/services/analytics/decisionJournal.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const P = (o) => ({ status: 'closed', openedAt: '2026-10-05T10:00:00Z', closedAt: '2026-10-06T10:00:00Z', ...o });
const E = { at: '2026-10-05T10:05:00Z', action: 'entered', via: 'telegram' };
const S = (reason) => ({ at: '2026-10-05T10:05:00Z', action: 'skipped', reason, via: 'app' });

const paper = [
  P({ id: 'a', pnl: 500, decisions: [E] }),
  P({ id: 'b', pnl: 300, decisions: [E] }),
  P({ id: 'c', pnl: -100, decisions: [E] }),
  P({ id: 'd', pnl: 900, decisions: [S('Не успел')] }),
  P({ id: 'e', pnl: 700, decisions: [S('Не успел')] }),
  P({ id: 'f', pnl: -400, decisions: [S('Новости')] }),
  P({ id: 'g', pnl: 50 }),                                      // без отметки
  P({ id: 'h', status: 'open', openedAt: '2026-10-12T10:00:00Z' }), // открытая без отметки — ждёт
  P({ id: 'i', status: 'open', openedAt: '2026-10-12T10:00:00Z', decisions: [E] }),
  P({ id: 'j', pnl: 5000, openedAt: '2026-09-05T10:00:00Z', closedAt: '2026-09-06T10:00:00Z', decisions: [E] }), // другой месяц
  P({ id: 'k', pnl: 10, decisions: [{ at: '2026-10-05T10:05:00Z', action: 'entered', via: 'broker' }] }),
];
const j = buildDecisionJournal({ paperTrades: paper, type: 'month', key: '2026-10' });

ok('сигналов в октябре: 9 закрытых/открытых за месяц', j.signals === 10 - 0 && j.signals === 10);
ok('из них с отметкой', j.marked === 8);
ok('без отметки', j.unmarkedSignals === 2);
ok('автоопределённых по Т-Банку — одна', j.autoCount === 1);
ok('ждут отметки сейчас: одна открытая без решения', j.waiting === 1);
ok('взятые: 4 закрытых (3 + автоопределённая), итог +710', j.followed.count === 4 && j.followed.pnl === 710);
ok('пропущенные: 3, итог +1200', j.skipped.count === 3 && j.skipped.pnl === 1200);
ok('без отметки: одна закрытая +50', j.unmarked.count === 1 && j.unmarked.pnl === 50);
ok('средняя по взятым 177,5', Math.abs(j.followed.avg - 177.5) < 1e-9);
ok('средняя по пропущенным 400', j.skipped.avg === 400);
ok('доля прибыльных среди взятых 75%', j.followed.winrate === 75);
ok('сделка другого месяца не попала', j.followed.pnl < 5000);
ok('вывод: пропущенные лучше на 223 ₽', j.verdict.enough && j.verdict.better === 'skipped' && /222|223/.test(j.verdict.text));

const r = Object.fromEntries(j.reasons.map((x) => [x.reason, x]));
ok('причины: «Не успел» — 2 сигнала, упущено 1600', r['Не успел'].count === 2 && r['Не успел'].pnl === 1600);
ok('причины: «Новости» — один сигнал, сэкономило 400', r['Новости'].count === 1 && r['Новости'].pnl === -400);
ok('причины отсортированы по числу', j.reasons[0].reason === 'Не успел');

// мало данных — выводов нет
const few = buildDecisionJournal({ paperTrades: paper.slice(0, 2), type: 'month', key: '2026-10' });
ok('мало закрытых — вывод не делается', few.verdict.enough === false);

// пропуск без причины
const noReason = buildDecisionJournal({ paperTrades: [P({ id: 'x', pnl: 1, decisions: [{ at: '2026-10-05T10:05:00Z', action: 'skipped' }] })], key: '2026-10' });
ok('пропуск без причины — «без причины»', noReason.reasons[0].reason === 'без причины');

// реальные входы
const real = [
  { status: 'closed', pnl: 400, closedAt: '2026-10-07T10:00:00Z', entryDecision: { kind: 'signal' } },
  { status: 'closed', pnl: -200, closedAt: '2026-10-07T10:00:00Z', entryDecision: { kind: 'signal' } },
  { status: 'closed', pnl: -900, closedAt: '2026-10-08T10:00:00Z', entryDecision: { kind: 'emotion' } },
  { status: 'closed', pnl: 100, closedAt: '2026-10-08T10:00:00Z' },
  { status: 'open', pnl: null },
  { status: 'closed', pnl: 999, closedAt: '2026-09-08T10:00:00Z', entryDecision: { kind: 'signal' } },
];
const jr = buildDecisionJournal({ paperTrades: [], realTrades: real, type: 'month', key: '2026-10' });
const byKind = Object.fromEntries(jr.entryKinds.map((k) => [k.kind, k]));
ok('входы по сигналу: 2, итог +200', byKind.signal.count === 2 && byKind.signal.pnl === 200);
ok('входы на эмоциях: 1, итог −900', byKind.emotion.count === 1 && byKind.emotion.pnl === -900 && byKind.emotion.label === ENTRY_KIND_LABELS.emotion);
ok('без отметки учитываются отдельно', byKind.unmarked.count === 1);
ok('год считает весь год', buildDecisionJournal({ paperTrades: [], realTrades: real, type: 'year', key: '2026' }).entryKinds.find((k) => k.kind === 'signal').count === 3);
ok('пусто: ничего нет', buildDecisionJournal({ key: '2026-10' }).hasAnything === false);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки журнала решений прошли ✓');
