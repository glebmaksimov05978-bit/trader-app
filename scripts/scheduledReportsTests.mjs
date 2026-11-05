// Проверка фоновой отправки отчётов (npm run test:exportreport): модули подгружаются, по расписанию собирается PDF и «отправляется»,
// отметка не даёт повторить в тот же день, ошибки отправки учитываются, «сухой» режим ничего не шлёт и не пишет.
// База и Telegram заменены заглушками.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadModules, runScheduledReports, reportCaption, sendDocument } from './reports/runScheduledReports.mjs';
import { sampleTrades } from './reports/sampleModel.mjs';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const msk = (y, m, d, h = 0, min = 0) => Date.UTC(y, m - 1, d, h - 3, min);
const M = await loadModules();
ok('модули приложения подгружаются в фоновом скрипте (движок привычек, PDF, расписание)', typeof M.buildExportReport === 'function' && typeof M.computeHabitsFor === 'function' && typeof M.isScheduleDue === 'function' && typeof M.renderPdfBuffer === 'function');

const { real, paper } = sampleTrades();
const UID = 'u1';
function fakeDb(profile) {
  const users = { [UID]: JSON.parse(JSON.stringify(profile)) };
  const writes = [];
  const merge = (a, b) => { for (const [k, v] of Object.entries(b)) a[k] = v && typeof v === 'object' && !Array.isArray(v) ? merge(a[k] && typeof a[k] === 'object' ? a[k] : {}, v) : v; return a; };
  return {
    users, writes,
    collection: (name) => ({
      doc: (id) => ({ get: async () => ({ data: () => users[id] }), set: async (data) => { writes.push({ id, data }); merge(users[id], JSON.parse(JSON.stringify(data))); } }),
      where: (_f, _op, uid) => ({ get: async () => ({ docs: (name === 'trades' ? real : paper).map((t, i) => ({ id: `${name}${i}`, data: () => ({ ...t, uid }) })) }) }),
    }),
  };
}
const sched = (o = {}) => ({ id: 's1', enabled: true, name: 'Ежемесячный', frequency: 'monthly', dayOfMonth: 1, hour: 9, period: 'last_month', scope: 'real', strategies: [], sections: ['summary', 'curve', 'habits'], ...o });
const quiet = () => {};

// --- по расписанию ---
let db = fakeDb({ displayName: 'Глеб', reportSchedules: [sched()] });
const sent = [];
const send = async (a) => { sent.push(a); return { ok: true }; };
let res = await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), send, log: quiet });
ok('1 ноября после 9:00: отчёт за октябрь собран и отправлен PDF-файлом', sent.length === 1 && sent[0].buffer.slice(0, 4).toString() === '%PDF' && /TraderPro_report_2026-10-01_2026-10-31\.pdf$/.test(sent[0].filename) && res[0].ok);
ok('подпись: период, срез, число сделок и результат', /Отчёт: Октябрь 2026\nРеальные\n\d+ сделк/.test(sent[0].caption) && /₽/.test(sent[0].caption));
ok('отметка об отправке записана в профиль (дата, время, название периода)', db.users[UID].reportSendLog.s1.lastSentOn === '2026-11-01' && db.users[UID].reportSendLog.s1.lastTitle === 'Октябрь 2026' && db.users[UID].reportSendLog.s1.lastError === null);
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 15), send, log: quiet });
ok('следующий проход будильника в тот же день отчёт НЕ дублирует', sent.length === 1);
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 2, 12, 0), send, log: quiet });
ok('в другие дни не шлёт', sent.length === 1);
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 12, 1, 9, 30), send, log: quiet });
ok('1 декабря — снова шлёт (за ноябрь)', sent.length === 2 && /2026-11-01_2026-11-30/.test(sent[1].filename));
ok('до выбранного часа не шлёт', (await runScheduledReports({ db: fakeDb({ reportSchedules: [sched()] }), uids: [UID], M, now: msk(2027, 1, 1, 8, 0), send, log: quiet })).length === 0 && sent.length === 2);

// --- ошибки ---
db = fakeDb({ reportSchedules: [sched()] });
const failSend = async () => ({ ok: false, error: 'Bad Request: chat not found' });
res = await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), send: failSend, log: quiet });
ok('ошибка Telegram: отметки «отправлено» нет, ошибка и число попыток записаны', res[0].ok === false && !db.users[UID].reportSendLog.s1.lastSentOn && /chat not found/.test(db.users[UID].reportSendLog.s1.lastError) && db.users[UID].reportSendLog.s1.tries === 1);
const sent2 = [];
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 15), send: async (a) => { sent2.push(a); return { ok: true }; }, log: quiet });
ok('на следующем проходе того же дня отправка повторяется и после успеха ошибка сбрасывается', sent2.length === 1 && db.users[UID].reportSendLog.s1.lastSentOn === '2026-11-01' && db.users[UID].reportSendLog.s1.lastError === null);
db = fakeDb({ reportSchedules: [sched()] });
let tries = 0;
for (let i = 0; i < 9; i++) await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, i), send: async () => { tries++; return { ok: false, error: 'x' }; }, log: quiet });
ok('после 6 неудачных попыток за день робот перестаёт долбить Telegram', tries === 6);

// --- «отправить сейчас», принудительно, сухой режим ---
db = fakeDb({ reportSchedules: [sched({ sendNowAt: msk(2026, 11, 4, 14, 0) })] });
const sentNow = [];
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 4, 14, 10), send: async (a) => { sentNow.push(a); return { ok: true }; }, log: quiet });
ok('«Отправить сейчас» в произвольный день: шлёт один раз', sentNow.length === 1);
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 4, 14, 25), send: async (a) => { sentNow.push(a); return { ok: true }; }, log: quiet });
ok('и больше не повторяет, пока не нажмут снова', sentNow.length === 1);
db = fakeDb({ reportSchedules: [sched({ enabled: false })] });
const sentForced = [];
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 4, 14, 0), force: true, send: async (a) => { sentForced.push(a); return { ok: true }; }, log: quiet });
ok('--force не шлёт выключенные расписания', sentForced.length === 0);
db = fakeDb({ reportSchedules: [sched()] });
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 4, 14, 0), force: true, send: async (a) => { sentForced.push(a); return { ok: true }; }, log: quiet });
ok('--force шлёт включённые независимо от дня', sentForced.length === 1);
db = fakeDb({ reportSchedules: [sched()] });
const dryDir = fs.mkdtempSync(path.join(os.tmpdir(), 'rep-dry-'));
let dryCalls = 0;
res = await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), dry: true, outDir: dryDir, send: async () => { dryCalls++; return { ok: true }; }, log: quiet });
ok('«сухой» режим: файл сохранён в папку, но ничего не отправлено и не записано в профиль', dryCalls === 0 && db.writes.length === 0 && fs.readdirSync(dryDir).some((f) => f.endsWith('.pdf')) && res[0].dry);

// --- несколько расписаний, испорченные данные ---
db = fakeDb({ reportSchedules: [sched({ id: 'a' }), sched({ id: 'b', name: 'Бумага', scope: 'paper' }), { frequency: 'once' }, null, 'мусор'] });
const sent3 = [];
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), send: async (a) => { sent3.push(a); return { ok: true }; }, log: quiet });
ok('два расписания в один день — два файла; испорченные записи пропускаются', sent3.length === 2 && /Бумажные/.test(sent3[1].caption));
ok('пользователь без расписаний — ничего не происходит', (await runScheduledReports({ db: fakeDb({}), uids: [UID], M, now: msk(2026, 11, 1, 10, 0), send, log: quiet })).length === 0);

// --- пустой период ---
db = fakeDb({ reportSchedules: [sched({ period: 'last_year' })] });
const sent4 = [];
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), send: async (a) => { sent4.push(a); return { ok: true }; }, log: quiet });
ok('за пустой период тоже присылает короткий отчёт с пометкой', sent4.length === 1 && /закрытых сделок не было/.test(sent4[0].caption));

// --- несколько каналов: Telegram + почта + MAX ---
const multi = (o = {}) => sched({ channels: ['telegram', 'email', 'max'], email: 'me@mail.ru', ...o });
const recorder = () => {
  const got = { telegram: [], email: [], max: [] };
  const mk = (ch, result = () => ({ ok: true })) => async (a) => { got[ch].push(a); return result(a); };
  return { got, mk };
};
db = fakeDb({ reportSchedules: [multi()] });
let rec = recorder();
let senders = { telegram: rec.mk('telegram'), email: rec.mk('email'), max: rec.mk('max') };
res = await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), senders, log: quiet });
ok('три канала: один и тот же PDF уходит в Telegram, на почту и в MAX', rec.got.telegram.length === 1 && rec.got.email.length === 1 && rec.got.max.length === 1 && rec.got.email[0].buffer === rec.got.max[0].buffer && res[0].ok && res[0].delivered.join() === 'telegram,email,max');
ok('на почту уходит тема и текст письма, адрес берётся из расписания', rec.got.email[0].subject === 'TraderPro — отчёт: Октябрь 2026' && /вложении/.test(rec.got.email[0].text) && rec.got.email[0].schedule.email === 'me@mail.ru');
ok('в отметке — итоги по каждому каналу, «отправлено» выставлено', db.users[UID].reportSendLog.s1.lastSentOn === '2026-11-01' && ['telegram', 'email', 'max'].every((c) => db.users[UID].reportSendLog.s1.channels[c].ok === true) && db.users[UID].reportSendLog.s1.partial === null);
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 15), senders, log: quiet });
ok('повторный проход того же дня не дублирует ни в один канал', rec.got.telegram.length === 1 && rec.got.email.length === 1 && rec.got.max.length === 1);

// почта упала, Telegram дошёл: повторяется ТОЛЬКО почта
db = fakeDb({ reportSchedules: [multi({ channels: ['telegram', 'email'] })] });
rec = recorder();
let emailOk = false;
senders = { telegram: rec.mk('telegram'), email: rec.mk('email', () => (emailOk ? { ok: true } : { ok: false, error: 'Invalid login' })) };
res = await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), senders, log: quiet });
let lg = db.users[UID].reportSendLog.s1;
ok('почта упала: дело не закрыто, ошибка подписана названием канала, Telegram засчитан', res[0].ok === false && !lg.lastSentOn && lg.lastError === 'Почта: Invalid login' && lg.partial.done.join() === 'telegram' && lg.channels.telegram.ok === true && lg.channels.email.ok === false && lg.tries === 1);
emailOk = true;
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 15), senders, log: quiet });
lg = db.users[UID].reportSendLog.s1;
ok('следующий проход: Telegram второй раз НЕ шлётся, письмо уходит, ошибка сброшена', rec.got.telegram.length === 1 && rec.got.email.length === 2 && lg.lastSentOn === '2026-11-01' && lg.lastError === null && lg.partial === null && lg.channels.email.ok === true);

// канал не подключён в роботе (нет ключей) — понятная ошибка, остальные работают
db = fakeDb({ reportSchedules: [multi({ channels: ['telegram', 'max'] })] });
rec = recorder();
res = await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), senders: { telegram: rec.mk('telegram') }, log: quiet });
lg = db.users[UID].reportSendLog.s1;
ok('канал без ключей в роботе: «MAX в роботе не подключён», Telegram при этом доставлен', rec.got.telegram.length === 1 && /MAX: канал «MAX» в роботе не подключён/.test(lg.lastError) && lg.partial.done.join() === 'telegram');
// исключение внутри отправщика не валит остальных
db = fakeDb({ reportSchedules: [multi({ channels: ['email', 'telegram'] })] });
rec = recorder();
res = await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), senders: { telegram: rec.mk('telegram'), email: async () => { throw new Error('socket hang up'); } }, log: quiet });
ok('исключение в почтовой отправке не мешает Telegram и записывается как ошибка', rec.got.telegram.length === 1 && /Почта: socket hang up/.test(db.users[UID].reportSendLog.s1.lastError));
// «Отправить сейчас» с частичным успехом: ключ запуска — запрос, а не дата
db = fakeDb({ reportSchedules: [multi({ channels: ['telegram', 'email'], sendNowAt: msk(2026, 11, 4, 14, 0) })] });
rec = recorder(); emailOk = false;
senders = { telegram: rec.mk('telegram'), email: rec.mk('email', () => (emailOk ? { ok: true } : { ok: false, error: 'x' })) };
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 4, 14, 10), senders, log: quiet });
emailOk = true;
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 4, 14, 25), senders, log: quiet });
ok('«Отправить сейчас»: упавшая почта догоняется, Telegram не дублируется', rec.got.telegram.length === 1 && rec.got.email.length === 2 && db.users[UID].reportSendLog.s1.lastSentAt === msk(2026, 11, 4, 14, 25));
// запрос «Отправить сейчас» старше суток не повторяется вечно
db = fakeDb({ reportSchedules: [multi({ channels: ['email'], sendNowAt: msk(2026, 11, 3, 10, 0) })] });
rec = recorder();
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 4, 14, 0), senders: { email: rec.mk('email', () => ({ ok: false, error: 'x' })) }, log: quiet });
ok('устаревший запрос «Отправить сейчас» (больше суток) не выполняется', rec.got.email.length === 0);
// сухой режим показывает, куда ушло бы
const dryLog = [];
db = fakeDb({ reportSchedules: [multi({ channels: ['telegram', 'email'] })] });
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), dry: true, senders: { telegram: async () => ({ ok: true }) }, channelStatus: { telegram: true, email: true, max: false }, log: (t) => dryLog.push(t) });
ok('«сухой» режим: пишет, куда ушло бы, и не трогает профиль (статус каналов тоже)', dryLog.some((t) => /→ Telegram, почта me@mail\.ru/.test(t)) && db.writes.length === 0);

// статус подключённых каналов записывается в профиль, только когда изменился
db = fakeDb({ reportSchedules: [] });
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 0), senders: {}, channelStatus: { telegram: true, email: false, max: false }, log: quiet });
ok('робот сообщает приложению, что подключено (Telegram — да, почта и MAX — нет)', db.users[UID].reportDelivery.telegram === true && db.users[UID].reportDelivery.email === false && db.users[UID].reportDelivery.max === false && typeof db.users[UID].reportDelivery.checkedAt === 'number');
const w0 = db.writes.length;
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 15), senders: {}, channelStatus: { telegram: true, email: false, max: false }, log: quiet });
ok('если ничего не изменилось — в базу ничего не пишется (лишние записи не нужны)', db.writes.length === w0);
await runScheduledReports({ db, uids: [UID], M, now: msk(2026, 11, 1, 10, 30), senders: {}, channelStatus: { telegram: true, email: true, max: false }, log: quiet });
ok('появились ключи почты — статус обновляется', db.users[UID].reportDelivery.email === true && db.writes.length === w0 + 1);

// --- отправка в Telegram ---
const calls = [];
const fakeFetch = async (url, init) => { calls.push({ url, init }); return { status: 200, json: async () => ({ ok: true }) }; };
let r = await sendDocument({ token: 'T0KEN', chatId: '123', filename: 'a.pdf', buffer: Buffer.from('%PDF-x'), caption: 'Подпись', fetchImpl: fakeFetch });
ok('sendDocument: запрос на нужный адрес методом POST, файл и чат в форме', r.ok && calls[0].url === 'https://api.telegram.org/botT0KEN/sendDocument' && calls[0].init.method === 'POST' && calls[0].init.body.get('chat_id') === '123' && calls[0].init.body.get('document').name === 'a.pdf');
r = await sendDocument({ token: 't', chatId: '1', filename: 'a.pdf', buffer: Buffer.from('x'), caption: 'c', fetchImpl: async () => ({ status: 400, json: async () => ({ ok: false, description: 'Bad Request' }) }) });
ok('sendDocument: ошибка Telegram возвращается текстом, без исключения', r.ok === false && r.error === 'Bad Request');
r = await sendDocument({ token: 't', chatId: '1', filename: 'a.pdf', buffer: Buffer.from('x'), caption: 'c', fetchImpl: async () => ({ status: 502, json: async () => { throw new Error('html'); } }) });
ok('sendDocument: ответ не JSON — ошибка «HTTP 502»', r.ok === false && r.error === 'HTTP 502');
ok('токен бота не попадает в подпись и журнал', !/T0KEN/.test(reportCaption(M.buildExportReport({ realTrades: real, paperTrades: paper, period: M.resolvePeriod({ preset: 'last_month', now: msk(2026, 11, 5, 12, 0) }) }), sched(), M)));

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки отправки отчётов по расписанию прошли ✓');
