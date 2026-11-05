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
