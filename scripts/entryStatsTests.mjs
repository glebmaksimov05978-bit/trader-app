// Проверка статистики по входам (без сети и базы).
import { buildEntryStats } from '../src/services/analytics/entryStats.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// 2026-10-05 — понедельник. 07:30 UTC = 10:30 МСК (основная сессия).
const trades = [
  { direction: 'long', pnl: 100, openedAt: '2026-10-05T07:30:00Z', closedAt: '2026-10-05T09:00:00Z' },
  { direction: 'long', pnl: -50, openedAt: '2026-10-06T16:30:00Z', closedAt: '2026-10-08T16:30:00Z' }, // вт 19:30 МСК — вечер; 2 дня
  { direction: 'short', pnl: 30, openedAt: '2026-10-05T04:00:00Z', closedAt: '2026-10-05T04:30:00Z' },  // пн 07:00 МСК — утро; 30 мин
  { direction: 'long', pnl: 10, date: '2026-10-07' },                                                  // только дата: без сессии
  { direction: 'long', status: 'open' },                                                               // без pnl — пропуск
];
const r = buildEntryStats(trades);
const g = (id) => r.groups.find((x) => x.id === id);
ok('считает только закрытые с результатом', r.total === 4);
ok('направление: лонг 3 сделки, +60', g('direction').rows.find((x) => x.label === 'Лонг').count === 3 && g('direction').rows.find((x) => x.label === 'Лонг').pnl === 60);
ok('шорт: 1 сделка, винрейт 100', g('direction').rows.find((x) => x.label === 'Шорт').winrate === 100);
ok('понедельник идёт раньше вторника', g('weekday').rows[0].label === 'Понедельник');
ok('в понедельник две сделки (МСК)', g('weekday').rows[0].count === 2);
ok('сессии: 3 разреза, без сделки с одной датой', g('session').rows.length === 3 && g('session').rows.reduce((s, x) => s + x.count, 0) === 3);
ok('удержание: корзины по возрастанию', g('hold').rows.map((x) => x.label[0]).join('') === '124');
ok('пустой список не падает', buildEntryStats([]).total === 0 && buildEntryStats(null).groups.length === 0);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки статистики по входам прошли ✓');
