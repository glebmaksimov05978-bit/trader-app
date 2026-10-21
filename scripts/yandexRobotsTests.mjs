// Проверка функции роботов для Яндекс Облака (npm run test:yandexrobots): без сети и без ключей.
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import fs from 'fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mod = await import(pathToFileURL(path.join(__dirname, '../yandex/robots/index.js')).href);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// 1. Шаги совпадают с шагами GitHub workflow и указывают на существующие файлы
const root = path.resolve(__dirname, '..');
ok('все шаги указывают на существующие скрипты', mod.STEPS.every((s) => fs.existsSync(path.join(root, s.script))));
const wf = fs.readFileSync(path.join(root, '.github/workflows/traderpro-alerts.yml'), 'utf8');
ok('каждый скрипт шагов упомянут в workflow GitHub', mod.STEPS.every((s) => wf.includes(s.script.split('/').pop())));
ok('сводка идёт первым шагом', mod.STEPS[0].id === 'digest');

// 2. Диагностика: подставная сеть, секреты не попадают в ответ
const SECRET = '987654:SECRET-TOKEN-VALUE';
const seen = [];
const fakeFetch = async (url) => {
  seen.push(String(url));
  if (/firestore/.test(url)) return new Response('', { status: 404 });
  if (/api\.telegram\.org/.test(url)) throw new Error('connect ETIMEDOUT');   // Telegram с Яндекса не открывается
  if (/workers\.dev\/tg/.test(url)) return new Response('{"ok":true}', { status: 200 });
  return new Response('{}', { status: 200 });
};
const env = { TELEGRAM_BOT_TOKEN: SECRET, TELEGRAM_API_BASE: 'https://w.workers.dev/tg', RELAY_URL: 'https://functions.yandexcloud.net/abc', RELAY_KEY: 'k', CF_API_TOKEN: 'cf-secret' };
const d = await mod.diagnose(env, fakeFetch);
const json = JSON.stringify(d);
ok('секреты не печатаются', !json.includes(SECRET) && !json.includes('cf-secret'));
ok('переменные: задана / не задана', d.vars.TELEGRAM_BOT_TOKEN === 'задана' && d.vars.FIREBASE_SERVICE_ACCOUNT === 'НЕ ЗАДАНА');
const byName = Object.fromEntries(d.checks.map((c) => [c.name, c]));
ok('Telegram напрямую не открылся — это видно', byName['Telegram напрямую'].ok === false);
ok('Telegram через прокси воркера открылся', byName['Telegram через прокси воркера']?.ok === true && byName['Telegram через прокси воркера'].note === 'код 200');
ok('посредник Яндекса проверяется параметром route', seen.some((u) => u === 'https://functions.yandexcloud.net/abc?route=/health'));

// 3. Обработчик: режим diag и сухой запуск двух быстрых шагов (без ключей они сразу выходят)
process.env.ROBOTS_MODE = 'diag';
const r1 = await mod.handler({});
ok('режим diag отвечает 200 и JSON', r1.statusCode === 200 && !!JSON.parse(r1.body).checks);
process.env.ROBOTS_MODE = 'dry';
process.env.ROBOTS_STEPS = 'fills,sync';
const r2 = await mod.handler({});
const rep = JSON.parse(r2.body);
ok('сухой запуск: оба шага выполнены и завершились кодом 0', rep.report.length === 2 && rep.report.every((x) => x.code === 0));
process.env.ROBOTS_STEPS = 'alerts';
const r3 = await mod.handler({});
ok('в сухом режиме шаг без --dry (runAlerts) не запускается', JSON.parse(r3.body).report.length === 0);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки функции роботов прошли ✓');
