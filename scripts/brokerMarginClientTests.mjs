// Проверка запроса ГО у Т-Банка прямо из приложения (npm run test:brokerclient). Сеть не нужна: ответы брокера подставные.
// Что важно: числа приходят без потери копеек, лишних запросов нет (кэш), неудача не роняет экран и не повторяется каждую секунду,
// без токена брокера не трогаем вовсе.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const src = path.join(__dirname, '../src/services');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-bmc-'));
fs.mkdirSync(path.join(tmp, 'marketData'), { recursive: true });
fs.copyFileSync(path.join(src, 'tinkoff.js'), path.join(tmp, 'tinkoff.js'));
fs.copyFileSync(path.join(src, 'marketData/brokerMargin.js'), path.join(tmp, 'marketData/brokerMargin.js'));
// В приложении импорты без «.js» (так собирает webpack); для Node дописываем расширения в копии.
fs.writeFileSync(
  path.join(tmp, 'marketData/brokerMarginClient.js'),
  fs.readFileSync(path.join(src, 'marketData/brokerMarginClient.js'), 'utf8').replace("from '../tinkoff'", "from '../tinkoff.js'").replace("from './brokerMargin'", "from './brokerMargin.js'"),
);
fs.writeFileSync(path.join(tmp, 'package.json'), '{"type":"module"}');
const C = await import(pathToFileURL(path.join(tmp, 'marketData/brokerMarginClient.js')).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) < e;

const money = (units, nano) => ({ units: String(units), nano });
let calls = [];
let mode = 'normal';
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body || '{}');
  const method = String(url).split('/').pop();
  calls.push({ method, id: body.id || body.instrumentId, auth: opts.headers.Authorization });
  const json = (o, status = 200) => ({ ok: status < 400, status, json: async () => o });
  if (mode === 'down') return json({ message: 'boom' }, 500);
  if (method === 'FutureBy') {
    if (body.id === 'MMZ6') return json({ instrument: { ticker: 'MMZ6', uid: 'u-mm', figi: 'f-mm', initialMarginOnBuy: money(2900, 120000000), initialMarginOnSell: money(3300, 500000000) } });
    if (body.id === 'NOMARGIN') return json({ instrument: { ticker: 'NOMARGIN', uid: 'u-nm', figi: 'f-nm' } });
    return json({ message: 'not found' }, 404);
  }
  if (method === 'GetFuturesMargin') return json({ initialMarginOnBuy: money(1000, 250000000), initialMarginOnSell: money(1100, 0) });
  if (method === 'FindInstrument') return json({ instruments: [] });
  return json({}, 404);
};

// 1. копейки сохраняются, обе стороны отдельно
let m = await C.fetchBrokerMargins('tok1', ['MMZ6']);
ok('ГО Т-Банка: лонг 2 900,12 и шорт 3 300,5 — без потери копеек', m.size === 1 && near(m.get('MMZ6').buy, 2900.12) && near(m.get('MMZ6').sell, 3300.5));
ok('в запросе ушёл токен пользователя', calls.length >= 1 && calls[0].auth === 'Bearer tok1');

// 2. кэш: повторный вопрос не идёт к брокеру
calls = [];
m = await C.fetchBrokerMargins('tok1', ['MMZ6']);
ok('повторно в течение получаса к брокеру не ходим', calls.length === 0 && m.get('MMZ6').buy > 0);

// 3. нет токена — брокера не трогаем
calls = [];
m = await C.fetchBrokerMargins('', ['MMZ6']);
ok('без токена — пустой ответ и ни одного запроса', m.size === 0 && calls.length === 0);
m = await C.fetchBrokerMargins('tok1', []);
ok('без списка контрактов — тоже пусто', m.size === 0 && calls.length === 0);

// 4. неизвестный контракт: в ответе его нет, повторно не мучаем брокера
C.resetBrokerMarginCache();
calls = [];
m = await C.fetchBrokerMargins('tok1', ['ZZZ9', 'MMZ6']);
ok('неизвестный контракт отсутствует в ответе, известный — есть', !m.has('ZZZ9') && m.has('MMZ6'));
const first = calls.length;
calls = [];
await C.fetchBrokerMargins('tok1', ['ZZZ9']);
ok('неудачу запоминаем на несколько минут — повторно не спрашиваем', first > 0 && calls.length === 0);

// 5. смена токена (другой пользователь) — кэш чужого не используется
calls = [];
m = await C.fetchBrokerMargins('tok2', ['MMZ6']);
ok('другой токен — всё спрашивается заново', calls.length >= 1 && calls[0].auth === 'Bearer tok2' && m.has('MMZ6'));

// 6. ГО нет в ответе по инструменту — берётся отдельным методом
C.resetBrokerMarginCache();
calls = [];
m = await C.fetchBrokerMargins('tok1', ['NOMARGIN']);
ok('нет ГО в FutureBy → запрос GetFuturesMargin; лонг 1 000,25 и шорт 1 100', calls.some((c) => c.method === 'GetFuturesMargin') && near(m.get('NOMARGIN').buy, 1000.25) && near(m.get('NOMARGIN').sell, 1100));

// 7. брокер лёг — экран не падает
C.resetBrokerMarginCache();
mode = 'down';
let threw = false;
try { m = await C.fetchBrokerMargins('tok1', ['MMZ6']); } catch { threw = true; }
ok('брокер ответил ошибкой: исключения нет, ответ пустой (останется биржевое ГО с подписью)', !threw && m.size === 0);

console.log(fails ? `\nПровалено: ${fails}` : '\nВсе проверки прошли');
process.exitCode = fails ? 1 : 0;
