// Проверка модели выгружаемого отчёта (npm run test:exportreport): периоды и их границы по Москве, итоги, кривая, разрезы,
// выбор разделов, привычки, вывод словами, пустой период, малая выборка. Сеть и база не нужны.
import {
  resolvePeriod, buildExportReport, buildVerdict, fmtMoney, fmtPct, DEFAULT_SECTIONS, SECTIONS, parseDateInput, toDateInput,
} from '../src/services/report/exportReport.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const plain = (s) => String(s).replace(/ /g, ' ');
const NOW = Date.UTC(2026, 10, 5, 12, 0); // 5 ноября 2026, 15:00 по Москве
const real = (pnl, closedAt, o = {}) => ({ status: 'closed', pnl, closedAt, ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой', ...o });
const paper = (pnl, closedAt, o = {}) => ({ status: 'closed', pnl, closedAt, ticker: 'GAZP', direction: 'long', entryStrategyName: 'Пробой', ...o });

// --- периоды ---
const oct = resolvePeriod({ preset: 'last_month', now: NOW });
ok('прошлый месяц на 5 ноября — октябрь, 31 день, прошлый для сравнения — сентябрь', oct.title === 'Октябрь 2026' && oct.days === 31 && oct.prev.title === 'Сентябрь 2026');
ok('границы по Москве: 1 октября 00:00 МСК = 30 сентября 21:00 UTC; конец — 31 октября 23:59:59 МСК', oct.from === Date.UTC(2026, 8, 30, 21, 0) && oct.to === Date.UTC(2026, 9, 31, 20, 59, 59, 999));
const lw = resolvePeriod({ preset: 'last_week', now: NOW });
ok('прошлая неделя — с понедельника по воскресенье (26 окт – 1 ноя), 7 дней', lw.days === 7 && /26 октября – 1 ноября/.test(lw.title) && /^Неделя/.test(lw.title));
const q = resolvePeriod({ preset: 'last_quarter', now: NOW });
ok('прошлый квартал — III квартал 2026, сравнение со II кварталом', q.title === 'III квартал 2026' && q.prev.title === 'II квартал 2026');
const y = resolvePeriod({ preset: 'last_year', now: NOW });
ok('прошлый год — «2025 год», сравнение с 2024', y.title === '2025 год' && y.prev.title === '2024 год' && y.days === 365);
const cur = resolvePeriod({ preset: 'this_month', now: NOW });
ok('этот месяц — с 1 по сегодня (5 дней), сравнение — те же 1–5 октября', cur.days === 5 && cur.prev.rangeText === '1–5 октября 2026');
const c = resolvePeriod({ preset: 'custom', from: '2026-10-10', to: '2026-10-20', now: NOW });
ok('свои даты: 11 дней, сравнение — предыдущие 11 дней', c.days === 11 && c.prev.rangeText === '29 сентября – 9 октября 2026');
let threw = false; try { resolvePeriod({ preset: 'custom', from: '2026-10-20', to: '2026-10-10', now: NOW }); } catch { threw = true; }
ok('конец раньше начала — ошибка', threw);
threw = false; try { resolvePeriod({ preset: 'custom', from: '', to: '', now: NOW }); } catch { threw = true; }
ok('без дат — ошибка', threw);
ok('даты из поля ввода туда-обратно', toDateInput(parseDateInput('2026-10-10')) === '2026-10-10');
const jan = resolvePeriod({ preset: 'last_month', now: Date.UTC(2026, 0, 3, 12, 0) });
ok('январь → прошлый месяц это декабрь предыдущего года, сравнение — ноябрь', jan.title === 'Декабрь 2025' && jan.prev.title === 'Ноябрь 2025');

// --- модель ---
const realTrades = [
  real(1000, '2026-10-02T10:00:00+03:00'), real(-400, '2026-10-05T10:00:00+03:00', { ticker: 'GAZP', entryStrategyName: 'Отскок' }), real(600, '2026-10-20T10:00:00+03:00'),
  real(-300, '2026-09-10T10:00:00+03:00'), real(500, '2026-09-12T10:00:00+03:00'),
  real(777, '2026-10-31T21:30:00Z'),     // 1 ноября 00:30 по Москве — это уже ноябрь
  real(555, '2026-09-30T21:00:00Z'),     // 1 октября 00:00 по Москве — уже октябрь
  { status: 'open', pnl: 999, closedAt: null },
];
const paperTrades = [paper(200, '2026-10-03T10:00:00+03:00'), paper(-50, '2026-10-04T10:00:00+03:00', { entryStrategyName: 'Отскок' })];
const m = buildExportReport({ realTrades, paperTrades, scope: 'real', period: oct, now: NOW });
ok('октябрь по реальным: 4 сделки (границы по Москве учтены), +1 755 ₽', m.stats.total === 4 && m.stats.pnl === 1755);
ok('сделка 1 ноября 00:30 МСК в октябрь не попала; сделка 1 октября 00:00 МСК — попала', !m.trades.some((t) => t.pnl === 777) && m.trades.some((t) => t.pnl === 555));
ok('сентябрь для сравнения: +200, изменение +1 555', m.prevStats.pnl === 200 && m.delta.pnl === 1555 && m.delta.hasPrev);
ok('кривая: 31 день, накоплено к концу = итогу, первая точка — 1 октября', m.curve.granularity === 'day' && m.curve.points.length === 31 && m.curve.points[30].cumulative === 1755 && m.curve.points[0].pnl === 555);
ok('лучшие сделки отсортированы (1000 первой), худшая — −400', m.best[0].pnl === 1000 && m.worst[0].pnl === -400 && m.best.length <= 5);
ok('по инструментам: SBER +2 155 и GAZP −400', m.byInstrument.find((g) => g.label === 'SBER').pnl === 2155 && m.byInstrument.find((g) => g.label === 'GAZP').pnl === -400);
ok('по стратегиям: «Пробой» +2 155, «Отскок» −400', m.byStrategy.find((g) => g.label === 'Пробой').pnl === 2155 && m.byStrategy.find((g) => g.label === 'Отскок').pnl === -400);
ok('по дням недели: сумма по дням равна итогу', Math.round(m.byWeekday.reduce((s, w) => s + w.pnl, 0)) === 1755 && m.byWeekday.reduce((s, w) => s + w.count, 0) === 4);
ok('«я против системы»: реальные +1 755, бумажные +150', m.versus.real.pnl === 1755 && m.versus.paper.pnl === 150);
ok('открытая сделка без закрытия не считается', !m.trades.some((t) => t.pnl === 999));
ok('в строках сделок — дата, тикер, сторона, стратегия', /^\d{2}\.\d{2}\.2026$/.test(m.trades[0].date) && m.trades[0].side === 'Лонг' && !!m.trades[0].strategy);

// срезы и фильтры
const mp = buildExportReport({ realTrades, paperTrades, scope: 'paper', period: oct, now: NOW });
ok('срез «бумажные»: 2 сделки, +150', mp.stats.total === 2 && mp.stats.pnl === 150 && mp.meta.scopeLabel === 'Бумажные');
const ma = buildExportReport({ realTrades, paperTrades, scope: 'all', period: oct, now: NOW });
ok('«всё вместе»: 6 сделок; в стратегиях виден источник (реал/бумага)', ma.stats.total === 6 && ma.byStrategy.some((g) => /бумага/.test(g.label)) && ma.byStrategy.some((g) => /реал/.test(g.label)));
const mf = buildExportReport({ realTrades, paperTrades, scope: 'real', strategyNames: ['Отскок'], period: oct, now: NOW });
ok('фильтр по стратегии «Отскок»: 1 сделка, −400, в шапке указан фильтр', mf.stats.total === 1 && mf.stats.pnl === -400 && mf.meta.strategiesText === 'Отскок');
ok('без фильтра в шапке — «Все стратегии»', m.meta.strategiesText === 'Все стратегии');

// гранулярность кривой
const q3 = buildExportReport({ realTrades, paperTrades, period: q, now: NOW });
ok('квартал (92 дня) — кривая по неделям', q3.curve.granularity === 'week' && q3.curve.points.length >= 13);
const yr = buildExportReport({ realTrades, paperTrades, period: y, now: NOW });
ok('год — кривая по месяцам, 12 точек', yr.curve.granularity === 'month' && yr.curve.points.length === 12);

// пустой период и малая выборка
const empty = buildExportReport({ realTrades, paperTrades, period: resolvePeriod({ preset: 'custom', from: '2025-01-01', to: '2025-01-31', now: NOW }), now: NOW });
ok('пустой период: помечен, вывод — «закрытых сделок не было»', empty.empty && /закрытых сделок не было/.test(empty.verdict));
ok('малая выборка (4 сделки) — предупреждение о предварительных выводах', m.notes.some((n) => /предварительные/.test(n)));

// вывод словами
ok('вывод: период, число сделок и результат', /Октябрь 2026: 4 закрытые сделки, результат \+1 755 ₽/.test(plain(m.verdict)));
ok('вывод содержит сравнение «лучше … на»', /лучше на/.test(m.verdict));

// привычки
const stubHabits = (trades) => ({ triggered: [{ title: 'Отыгрываетесь сразу после убытка', costRub: 4200, confidence: 'hypothesis', sampleSize: trades.length, detail: 'Подробности' }] });
const mh = buildExportReport({ realTrades, paperTrades, period: oct, habitsFn: stubHabits, now: NOW });
ok('привычки подключаются через переданный детектор; вывод называет самую дорогую (с оговоркой «пока гипотеза»)', mh.habits.list.length === 1 && mh.habits.n === 4 && /Дороже всего обошлось: отыгрываетесь/.test(mh.verdict) && /пока гипотеза/.test(mh.verdict));
const mnh = buildExportReport({ realTrades, paperTrades, period: oct, now: NOW });
ok('без детектора раздел привычек просто пустой', mnh.habits === null);
const mph = buildExportReport({ realTrades, paperTrades, scope: 'paper', period: oct, habitsFn: stubHabits, now: NOW });
ok('привычки не считаются по бумажным сделкам', mph.habits === null);

// разделы
const ms = buildExportReport({ realTrades, paperTrades, period: oct, sections: ['summary', 'curve'], now: NOW });
ok('выбор разделов сохраняется в модели', ms.sections.join() === 'summary,curve');
ok('по умолчанию включены главные разделы, список всех — 9', DEFAULT_SECTIONS.includes('summary') && DEFAULT_SECTIONS.includes('habits') && !DEFAULT_SECTIONS.includes('trades') && SECTIONS.length === 9);

// частичные закрытия
const withPartial = [...realTrades, { status: 'partial', pnl: 300, closedAt: null, ticker: 'SBER', direction: 'long', entryStrategyName: 'Пробой', legs: [] }];
const mpart = buildExportReport({ realTrades: withPartial, paperTrades, period: oct, now: NOW });
ok('открытая позиция без ступеней в итог не попадает', mpart.stats.pnl === 1755);

// формат
ok('форматирование: «+12 400 ₽», «−3 200 ₽», «0 ₽», проценты с запятой', plain(fmtMoney(12400)) === '+12 400 ₽' && plain(fmtMoney(-3200)) === '−3 200 ₽' && plain(fmtMoney(0)) === '0 ₽' && fmtPct(66.666, 1) === '66,7%');
ok('модель сериализуется в JSON без потерь (для сохранения и отправки)', JSON.stringify(JSON.parse(JSON.stringify(m))) === JSON.stringify(m));
ok('buildVerdict без данных не падает', typeof buildVerdict(empty) === 'string');

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки модели отчёта прошли ✓');
