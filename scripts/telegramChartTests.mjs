// Проверка картинки графика для Telegram и ссылок в приложение (npm run test:tgchart).
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const photo = await import(pathToFileURL(path.join(__dirname, 'telegram/signalPhoto.mjs')).href);
const links = await import(pathToFileURL(path.join(__dirname, '../src/services/alerts.js')).href);
const { nextTimeframe, aggregateWeekly, buildSignalChartSvg, buildSignalSvg, renderPng, sendPhoto } = photo;

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// ── следующий таймфрейм ──
ok('Ч1 → Д1', nextTimeframe('H1') === 'D1');
ok('Д1 → недельный', nextTimeframe('D1') === 'W1');
ok('М15 → Ч1, М5 → М15', nextTimeframe('M15') === 'H1' && nextTimeframe('M5') === 'M15');
ok('неизвестный → Д1', nextTimeframe('XX') === 'D1');

// ── недельные свечи из дневных ──
// 2026-10-26 — понедельник
const d = (day, o, h, l, c) => ({ date: new Date(Date.UTC(2026, 9, day, 7, 0)), open: o, high: h, low: l, close: c });
const days = [d(19, 10, 12, 9, 11), d(20, 11, 15, 10, 14), d(23, 14, 14.5, 8, 9), d(26, 9, 10, 8, 9.5), d(27, 9.5, 13, 9, 12)];
const weeks = aggregateWeekly(days);
ok('дни сгруппированы в 2 недели', weeks.length === 2);
ok('неделя: открытие первой, закрытие последней, экстремумы за неделю', weeks[0].open === 10 && weeks[0].close === 9 && weeks[0].high === 15 && weeks[0].low === 8);
ok('вторая неделя (пн–вт)', weeks[1].open === 9 && weeks[1].close === 12 && weeks[1].high === 13 && weeks[1].low === 8);
ok('дата недели — понедельник', new Date(weeks[1].date).getUTCDay() === 1);
ok('пустой список не ломает', aggregateWeekly([]).length === 0 && aggregateWeekly(null).length === 0);

// ── SVG ──
function gen(n, start, vol, stepMs, endMs) {
  let s = 11; const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  let p = start; const out = [];
  for (let i = 0; i < n; i++) {
    const o = p; const c = o + (rnd() - 0.5) * vol; out.push({ date: new Date(endMs - (n - i) * stepMs), open: o, high: Math.max(o, c) + rnd() * vol * 0.3, low: Math.min(o, c) - rnd() * vol * 0.3, close: c }); p = c;
  }
  return out;
}
const end = Date.UTC(2026, 9, 28, 7, 0);
const hourly = gen(150, 300, 1.2, 3600000, end);
const daily = gen(300, 300, 3, 86400000, end);
const last = hourly[hourly.length - 1];
const longTrade = { direction: 'long', entryPrice: last.open, stopLoss: last.open - 4, takeProfit: last.open + 8 };
const getCandles = async (tf) => (tf === 'H1' ? hourly : daily);

const svg = await buildSignalSvg({ ticker: 'SBER', trade: longTrade, tfKey: 'H1', signalDate: hourly[hourly.length - 2].date, getCandles });
ok('две панели: Ч1 и Д1', svg.includes('SBER  ·  Ч1') && svg.includes('SBER  ·  Д1'));
ok('в SVG нет NaN/undefined', !/NaN|undefined/.test(svg));
ok('есть плашки входа, стопа и цели', svg.includes('Вход') && svg.includes('Стоп') && svg.includes('Цель'));
ok('показано не больше 30 свечей на панель (≈ 30 тел + плашки)', (svg.match(/<rect /g) || []).length < 2 * (30 + 12) + 2);
const svgDaily = await buildSignalSvg({ ticker: 'GAZP', trade: longTrade, tfKey: 'D1', signalDate: daily[daily.length - 2].date, getCandles });
ok('дневная стратегия: вторая панель недельная (Н1)', svgDaily.includes('GAZP  ·  Н1') && svgDaily.includes('GAZP  ·  Д1'));
const shortTrade = { direction: 'short', entryPrice: last.open, stopLoss: last.open + 4, takeProfit: last.open - 8 };
const svgShort = await buildSignalSvg({ ticker: 'SBER', trade: shortTrade, tfKey: 'H1', signalDate: last.date, getCandles });
ok('шорт: подпись «шорт»', svgShort.includes('шорт') && !svgShort.includes('>лонг<'));
const noStop = await buildSignalSvg({ ticker: 'SBER', trade: { direction: 'long', entryPrice: last.open, stopLoss: null, takeProfit: null }, tfKey: 'H1', signalDate: last.date, getCandles });
ok('без стопа и цели рисуется только вход', noStop.includes('Вход') && !noStop.includes('Стоп') && !noStop.includes('Цель'));
const farTrade = { direction: 'long', entryPrice: last.open, stopLoss: last.open - 400, takeProfit: last.open + 900 };
const svgFar = await buildSignalSvg({ ticker: 'SBER', trade: farTrade, tfKey: 'H1', signalDate: last.date, getCandles });
ok('очень далёкие стоп/цель не сплющивают свечи: у края стрелка вместо линии', svgFar.includes('↑') && svgFar.includes('↓') && !/NaN/.test(svgFar));
const short5 = await buildSignalSvg({ ticker: 'X', trade: longTrade, tfKey: 'H1', signalDate: last.date, getCandles: async () => hourly.slice(0, 3) });
ok('меньше 5 свечей — картинки нет (null), а не поломанная', short5 === null);
const failHigher = await buildSignalSvg({ ticker: 'X', trade: longTrade, tfKey: 'H1', signalDate: last.date, getCandles: async (tf) => { if (tf === 'H1') return hourly; throw new Error('нет сети'); } });
ok('старший таймфрейм не загрузился — остаётся одна панель', failHigher && failHigher.includes('X  ·  Ч1') && !failHigher.includes('X  ·  Д1'));

// ── PNG ──
const png = await renderPng(svg);
ok('PNG получился (подпись PNG в начале файла)', png && png.length > 5000 && png[1] === 0x50 && png[2] === 0x4e && png[3] === 0x47);

// ── отправка ──
const calls = [];
const fakeFetch = async (url, opts) => { calls.push({ url: String(url), body: opts.body }); return new Response(JSON.stringify({ ok: true }), { status: 200 }); };
const sent = await sendPhoto({ token: 'T', chatId: '42', png: png || Buffer.from('x'), caption: 'SBER', apiBase: 'https://proxy.example', fetchImpl: fakeFetch });
ok('sendPhoto: уходит на нужный адрес через прокси-адрес', sent === true && calls[0].url === 'https://proxy.example/botT/sendPhoto');
ok('sendPhoto: форма содержит чат, подпись и файл', calls[0].body.get('chat_id') === '42' && calls[0].body.get('caption') === 'SBER' && calls[0].body.get('photo') instanceof Blob);
const badFetch = async () => new Response(JSON.stringify({ ok: false, description: 'bad' }), { status: 400 });
const origErr = console.error; console.error = () => {};
ok('Telegram отказал — false, без исключения', (await sendPhoto({ token: 'T', chatId: '1', png: Buffer.from('x'), fetchImpl: badFetch })) === false);
ok('нет токена — false', (await sendPhoto({ token: '', chatId: '1', png: Buffer.from('x') })) === false);
const throwFetch = async () => { throw new Error('сеть'); };
ok('сеть упала — false, без исключения', (await sendPhoto({ token: 'T', chatId: '1', png: Buffer.from('x'), fetchImpl: throwFetch })) === false);
console.error = origErr;

// ── ссылки ──
ok('ссылка на сделку', links.appTradeUrl('abc123') === 'https://trader-app-blue.vercel.app/cockpit?activeId=abc123');
ok('ссылка с чужим адресом и слэшем в конце', links.appTradeUrl('x', 'https://my.site/') === 'https://my.site/cockpit?activeId=x');
ok('id с опасными символами кодируется', links.appTradeUrl('a b&c') === 'https://trader-app-blue.vercel.app/cockpit?activeId=a%20b%26c');
ok('ряд кнопки: одна url-кнопка', JSON.stringify(links.appButtonRow('q')) === JSON.stringify([{ text: 'Открыть в приложении', url: 'https://trader-app-blue.vercel.app/cockpit?activeId=q' }]));

console.log(fails ? `\nПровалено: ${fails}` : '\nВсе проверки пройдены');
process.exit(fails ? 1 : 0);
