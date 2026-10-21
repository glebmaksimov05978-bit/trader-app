// Проверка прокси к Telegram в воркере (npm run test:tgproxy): чужой токен и лишние методы отклоняются.
import { handleTelegramProxy } from '../workers/telegram-webhook/src/index.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const env = { BOT_TOKEN: '123:abc' };
const req = (method = 'POST', body = '{"chat_id":1,"text":"x"}') => new Request('https://w.example/tg/x', { method, body: method === 'POST' ? body : undefined });
const calls = [];
globalThis.fetch = async (url, init) => { calls.push({ url: String(url), init }); return new Response('{"ok":true}', { status: 200 }); };

let r = await handleTelegramProxy(req(), env, '/tg/bot123:abc/sendMessage');
ok('свой токен и разрешённый метод — пересылается в Telegram', r.status === 200 && calls[0].url === 'https://api.telegram.org/bot123:abc/sendMessage' && calls[0].init.body.includes('"text":"x"'));
r = await handleTelegramProxy(req(), env, '/tg/bot999:zzz/sendMessage');
ok('чужой токен — 403, наружу ничего не уходит', r.status === 403 && calls.length === 1);
r = await handleTelegramProxy(req(), env, '/tg/bot123:abc/deleteMessage');
ok('метод вне списка — 405', r.status === 405 && calls.length === 1);
r = await handleTelegramProxy(req(), { }, '/tg/bot123:abc/sendMessage');
ok('на воркере нет токена — 403', r.status === 403);
r = await handleTelegramProxy(req(), env, '/tg/bad');
ok('кривой адрес — 403', r.status === 403);
r = await handleTelegramProxy(req('GET'), env, '/tg/bot123:abc/getMe');
ok('getMe разрешён', r.status === 200 && calls[calls.length - 1].url.endsWith('/getMe'));
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки прокси Telegram прошли ✓');
