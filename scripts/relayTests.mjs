// Проверка посредника Т-Банка (npm run test:relay). Брокер подставной: ни одной настоящей заявки,
// сеть не нужна. Проверяется: ключ, список разрешённых методов, стоп-кран, непросачивание токена,
// и весь путь «воркер → посредник → брокер».
import { handle, ALLOWED_METHODS } from '../relay/handler.mjs';
import { tinkoff, hasBrokerAccess, checkOrderGates, relayEndpoint } from '../workers/telegram-webhook/src/orders.js';
import { handler as yandexHandler } from '../relay/yandex.mjs';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const SECRET_TOKEN = 't.SUPER-SECRET-TRADING-TOKEN';
const KEY = 'relay-key-123';
const relayEnv = { TINKOFF_TRADE_TOKEN: SECRET_TOKEN, RELAY_KEY: KEY };

let upstream = [];
let upstreamReply = () => ({ status: 200, body: { accounts: [{ id: 'A1', status: 'ACCOUNT_STATUS_OPEN', name: 'Основной' }] } });
let currentRelayEnv = relayEnv;

// Один fetch на всех: запросы на relay.test идут в handle(), остальные — «брокеру».
let primaryDown = false;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith('https://relay.test')) {
    if (primaryDown) throw new TypeError('fetch failed');
    return handle(new Request(u, init), currentRelayEnv);
  }
  if (u.startsWith('https://relay2.test')) {
    return handle(new Request(u, init), currentRelayEnv);
  }
  upstream.push({ url: u, headers: init.headers || {}, body: init.body ? JSON.parse(init.body) : null });
  const r = upstreamReply(u);
  return new Response(JSON.stringify(r.body), { status: r.status });
};
const call = (path, init, env = relayEnv) => { currentRelayEnv = env; return handle(new Request(`https://relay.test${path}`, init), env); };
const post = (path, body, headers = {}, env = relayEnv) => call(path, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) }, env);

// --- здоровье ---
let r = await call('/health');
let t = await r.text();
ok('health: отвечает и показывает «токен задан»', r.status === 200 && JSON.parse(t).brokerToken === true);
ok('health: токена и ключа в ответе НЕТ', !t.includes(SECRET_TOKEN) && !t.includes(KEY));

// --- ключ ---
upstream = [];
r = await post('/broker/UsersService/GetAccounts', {});
ok('без ключа — 403, брокеру ничего не ушло', r.status === 403 && upstream.length === 0);
r = await post('/broker/UsersService/GetAccounts', {}, { 'X-Relay-Key': 'wrong' });
ok('чужой ключ — 403', r.status === 403 && upstream.length === 0);
r = await post('/broker/UsersService/GetAccounts', {}, { 'X-Relay-Key': KEY }, { TINKOFF_TRADE_TOKEN: SECRET_TOKEN });
ok('ключ на посреднике не задан — прокси выключен (503), а не открыт', r.status === 503 && upstream.length === 0);

// --- список методов ---
r = await post('/broker/UsersService/GetInfo', {}, { 'X-Relay-Key': KEY });
ok('метод вне списка — 403', r.status === 403 && upstream.length === 0);
r = await post('/broker/SandboxService/SandboxPayIn', {}, { 'X-Relay-Key': KEY });
ok('чужой сервис — 403', r.status === 403);
ok('в списке нет ничего «лишнего» про вывод/перевод', ![...ALLOWED_METHODS].some((m) => /Withdraw|Transfer|PayIn|Cancel|Sandbox/i.test(m)));

// --- проброс ---
upstream = [];
r = await post('/broker/OperationsService/GetPositions', { accountId: 'A1' }, { 'X-Relay-Key': KEY });
ok('разрешённый метод проходит', r.status === 200 && upstream.length === 1);
ok('брокер получил токен в Authorization и нужный адрес', upstream[0].headers.Authorization === `Bearer ${SECRET_TOKEN}` && /\/rest\/tinkoff\.public\.invest\.api\.contract\.v1\.OperationsService\/GetPositions$/.test(upstream[0].url));
ok('тело запроса передано как есть', upstream[0].body.accountId === 'A1');
t = await r.text();
ok('токен не просочился в ответ', !t.includes(SECRET_TOKEN));

// --- смена адреса брокера ---
upstream = [];
await post('/broker/UsersService/GetAccounts', {}, { 'X-Relay-Key': KEY }, { ...relayEnv, TINKOFF_BASE: 'https://invest-public-api.tbank.ru/rest/' });
ok('TINKOFF_BASE меняет адрес брокера без правки кода', upstream[0].url.startsWith('https://invest-public-api.tbank.ru/rest/tinkoff.public'));

// --- стоп-кран ---
upstream = [];
r = await post('/broker/OrdersService/PostOrder', { quantity: '1' }, { 'X-Relay-Key': KEY }, { ...relayEnv, TRADING_DISABLED: 'true' });
ok('стоп-кран блокирует заявку на посреднике, брокеру ничего не ушло', r.status === 503 && upstream.length === 0);
r = await post('/broker/UsersService/GetAccounts', {}, { 'X-Relay-Key': KEY }, { ...relayEnv, TRADING_DISABLED: 'true' });
ok('чтение при стоп-кране работает (счета видно)', r.status === 200);

// --- ошибка брокера ---
upstreamReply = () => ({ status: 400, body: { message: 'bad token' } });
r = await post('/broker/UsersService/GetAccounts', {}, { 'X-Relay-Key': KEY });
t = await r.text();
ok('ошибка брокера возвращается со статусом и текстом', r.status === 400 && /bad token/.test(t));
ok('и в ошибке токена нет', !t.includes(SECRET_TOKEN));
upstreamReply = () => ({ status: 200, body: { accounts: [{ id: 'A1', status: 'ACCOUNT_STATUS_OPEN' }] } });

// --- глубокая проверка ---
r = await call('/health/broker', { method: 'GET' });
ok('/health/broker без ключа — 403', r.status === 403);
r = await call('/health/broker', { method: 'GET', headers: { 'X-Relay-Key': KEY } });
ok('/health/broker с ключом показывает число счетов', r.status === 200 && (await r.json()).accounts === 1);

// --- заявка из браузера требует Firebase-токен ---
r = await post('/order', { ticker: 'SBER', lots: 1 }, {}, { ...relayEnv, FIREBASE_PROJECT_ID: 'p', OWNER_UID: 'u' });
ok('/order без токена владельца — 403', r.status === 403);

// --- путь воркера: tinkoff() через посредника ---
upstream = [];
currentRelayEnv = relayEnv;
const workerEnv = { RELAY_URL: 'https://relay.test', RELAY_KEY: KEY }; // токена у воркера НЕТ
const data = await tinkoff(workerEnv, 'UsersService/GetAccounts', {});
ok('воркер без токена получает счета через посредника', data.accounts?.[0]?.id === 'A1' && upstream.length === 1);
ok('брокер при этом видел токен посредника, а не воркера', upstream[0].headers.Authorization === `Bearer ${SECRET_TOKEN}`);
ok('hasBrokerAccess: воркеру с посредником токен не нужен', hasBrokerAccess(workerEnv) === true && hasBrokerAccess({}) === false);
ok('ворота заявок пропускают воркера с посредником', checkOrderGates({ ...workerEnv, TICKER_WHITELIST: '*' }, { ticker: 'SBER', lots: 1, orderType: 'market' }).ok === true);
ok('а без токена и посредника — отказ', checkOrderGates({ TICKER_WHITELIST: '*' }, { ticker: 'SBER', lots: 1 }).ok === false);

let failed = false;
try { await tinkoff({ RELAY_URL: 'https://relay.test', RELAY_KEY: 'bad' }, 'UsersService/GetAccounts', {}); } catch (e) { failed = /403/.test(e.message); }
ok('неверный RELAY_KEY у воркера → понятная ошибка 403', failed);

// --- запасной посредник ---
upstream = [];
primaryDown = true;
const dr = await tinkoff({ RELAY_URL: 'https://relay.test', RELAY_URL_BACKUP: 'https://relay2.test', RELAY_KEY: KEY }, 'UsersService/GetAccounts', {});
ok('основной посредник недоступен → ответ пришёл с запасного', dr.accounts?.[0]?.id === 'A1' && upstream.length === 1);
let noBackup = false;
try { await tinkoff({ RELAY_URL: 'https://relay.test', RELAY_KEY: KEY }, 'UsersService/GetAccounts', {}); } catch (e) { noBackup = true; }
ok('запасного нет и основной лёг → понятная ошибка, а не тишина', noBackup);
primaryDown = false;
upstream = [];
upstreamReply = () => ({ status: 400, body: { message: 'bad request' } });
let e400 = null;
try { await tinkoff({ RELAY_URL: 'https://relay.test', RELAY_URL_BACKUP: 'https://relay2.test', RELAY_KEY: KEY }, 'UsersService/GetAccounts', {}); } catch (e) { e400 = e; }
ok('ошибка брокера (400) на запасной не переводится: пришла сразу, один вызов к брокеру', e400 && /400/.test(e400.message) && upstream.length === 1);
upstreamReply = () => ({ status: 200, body: { accounts: [{ id: 'A1', status: 'ACCOUNT_STATUS_OPEN' }] } });

// --- обёртка Яндекс Облака ---
currentRelayEnv = relayEnv;
process.env.TINKOFF_TRADE_TOKEN = SECRET_TOKEN; process.env.RELAY_KEY = KEY;
const y = await yandexHandler({ httpMethod: 'POST', path: '/broker/UsersService/GetAccounts', headers: { Host: 'f.example', 'X-Relay-Key': KEY, 'Content-Type': 'application/json' }, body: '{}', isBase64Encoded: false });
ok('Яндекс-обёртка: статус 200 и тело JSON', y.statusCode === 200 && JSON.parse(y.body).accounts?.length === 1);
const yb = await yandexHandler({ httpMethod: 'POST', path: '/broker/UsersService/GetAccounts', headers: { Host: 'f.example', 'X-Relay-Key': KEY }, body: Buffer.from('{}').toString('base64'), isBase64Encoded: true });
ok('Яндекс-обёртка: тело в base64 тоже разбирается', yb.statusCode === 200);
const yh = await yandexHandler({ httpMethod: 'GET', path: '/health', headers: { Host: 'f.example' }, body: null });
ok('Яндекс-обёртка: /health доступен без ключа и без токена в ответе', yh.statusCode === 200 && !yh.body.includes(SECRET_TOKEN));

// --- адрес на Яндексе: маршрут в параметре, путь после идентификатора недопустим ---
ok('relayEndpoint: обычный сервер — база + путь', relayEndpoint('https://relay.example.ru/', '/broker/UsersService/GetAccounts') === 'https://relay.example.ru/broker/UsersService/GetAccounts');
const ye = relayEndpoint('https://functions.yandexcloud.net/abc123', '/broker/UsersService/GetAccounts');
ok('relayEndpoint: Яндекс — маршрут параметром, без пути после id', ye.startsWith('https://functions.yandexcloud.net/abc123?') && /route=%2Fbroker%2FUsersService%2FGetAccounts/.test(ye) && /integration=raw/.test(ye));
const yr = await yandexHandler({ httpMethod: 'GET', path: '/', headers: { Host: 'f.example' }, queryStringParameters: { integration: 'raw', route: '/health' }, body: null });
ok('Яндекс-обёртка: ?route=/health открывает проверку здоровья', yr.statusCode === 200 && JSON.parse(yr.body).service === 'traderpro-relay');
const yb2 = await yandexHandler({ httpMethod: 'POST', path: '/', headers: { Host: 'f.example', 'X-Relay-Key': KEY }, queryStringParameters: { integration: 'raw', route: '/broker/UsersService/GetAccounts' }, body: '{}' });
ok('Яндекс-обёртка: ?route=/broker/… проходит с ключом', yb2.statusCode === 200);
const yi = await yandexHandler({ httpMethod: 'GET', path: '/', headers: { Host: 'f.example' }, queryStringParameters: { integration: 'raw' }, body: null });
ok('Яндекс-обёртка: без route — тоже здоровье (корень)', yi.statusCode === 200);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки посредника прошли ✓');
