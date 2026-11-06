// Проверка расписания автоотправки отчёта (npm run test:exportreport): когда пора слать (по Москве), защита от повторов в тот же день,
// «отправить сейчас», разовая отправка, нормализация испорченных данных, описание словами, ближайшая отправка.
import {
  defaultSchedule, normalizeSchedule, normalizeSchedules, isScheduleDue, nextRunAt, describeSchedule, describeWhen, mismatchHint, mskParts, MAX_SCHEDULES, HOURS,
  isValidEmail, describeChannels, manualPending, isValidTimeZone, zoneOffsetMs, zonedToUtc, utcLabel, hoursForZone, findDuplicate, MSK_TZ,
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
// каналы доставки
ok('по умолчанию — только Telegram; старая запись без каналов читается как Telegram', defaultSchedule().channels.join() === 'telegram' && normalizeSchedule({ frequency: 'weekly' }).channels.join() === 'telegram' && normalizeSchedule({ frequency: 'weekly', channel: 'email' }).channels.join() === 'telegram');
ok('каналы: лишнее и повторы отбрасываются, порядок сохраняется', normalizeSchedule({ frequency: 'weekly', channels: ['max', 'sms', 'max', 'telegram'] }).channels.join() === 'max,telegram');
ok('почта с корректным адресом — канал; адрес обрезается по краям', (() => { const s = normalizeSchedule({ frequency: 'weekly', channels: ['telegram', 'email'], email: '  me@mail.ru ' }); return s.channels.join() === 'telegram,email' && s.email === 'me@mail.ru'; })());
ok('почта без адреса или с испорченным адресом — не канал (иначе письмо ушло бы «в никуда»)', normalizeSchedule({ frequency: 'weekly', channels: ['telegram', 'email'], email: 'не адрес' }).channels.join() === 'telegram' && normalizeSchedule({ frequency: 'weekly', channels: ['email'] }).channels.join() === 'telegram');
ok('адрес почты: проверка (один адрес, без пробелов, запятых и переводов строк)', isValidEmail('a.b+c@mail.ru') && isValidEmail('x@sub.domain.com') && !isValidEmail('a@b') && !isValidEmail('a b@mail.ru') && !isValidEmail('a@mail.ru,b@mail.ru') && !isValidEmail('a@mail.ru\nBcc: x@y.ru') && !isValidEmail('') && !isValidEmail(null) && !isValidEmail(`${'a'.repeat(120)}@mail.ru`));
ok('описание каналов: «Telegram, почта me@mail.ru»', describeChannels({ channels: ['telegram', 'email'], email: 'me@mail.ru' }) === 'Telegram, почта me@mail.ru' && describeChannels({ channels: ['max'] }) === 'MAX');
// «Отправить сейчас» живёт сутки
const stale = { ...weekly, sendNowAt: now - 25 * 3600 * 1000 };
ok('«Отправить сейчас» старше суток считается устаревшим: робот не пытается вечно', !isScheduleDue(stale, now, {}).send && !manualPending(stale, {}, now) && manualPending({ ...weekly, sendNowAt: now - 23 * 3600 * 1000 }, {}, now));
ok('устаревший запрос не показывается как «ближайшая отправка сейчас»', nextRunAt(stale, now, {}) !== now);
ok('часы — только те, когда работают будильники (7–22)', HOURS[0] === 7 && HOURS[HOURS.length - 1] === 22);
ok('расписание проходит через JSON без потерь', JSON.stringify(JSON.parse(JSON.stringify(weekly))) === JSON.stringify(weekly));

// описание
ok('описание: «Каждую пятницу в 18:00 · за прошлую неделю»', describeSchedule(defaultSchedule({ frequency: 'weekly', dayOfWeek: 4, hour: 18, period: 'last_week' })) === 'Каждую пятницу в 18:00 · за прошлую неделю');
ok('описание: воскресенье — «Каждое воскресенье»', describeWhen(defaultSchedule({ frequency: 'weekly', dayOfWeek: 6, hour: 9 })) === 'Каждое воскресенье в 9:00');
ok('описание: склонение по каждому дню недели', [0, 1, 2, 3, 4, 5, 6].map((d) => describeWhen(defaultSchedule({ frequency: 'weekly', dayOfWeek: d, hour: 9 }))).join('|') === 'Каждый понедельник в 9:00|Каждый вторник в 9:00|Каждую среду в 9:00|Каждый четверг в 9:00|Каждую пятницу в 9:00|Каждую субботу в 9:00|Каждое воскресенье в 9:00');
ok('описание: «Каждый месяц, 1-го числа, в 9:00 · за прошлый месяц»', describeSchedule(defaultSchedule()) === 'Каждый месяц, 1-го числа, в 9:00 · за прошлый месяц');
ok('описание разовой: «Один раз: 31 декабря 2026 в 12:00»', describeWhen(once) === 'Один раз: 31 декабря 2026 в 12:00');
ok('подсказка о несоответствии: еженедельно за «прошлый год»', /одинаковыми/.test(mismatchHint({ frequency: 'weekly', period: 'last_year' })) && mismatchHint(weekly) === '');


// ---- часовые пояса ----
ok('пояс: настоящие названия принимаются, мусор — нет', isValidTimeZone('Asia/Yekaterinburg') && isValidTimeZone('Europe/Moscow') && !isValidTimeZone('Mars/Olympus') && !isValidTimeZone('') && !isValidTimeZone(null));
ok('сдвиг пояса: Москва +3, Екатеринбург +5; Нью-Йорк зимой −5, летом −4', zoneOffsetMs('Europe/Moscow', 0) === 3 * 3600e3 && zoneOffsetMs('Asia/Yekaterinburg', Date.UTC(2026, 10, 4)) === 5 * 3600e3
  && zoneOffsetMs('America/New_York', Date.UTC(2026, 10, 4)) === -5 * 3600e3 && zoneOffsetMs('America/New_York', Date.UTC(2026, 6, 4)) === -4 * 3600e3);
ok('местное время → UTC: 9:00 в Нью-Йорке — 14:00 UTC зимой и 13:00 UTC летом (переход 1 ноября 2026)', zonedToUtc(2026, 10, 2, 9, 'America/New_York') === Date.UTC(2026, 10, 2, 14) && zonedToUtc(2026, 9, 30, 9, 'America/New_York') === Date.UTC(2026, 9, 30, 13)
  && zonedToUtc(2026, 10, 2, 9, 'Europe/Moscow') === Date.UTC(2026, 10, 2, 6));
ok('подпись пояса: UTC+3, UTC+5, UTC+5:30, UTC−5', utcLabel('Europe/Moscow') === 'UTC+3' && utcLabel('Asia/Yekaterinburg', Date.UTC(2026, 10, 4)) === 'UTC+5' && utcLabel('Asia/Kolkata') === 'UTC+5:30' && utcLabel('America/New_York', Date.UTC(2026, 10, 4)) === 'UTC−5');
ok('доступные часы: в Москве 7–22; в Екатеринбурге (+2 к Москве) 9–23 и 0 (робот успевает)', hoursForZone('Europe/Moscow').join() === '7,8,9,10,11,12,13,14,15,16,17,18,19,20,21,22' && hoursForZone('Asia/Yekaterinburg', Date.UTC(2026, 10, 4)).join() === '0,9,10,11,12,13,14,15,16,17,18,19,20,21,22,23');
const ekb = defaultSchedule({ frequency: 'weekly', dayOfWeek: 0, hour: 9, tz: 'Asia/Yekaterinburg' });
ok('расписание по умолчанию — московское; в запись пояс сохраняется', defaultSchedule().tz === MSK_TZ && normalizeSchedule(ekb).tz === 'Asia/Yekaterinburg' && normalizeSchedule({ frequency: 'weekly', tz: 'Mars/X' }).tz === MSK_TZ && normalizeSchedule({ frequency: 'weekly' }).tz === MSK_TZ);
ok('екатеринбургское «понедельник 9:00» наступает в 07:00 по Москве (и не раньше)', isScheduleDue(ekb, msk(2026, 11, 2, 7, 0)).send && !isScheduleDue(ekb, msk(2026, 11, 2, 6, 45)).send);
ok('день недели считается в поясе расписания: воскресенье 23:30 по Москве — это уже понедельник в Екатеринбурге, но 9:00 ещё нет', !isScheduleDue(ekb, msk(2026, 11, 1, 23, 30)).send);
ok('«сегодня уже отправлено» — по дате в поясе расписания', !isScheduleDue(ekb, msk(2026, 11, 2, 12, 0), { lastSentOn: '2026-11-02' }).send && isScheduleDue(ekb, msk(2026, 11, 2, 12, 0), { lastSentOn: '2026-10-26' }).send);
ok('ближайшая отправка в поясе расписания: следующий понедельник 9:00 по Екатеринбургу = 07:00 по Москве', nextRunAt(ekb, msk(2026, 11, 4, 15, 0)) === msk(2026, 11, 9, 7, 0));
const nyBad = normalizeSchedule(defaultSchedule({ frequency: 'weekly', dayOfWeek: 6, hour: 18, tz: 'America/New_York' })); // 18:00 в Нью-Йорке — 02:00 ночи по Москве, робот в это время не работает
ok('час вне окна робота для этого пояса при чтении заменяется допустимым', hoursForZone('America/New_York').includes(nyBad.hour) && nyBad.hour !== 18);
const nyOk = defaultSchedule({ frequency: 'weekly', dayOfWeek: 6, hour: 12, tz: 'America/New_York' });
ok('летнее время учитывается: воскресенье 12:00 в Нью-Йорке — 16:00 UTC летом, 17:00 UTC зимой (переход 1 ноября 2026)', nextRunAt(nyOk, Date.UTC(2026, 10, 2, 12)) === Date.UTC(2026, 10, 8, 17) && nextRunAt(nyOk, Date.UTC(2026, 9, 19, 12)) === Date.UTC(2026, 9, 25, 16) && nextRunAt(nyOk, Date.UTC(2026, 9, 26, 12)) === Date.UTC(2026, 10, 1, 17));
ok('описание: у московского расписания поясу нет пометки, у другого — «(UTC+5)»', describeWhen(defaultSchedule({ frequency: 'weekly', dayOfWeek: 0, hour: 9 })) === 'Каждый понедельник в 9:00' && describeWhen(ekb) === 'Каждый понедельник в 9:00 (UTC+5)');

// ---- одинаковые расписания ----
const a1 = normalizeSchedule(defaultSchedule({ id: 'a', frequency: 'weekly', dayOfWeek: 4, hour: 9, period: 'last_week', sections: ['summary', 'curve'] }));
const a2 = normalizeSchedule(defaultSchedule({ id: 'b', frequency: 'weekly', dayOfWeek: 4, hour: 9, period: 'last_week', sections: ['curve', 'summary'] }));
ok('одинаковые по смыслу расписания находятся (порядок разделов не важен)', findDuplicate([a1], a2)?.id === 'a');
ok('другой час, период, срез, канал или пояс — уже не дубль', findDuplicate([a1], { ...a2, hour: 10 }) === null && findDuplicate([a1], { ...a2, period: 'last_month' }) === null && findDuplicate([a1], { ...a2, scope: 'paper' }) === null
  && findDuplicate([a1], { ...a2, channels: ['telegram', 'max'] }) === null && findDuplicate([a1], { ...a2, tz: 'Asia/Yekaterinburg', hour: 11 }) === null);
ok('само с собой (тот же id) — не дубль', findDuplicate([a1], a1) === null);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки расписания отчёта прошли ✓');
