// Проверка прокси Telegram на Vercel (npm run test:tgvercel).
import handler from '../api/tg.js';
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
process.env.TELEGRAM_BOT_TOKEN = '123:abc';
const calls = [];
globalThis.fetch = async (u, i) => { calls.push(String(u)); return new Response('{"ok":true}', { status: 200 }); };
const rq = (p, m = 'POST') => new Request(`https://site.example/api/tg?path=${encodeURIComponent(p)}`, { method: m, body: m === 'POST' ? '{"text":"x"}' : undefined });
let r = await handler(rq('bot123:abc/sendMessage'));
ok('свой токен и метод — пересылается', r.status === 200 && calls[0] === 'https://api.telegram.org/bot123:abc/sendMessage');
r = await handler(rq('bot999:x/sendMessage'));
ok('чужой токен — 403', r.status === 403 && calls.length === 1);
r = await handler(rq('bot123:abc/deleteMessage'));
ok('лишний метод — 405', r.status === 405);
r = await handler(rq('bad'));
ok('кривой путь — 403', r.status === 403);
delete process.env.TELEGRAM_BOT_TOKEN;
r = await handler(rq('bot123:abc/sendMessage'));
ok('на Vercel нет токена — 403', r.status === 403);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки прокси на Vercel прошли ✓');
