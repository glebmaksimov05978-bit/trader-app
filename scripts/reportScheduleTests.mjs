// Проверка расписания автоотправки отчёта (npm run test:exportreport): когда пора слать (по Москве), защита от повторов в тот же день,
// «отправить сейчас», разовая отправка, нормализация испорченных данных, описание словами, ближайшая отправка.
import {
  defaultSchedule, normalizeSchedule, normalizeSchedules, isScheduleDue, nextRunAt, describeSchedule, describeWhen, mismatchHint, mskParts, MAX_SCHEDULES, HOURS,
} from '../src/services/report/schedule.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
// московское время → UTC-мс
const msk = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min);

// 2026-11-02 — понедельник
const weekly = defaultSchedule({ frequency: 'weekly', dayOfWeek: 0, hour: 9, period: 'last_week' });
ok('еженедельная: в понедельник до 9:00 — рано', !isScheduleDue(weekly, msk(2026, 11, 2, 8, 45)).send && /рано/.test(isScheduleDue(weekly, msk(2026, 11, 2, 8, 45)).reason));
ok('еженедельная: в понедельник в 9:00 — пора', isScheduleDue(weekly, msk(2026, 11, 2, 9, 0)).send);
ok('еженедельная: в понедельник вечером тоже (догоняет в тот же день)', isScheduleDue(weekly, msk(2026, 11, 2, 20, 0)).send);
ok('еженедельная: во вторник — не день', !isScheduleDue(weekly, msk(2026, 11, 3, 10, 0)).send);
ok('уже отправлено сегодня — не дублирует (три будильника)', !isScheduleDue(weekly, msk(2026, 11, 2, 12, 0), { lastSentOn: '2026-11-02' }).send);
ok('отправлено на прошлой неделе — на этой снова пора', isScheduleDue(weekly, msk(2026, 11, 9, 10, 0), { lastSentOn: '2026-11-02' }).send);
ok('границы по Москве: 01:30 МСК понедельника — это ещё понедельник, а 22:30 UTC воскресенья = 01:30 МСК', mskParts(Date.UTC(2026, 10, 1, 22, 30)).date === '2026-11-02' && mskParts(Date.UTC(2026, 10, 1, 22, 30)).dow === 0);

const monthly = defaultSchedule({ frequency: 'monthly', dayOfMonth: 1, hour: 10 });
ok('ежемесячная: 1-го числа после 10:00 — пора, 2-го — нет', isScheduleDue(monthly, msk(2026, 12, 1, 10, 5)).send && !isScheduleDue(monthly, msk(2026, 12, 2, 12, 0)).send);
const last = defaultSchedule({ frequency: 'monthly', dayOfMonth: 'last', hour: 9 });
ok('«последний день месяца»: 30 ноября — пора, 29-го — нет; в феврале 2027 — 28-е', isScheduleDue(last, msk(2026, 11, 30, 9, 0)).send && !isScheduleDue(last, msk(2026, 11, 29, 9, 0)).send && isScheduleDue(last, msk(2027, 2, 28, 9, 0)).send && !isScheduleDue(last, msk(2027, 2, 27, 9, 0)).send);
const d28 = defaultSchedule({ frequency: 'monthly', dayOfMonth: 28, hour: 9 });
ok('28-е число есть в каждом месяце, включая февраль', isScheduleDue(d28, msk(2027, 2, 28, 9, 0)).send);

const once = defaultSchedule({ frequency: 'once', date: '2026-12-31', hour: 12, period: 'this_year' });
ok('разовая: в назначенный день после часа — пора; до часа и в другой день — нет', isScheduleDue(once, msk(2026, 12, 31, 12, 0)).send && !isScheduleDue(once, msk(2026, 12, 31, 11, 0)).send && !isScheduleDue(once, msk(2026, 12, 30, 15, 0)).send);
ok('разовая: после отправки больше не срабатывает', !isScheduleDue(once, msk(2026, 12, 31, 18, 0), { lastSentOn: '2026-12-31' }).send);

const off = { ...weekly, enabled: false };
ok('выключенная не срабатывает', !isScheduleDue(off, msk(2026, 11, 2, 12, 0)).send);

// «отправить сейчас»
const now = msk(2026, 11, 4, 15, 0); // среда
const manual = { ...weekly, sendNowAt: now - 60000 };
ok('«Отправить сейчас»: запрос новее последней отправки — слать независимо от дня', isScheduleDue(manual, now, { lastSentAt: now - 3600000 }).send && isScheduleDue(manual, now, { lastSentAt: now - 3600000 }).manual === true);
ok('«Отправить сейчас»: если после запроса уже отправляли — повторно не шлёт', !isScheduleDue(manual, now, { lastSentAt: now - 1000 }).send);

// ближайшая отправка
const next = nextRunAt(weekly, msk(2026, 11, 4, 15, 0)); // среда → следующий понедельник
ok('ближайшая отправка еженедельной — следующий понедельник 9:00 МСК', next === msk(2026, 11, 9, 9, 0));
ok('ближайшая, если сегодня день отправки и час прошёл, но не слали — «сейчас»', nextRunAt(weekly, msk(2026, 11, 2, 12, 0)) === msk(2026, 11, 2, 12, 0));
ok('ближайшая, если сегодня уже слали — через неделю', nextRunAt(weekly, msk(2026, 11, 2, 12, 0), { lastSentOn: '2026-11-02' }) === msk(2026, 11, 9, 9, 0));
ok('ближайшая ежемесячная: 1 декабря 10:00', nextRunAt(monthly, msk(2026, 11, 4, 15, 0)) === msk(2026, 12, 1, 10, 0));
ok('ближайшая разовой после отправки — нет', nextRunAt(once, msk(2026, 12, 31, 18, 0), { lastSentOn: '2026-12-31' }) === null);
ok('выключенная — нет ближайшей', nextRunAt(off, now) === null);

// нормализация
ok('испорченные данные приводятся к допустимым', (() => { const s = normalizeSchedule({ frequency: 'daily', hour: 3, dayOfWeek: 9, dayOfMonth: 40, period: 'next_decade', scope: 'x', sections: ['zzz'], strategies: [1, 'А'] }); return s.frequency === 'monthly' && s.hour === 9 && s.dayOfWeek === 0 && s.dayOfMonth === 1 && s.period === 'last_month' && s.scope === 'real' && s.sections.includes('summary') && s.strategies.join() === 'А'; })());
ok('разовая без даты отбрасывается; не объект — null', normalizeSchedule({ frequency: 'once' }) === null && normalizeSchedule(null) === null && normalizeSchedule('x') === null);
ok('список ограничен пятью расписаниями', normalizeSchedules(Array.from({ length: 9 }, () => ({ frequency: 'weekly' }))).length === MAX_SCHEDULES);
ok('канал всегда «telegram» (почта пока не подключена)', normalizeSchedule({ frequency: 'weekly', channel: 'email' }).channel === 'telegram');
ok('часы — только те, когда работают будильники (7–22)', HOURS[0] === 7 && HOURS[HOURS.length - 1] === 22);
ok('расписание проходит через JSON без потерь', JSON.stringify(JSON.parse(JSON.stringify(weekly))) === JSON.stringify(weekly));

// описание
ok('описание: «Каждую пятницу в 18:00 · за прошлую неделю»', describeSchedule(defaultSchedule({ frequency: 'weekly', dayOfWeek: 4, hour: 18, period: 'last_week' })) === 'Каждую пятницу в 18:00 · за прошлую неделю');
ok('описание: воскресенье — «Каждое воскресенье»', describeWhen(defaultSchedule({ frequency: 'weekly', dayOfWeek: 6, hour: 9 })) === 'Каждое воскресенье в 9:00');
ok('описание: склонение по каждому дню недели', [0, 1, 2, 3, 4, 5, 6].map((d) => describeWhen(defaultSchedule({ frequency: 'weekly', dayOfWeek: d, hour: 9 }))).join('|') === 'Каждый понедельник в 9:00|Каждый вторник в 9:00|Каждую среду в 9:00|Каждый четверг в 9:00|Каждую пятницу в 9:00|Каждую субботу в 9:00|Каждое воскресенье в 9:00');
ok('описание: «Каждый месяц, 1-го числа, в 9:00 · за прошлый месяц»', describeSchedule(defaultSchedule()) === 'Каждый месяц, 1-го числа, в 9:00 · за прошлый месяц');
ok('описание разовой: «Один раз: 31 декабря 2026 в 12:00»', describeWhen(once) === 'Один раз: 31 декабря 2026 в 12:00');
ok('подсказка о несоответствии: еженедельно за «прошлый год»', /одинаковыми/.test(mismatchHint({ frequency: 'weekly', period: 'last_year' })) && mismatchHint(weekly) === '');

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки расписания отчёта прошли ✓');
