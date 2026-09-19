// scripts/scheduleTests.mjs
//
// Проверка расписания торгов: npm run test:schedule
//
// Два места, где ошибиться проще всего, и обе ошибки тихие:
//
// 1. Клиринг по фьючерсам идёт с 23:50 до 00:30 — то есть ПЕРЕХОДИТ ЧЕРЕЗ ПОЛНОЧЬ.
//    Наивная проверка «минута >= начала И минута < конца» на таком окне не срабатывает
//    никогда, и клиринг просто не замечается.
// 2. Всё расписание задано в московском времени, а сервер робота живёт в UTC. Около
//    полуночи по МСК календарный день в UTC ещё вчерашний — если считать день недели по
//    UTC, ночь пятницы на субботу определится не тем днём.
//
// Отдельно проверяется, что внутридневного клиринга у фьючерсов БОЛЬШЕ НЕТ: с 23 марта
// 2026 торги идут без остановок в течение дня (подтверждено поддержкой Т-Банка). Если
// старые перерывы 14:00-14:05 и 18:50-19:05 вернутся в таблицу, робот будет молча
// пропускать живые торги — этот тест поймает.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-sched-'));

const src = path.join(repoRoot, 'src', 'services', 'marketData', 'tradingSchedule.js');
const copy = path.join(tmp, 'tradingSchedule.mjs');
fs.writeFileSync(copy, fs.readFileSync(src, 'utf8'), 'utf8');
const { marketPhase, shouldWatchNow, anyMarketOpen } = await import(pathToFileURL(copy).href);

let failed = 0;
function check(name, actual, expected) {
  const ok = actual === expected;
  console.log(`${ok ? '✓' : '✗'} ${name}: ${actual}${ok ? '' : ` (ожидалось ${expected})`}`);
  if (!ok) failed += 1;
}

// Дата ближайшего нужного дня недели с заданным МОСКОВСКИМ временем.
// Часы задаём как МСК и переводим в UTC вычитанием трёх часов: при времени до 03:00
// Date.UTC сам откатится на предыдущие календарные сутки — ровно то, что нужно, чтобы
// проверить ночной переход.
const WED = 3;
const SAT = 6;
function msk(dow, hhmm) {
  const [h, m] = hhmm.split(':').map(Number);
  let d = new Date(Date.UTC(2026, 8, 14)); // 14.09.2026, дальше шагаем вперёд
  while (d.getUTCDay() !== dow) d = new Date(d.getTime() + 86400000);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h - 3, m));
}

// --- обычные торговые часы ---
check('Фьючерс, среда 12:00 МСК — идут торги', marketPhase('future', msk(WED, '12:00')).phase, 'main');
check('Акция, среда 12:00 МСК — идут торги', marketPhase('stock', msk(WED, '12:00')).phase, 'main');
check('Фьючерс, среда 08:00 МСК — утренняя сессия', marketPhase('future', msk(WED, '08:00')).phase, 'morning');
check('Фьючерс, среда 19:30 МСК — вечерняя сессия', marketPhase('future', msk(WED, '19:30')).phase, 'evening');

// --- выходные ---
// С 2026 года Мосбиржа торгует акциями и срочным рынком почти во все выходные, 09:50–19:00
// МСК (moex.com/n95564). Раньше тест утверждал обратное («суббота — рынок закрыт»), и робот
// молчал весь выходной. Ближайшая суббота от 14.09.2026 — 19.09.2026, торговая.
const mskDate = (y, mo, d, hhmm) => {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(y, mo - 1, d, h - 3, m));
};
check('Суббота 12:00 МСК, фьючерс — идёт сессия выходного дня', marketPhase('future', msk(SAT, '12:00')).open, true);
check('Суббота 12:00 МСК, фьючерс — фаза "weekend"', marketPhase('future', msk(SAT, '12:00')).phase, 'weekend');
check('Суббота 12:00 МСК, акция — тоже торгуется', marketPhase('stock', msk(SAT, '12:00')).open, true);
check('Суббота 12:00 МСК, валюта — рынок закрыт (в выходные не торгуется)', marketPhase('currency', msk(SAT, '12:00')).open, false);
check('Суббота 09:30 МСК — сессия выходного дня ещё не началась', marketPhase('stock', msk(SAT, '09:30')).open, false);
check('Суббота 09:50 МСК — сессия началась', marketPhase('stock', msk(SAT, '09:50')).open, true);
check('Суббота 19:00 МСК — сессия уже кончилась', marketPhase('stock', msk(SAT, '19:00')).open, false);
check('Суббота 18:59 МСК — ещё идёт', marketPhase('future', msk(SAT, '18:59')).open, true);
check('Воскресенье 12:00 МСК — тоже торгуется', marketPhase('future', mskDate(2026, 9, 20, '12:00')).open, true);
// Выходные из официального списка «не торгуем» — 12–13 сентября 2026.
check('Суббота 12.09.2026 в списке нерабочих — закрыто', marketPhase('future', mskDate(2026, 9, 12, '12:00')).open, false);
check('Воскресенье 13.09.2026 в списке нерабочих — закрыто', marketPhase('stock', mskDate(2026, 9, 13, '12:00')).open, false);
// Граница суток: ночь на субботу 19.09 по МСК — 02:00 субботы = 23:00 UTC ПЯТНИЦЫ. День
// недели должен считаться по МСК, иначе это определилось бы как пятница.
check('Суббота 02:00 МСК (ещё пятница по UTC) — закрыто, но это выходной',
  marketPhase('future', mskDate(2026, 9, 19, '02:00')).phase, 'weekend');
// Выбранные трейдером сессии применяются и к выходному дню.
const noWeekend = { sessionMorning: true, sessionMain: true, sessionEvening: true, sessionWeekend: false };
check('Выходной выключен в настройках — робот в субботу не работает',
  shouldWatchNow('future', noWeekend, msk(SAT, '12:00')), false);
check('Выходной выключен — но биржа открыта', marketPhase('future', msk(SAT, '12:00')).open, true);
check('По умолчанию выходной включён', shouldWatchNow('future', undefined, msk(SAT, '12:00')), true);

// --- ГЛАВНОЕ: клиринг через полночь ---
check('Фьючерс, 23:55 МСК — клиринг', marketPhase('future', msk(WED, '23:55')).phase, 'clearing');
check('Фьючерс, 00:10 МСК (уже следующие сутки) — всё ещё клиринг',
  marketPhase('future', msk(WED, '00:10')).phase, 'clearing');
check('Фьючерс, 00:40 МСК — клиринг кончился, торгов ещё нет',
  marketPhase('future', msk(WED, '00:40')).phase, 'closed');
check('Фьючерс в клиринг — рынок закрыт', marketPhase('future', msk(WED, '23:55')).open, false);

// --- внутридневного клиринга больше НЕТ (изменение с 23.03.2026) ---
check('Фьючерс, 14:02 МСК — торги идут, дневного клиринга больше нет',
  marketPhase('future', msk(WED, '14:02')).phase, 'main');
check('Фьючерс, 18:55 МСК — торги идут, вечернего клиринга больше нет',
  marketPhase('future', msk(WED, '18:55')).phase, 'main');

// --- у акций своё расписание, и оно НЕ совпадает с фьючерсным ---
check('Акция, 18:45 МСК — основная сессия уже закрыта', marketPhase('stock', msk(WED, '18:45')).open, false);
check('Фьючерс, 18:45 МСК — в это же время ещё торгуется', marketPhase('future', msk(WED, '18:45')).open, true);
check('Акция, 23:55 МСК — просто вне торгов, клиринга у акций нет',
  marketPhase('stock', msk(WED, '23:55')).phase, 'closed');

// --- выбранные трейдером сессии ограничивают робота, но не расписание биржи ---
const noEvening = { sessionMorning: true, sessionMain: true, sessionEvening: false };
check('Вечер выключен — робот вечером не работает',
  shouldWatchNow('future', noEvening, msk(WED, '19:30')), false);
check('Вечер выключен — но биржа всё равно открыта',
  marketPhase('future', msk(WED, '19:30')).open, true);
check('Вечер выключен — днём робот работает как обычно',
  shouldWatchNow('future', noEvening, msk(WED, '12:00')), true);

const noMorning = { sessionMorning: false, sessionMain: true, sessionEvening: true };
check('Утро выключено — робот утром не работает',
  shouldWatchNow('future', noMorning, msk(WED, '08:00')), false);

// --- «открыт ли хоть какой-то рынок» — этим робот решает, просыпаться ли вообще ---
check('18:45 МСК — фьючерсы торгуются, значит просыпаться стоит',
  anyMarketOpen(undefined, msk(WED, '18:45')), true);
check('Суббота днём — идёт сессия выходного дня, просыпаться стоит',
  anyMarketOpen(undefined, msk(SAT, '12:00')), true);
check('Суббота вечером (20:00 МСК) — просыпаться незачем',
  anyMarketOpen(undefined, msk(SAT, '20:00')), false);
check('Нерабочий выходной 12.09.2026 — просыпаться незачем',
  anyMarketOpen(undefined, mskDate(2026, 9, 12, '12:00')), false);

fs.rmSync(tmp, { recursive: true, force: true });

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки расписания прошли ✓');
