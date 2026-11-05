// Проверка доставки отчёта на почту и в MAX (npm run test:exportreport). Сеть и почтовый сервер заменены заглушками;
// письмо собирается настоящим nodemailer (потоковый транспорт) — видно реальную структуру письма с вложением.
import { cleanError, smtpConfigFromEnv, maxConfigFromEnv, channelStatusFromEnv, sendEmail, sendMaxDocument, emailParts } from './reports/deliver.mjs';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const PDF = Buffer.from('%PDF-1.7 тестовый файл');

// --- настройки из окружения ---
ok('почта: без хоста, логина или пароля — не подключена', smtpConfigFromEnv({}) === null && smtpConfigFromEnv({ SMTP_HOST: 'h', SMTP_USER: 'u' }) === null);
const cfg = smtpConfigFromEnv({ SMTP_HOST: ' smtp.gmail.com ', SMTP_USER: 'me@gmail.com', SMTP_PASS: 'secret-pass' });
ok('почта: порт по умолчанию 465 (защищённое соединение), отправитель по умолчанию — сам логин', cfg.port === 465 && cfg.secure === true && cfg.from === 'me@gmail.com' && cfg.host === 'smtp.gmail.com');
ok('почта: порт 587 — без немедленного шифрования, свой адрес отправителя', (() => { const c = smtpConfigFromEnv({ SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p', SMTP_PORT: '587', SMTP_FROM: 'robot@x.ru' }); return c.port === 587 && c.secure === false && c.from === 'robot@x.ru'; })());
ok('MAX: нужен токен бота и получатель (личный чат или группа)', maxConfigFromEnv({}) === null && maxConfigFromEnv({ MAX_BOT_TOKEN: 't' }) === null && maxConfigFromEnv({ MAX_USER_ID: '5' }) === null
  && maxConfigFromEnv({ MAX_BOT_TOKEN: 't', MAX_USER_ID: '5' }).userId === '5' && maxConfigFromEnv({ MAX_BOT_TOKEN: 't', MAX_CHAT_ID: '-7' }).chatId === '-7');
ok('статус подключённых каналов', JSON.stringify(channelStatusFromEnv({ TELEGRAM_BOT_TOKEN: 'a', TELEGRAM_CHAT_ID: '1', SMTP_HOST: 'h', SMTP_USER: 'u', SMTP_PASS: 'p' })) === '{"telegram":true,"email":true,"max":false}' && JSON.stringify(channelStatusFromEnv({})) === '{"telegram":false,"email":false,"max":false}');
ok('в тексте ошибки секреты вырезаются и длина ограничена', cleanError(new Error('Invalid login: secret-pass rejected'), ['secret-pass']) === 'Invalid login: *** rejected' && cleanError('x'.repeat(500)).length === 200);

// --- почта: настоящее письмо (nodemailer, без сети) ---
let nodemailer = null;
try { nodemailer = (await import('nodemailer')).default; } catch { console.log('… nodemailer не установлен локально — проверка структуры письма пропущена (в роботе он ставится шагом установки)'); }
const model = { meta: { period: { title: 'Октябрь 2026' } } };
const parts = emailParts(model, 'Отчёт: Октябрь 2026\nРеальные\n12 сделок · +5 000 ₽ · 60% прибыльных');
ok('тема письма и текст: период, подпись, пояснение про вложение', parts.subject === 'TraderPro — отчёт: Октябрь 2026' && /12 сделок/.test(parts.text) && /вложении/.test(parts.text));
if (nodemailer) {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'unix' });
  const r = await sendEmail({ transport, from: 'me@gmail.com', to: 'client@mail.ru', ...parts, filename: 'TraderPro_report_2026-10-01_2026-10-31.pdf', buffer: PDF });
  ok('письмо отправляется без ошибок', r.ok === true);
  // повторно соберём письмо, чтобы прочитать его содержимое
  const raw = await new Promise((res, rej) => transport.sendMail({ from: { name: 'TraderPro', address: 'me@gmail.com' }, to: 'client@mail.ru', subject: parts.subject, text: parts.text, attachments: [{ filename: 'a.pdf', content: PDF, contentType: 'application/pdf' }] }, (e, info) => (e ? rej(e) : res(info.message.toString('utf8').replace(/\r\n/g, '\n')))));
  ok('в письме: получатель, тема в кодировке UTF-8, вложение application/pdf с именем файла', /To: client@mail\.ru/.test(raw) && /Subject: =\?UTF-8\?/.test(raw) && /Content-Type: application\/pdf; name=/.test(raw) && /filename=a\.pdf/.test(raw) && /From: TraderPro <me@gmail\.com>/.test(raw));
  ok('вложение — именно наш файл (содержимое совпадает после декодирования)', (() => { const part = raw.slice(raw.indexOf('Content-Type: application/pdf')); const m = /Content-Transfer-Encoding: base64\n(?:Content-Disposition:[^\n]*\n)?\n([A-Za-z0-9+/=\n]+)/.exec(part); return !!m && Buffer.from(m[1].replace(/\n/g, ''), 'base64').equals(PDF); })());
  const inj = await new Promise((res) => transport.sendMail({ from: 'me@gmail.com', to: 'x@mail.ru', subject: 'ok\nBcc: evil@x.ru', text: 't' }, (e, info) => res(e ? 'error' : info.message.toString('utf8'))));
  ok('вставить второго получателя через тему нельзя (заголовки экранируются)', !/^Bcc:/m.test(inj));
}
const failing = { sendMail: async () => { throw new Error('Invalid login: 535 secret-pass not accepted'); } };
let r = await sendEmail({ transport: failing, from: 'a@b.ru', to: 'c@d.ru', ...parts, filename: 'a.pdf', buffer: PDF, secrets: ['secret-pass'] });
ok('ошибка почтового сервера возвращается текстом, без пароля и без исключения', r.ok === false && /Invalid login/.test(r.error) && !/secret-pass/.test(r.error));
r = await sendEmail({ transport: { sendMail: async () => ({ rejected: ['c@d.ru'] }) }, from: 'a@b.ru', to: 'c@d.ru', ...parts, filename: 'a.pdf', buffer: PDF });
ok('если сервер отклонил адрес получателя — это ошибка, а не «отправлено»', r.ok === false && /отклонён/.test(r.error));
r = await sendEmail({ transport: null, from: 'a@b.ru', to: 'c@d.ru', ...parts, filename: 'a.pdf', buffer: PDF });
ok('без транспорта (почта не настроена) — понятная ошибка', r.ok === false && /не настроена/.test(r.error));

// --- MAX: загрузка файла → сообщение с вложением ---
function maxFetch({ notReadyTimes = 0, uploadStatus = 200, upToken = 'FILE-TOKEN', msgStatus = 200, msgBody = { message: {} } } = {}) {
  const calls = [];
  let notReady = notReadyTimes;
  const f = async (url, init = {}) => {
    calls.push({ url: String(url), init });
    const u = String(url);
    if (u.includes('/uploads')) return { status: 200, json: async () => ({ url: 'https://upload.example/u/123', ...(upToken ? { token: upToken } : {}) }) };
    if (u.startsWith('https://upload.example/')) return { status: uploadStatus, json: async () => ({ retval: '1' }) };
    if (u.includes('/messages')) {
      if (notReady > 0) { notReady--; return { status: 400, json: async () => ({ code: 'attachment.not.ready', message: 'Key: errors.process.attachment.file.not.processed' }) }; }
      return { status: msgStatus, json: async () => msgBody };
    }
    return { status: 404, json: async () => ({}) };
  };
  return { f, calls };
}
const noSleep = async () => {};
let m = maxFetch();
r = await sendMaxDocument({ token: 'BOT-SECRET', userId: '777', filename: 'r.pdf', buffer: PDF, caption: 'Подпись', fetchImpl: m.f, sleep: noSleep });
ok('MAX: три шага по порядку — адрес загрузки, загрузка файла, сообщение', r.ok && m.calls.length === 3 && /\/uploads\?type=file$/.test(m.calls[0].url) && m.calls[1].url === 'https://upload.example/u/123' && /\/messages\?user_id=777$/.test(m.calls[2].url));
ok('MAX: токен бота — в заголовке Authorization, не в адресе', m.calls[0].init.headers.Authorization === 'BOT-SECRET' && m.calls[2].init.headers.Authorization === 'BOT-SECRET' && m.calls.every((c) => !c.url.includes('BOT-SECRET')));
ok('MAX: токен бота НЕ уходит на адрес загрузки (он может быть на чужом сервере)', !m.calls[1].init.headers && !JSON.stringify(m.calls[1].init).includes('BOT-SECRET'));
ok('MAX: файл заливается полем «data» с именем файла', m.calls[1].init.body.get('data').name === 'r.pdf');
ok('MAX: сообщение — подпись и вложение типа file с токеном файла', (() => { const b = JSON.parse(m.calls[2].init.body); return b.text === 'Подпись' && b.attachments[0].type === 'file' && b.attachments[0].payload.token === 'FILE-TOKEN'; })());
m = maxFetch();
await sendMaxDocument({ token: 't', chatId: '-55', filename: 'r.pdf', buffer: PDF, caption: 'x'.repeat(5000), fetchImpl: m.f, sleep: noSleep });
ok('MAX: группа — chat_id в адресе; подпись режется до 4000 знаков', /\/messages\?chat_id=-55$/.test(m.calls[2].url) && JSON.parse(m.calls[2].init.body).text.length === 4000);
m = maxFetch({ notReadyTimes: 3 });
const waits = [];
r = await sendMaxDocument({ token: 't', userId: '1', filename: 'r.pdf', buffer: PDF, caption: 'c', fetchImpl: m.f, sleep: async (ms) => { waits.push(ms); } });
ok('MAX: «файл ещё не готов» — сообщение повторяется с нарастающими паузами и в итоге уходит', r.ok && m.calls.filter((c) => c.url.includes('/messages')).length === 4 && waits.join() === '1000,2000,4000');
m = maxFetch({ notReadyTimes: 99 });
r = await sendMaxDocument({ token: 't', userId: '1', filename: 'r.pdf', buffer: PDF, caption: 'c', fetchImpl: m.f, sleep: noSleep });
ok('MAX: если файл так и не стал готов — ошибка с кодом, а не бесконечный цикл', r.ok === false && /attachment\.not\.ready/.test(r.error) && m.calls.filter((c) => c.url.includes('/messages')).length === 6);
m = maxFetch({ msgStatus: 401, msgBody: { code: 'verify.token', message: 'Invalid access_token' } });
r = await sendMaxDocument({ token: 'BOT-SECRET', userId: '1', filename: 'r.pdf', buffer: PDF, caption: 'c', fetchImpl: m.f, sleep: noSleep });
ok('MAX: неверный токен — понятная ошибка без повторов и без самого токена', r.ok === false && /verify\.token/.test(r.error) && !/BOT-SECRET/.test(r.error) && m.calls.filter((c) => c.url.includes('/messages')).length === 1);
m = maxFetch({ upToken: null });
r = await sendMaxDocument({ token: 't', userId: '1', filename: 'r.pdf', buffer: PDF, caption: 'c', fetchImpl: m.f, sleep: noSleep });
ok('MAX: если токен файла не пришёл — ошибка, сообщение не отправляется', r.ok === false && /токен файла/.test(r.error) && !m.calls.some((c) => c.url.includes('/messages')));
m = maxFetch({ uploadStatus: 500 });
r = await sendMaxDocument({ token: 't', userId: '1', filename: 'r.pdf', buffer: PDF, caption: 'c', fetchImpl: m.f, sleep: noSleep });
ok('MAX: сбой загрузки файла — ошибка «загрузка файла», сообщение не отправляется', r.ok === false && /загрузка файла/.test(r.error) && !m.calls.some((c) => c.url.includes('/messages')));
r = await sendMaxDocument({ token: 'BOT-SECRET', userId: '1', filename: 'r.pdf', buffer: PDF, caption: 'c', fetchImpl: async () => { throw new Error('fetch failed: BOT-SECRET unreachable'); }, sleep: noSleep });
ok('MAX: сетевое исключение превращается в ошибку без токена', r.ok === false && /fetch failed/.test(r.error) && !/BOT-SECRET/.test(r.error));

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки доставки на почту и в MAX прошли ✓');
