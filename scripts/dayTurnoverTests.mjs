// Проверка оборота по фьючерсам и ступени тарифа (npm run test:turnover). Сеть и база не нужны.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-turn-'));
for (const f of ['commission.js', 'dayTurnover.js']) fs.copyFileSync(path.join(__dirname, '../src/services/analytics', f), path.join(tmp, f));
const { futuresTurnoverRub, turnoverStatus } = await import(pathToFileURL(path.join(tmp, 'dayTurnover.js')).href);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const now = new Date('2026-10-07T12:00:00Z'); // 15:00 МСК, 7 октября
const fut = { instrumentType: 'future', minStep: 1, minStepAmount: 1, lot: 1 };
const trades = [
  // ступени: открыто сегодня 2 по 100 000, закрыто сегодня 2 по 101 000
  { ...fut, legs: [
    { type: 'open', price: 100000, quantity: 2, timestampUtc: '2026-10-07T07:00:00Z' },
    { type: 'close', price: 101000, quantity: 2, timestampUtc: '2026-10-07T09:00:00Z' },
  ] },
  // вчерашняя сделка — не считается
  { ...fut, legs: [{ type: 'open', price: 50000, quantity: 1, timestampUtc: '2026-10-06T09:00:00Z' }] },
  // акция — не фьючерс
  { instrumentType: 'stock', legs: [{ type: 'open', price: 300, quantity: 10, timestampUtc: '2026-10-07T09:00:00Z' }] },
  // ручная сделка без ступеней: вход сегодня, выход сегодня
  { ...fut, status: 'closed', entryPrice: 1000, exitPrice: 1010, volume: 3, openedAt: '2026-10-07T08:00:00Z', closedAt: '2026-10-07T10:00:00Z' },
  // 21:30 МСК 6 октября = 18:30Z 6-го → ещё вчера по Москве; 00:30 МСК 7-го = 21:30Z 6-го → уже сегодня
  { ...fut, legs: [{ type: 'open', price: 10, quantity: 1, timestampUtc: '2026-10-06T21:30:00Z' }] },
];
const t = futuresTurnoverRub(trades, now);
ok('оборот: 200000 + 202000 + 3000 + 3030 + 10 = 408040', t === 408040);
ok('пустой журнал = 0', futuresTurnoverRub([], now) === 0 && futuresTurnoverRub(null, now) === 0);

const s = turnoverStatus('trader', 3_000_000);
ok('Трейдер, 3 млн: ставка 0.040%, до следующей ступени 2 млн', Math.abs(s.ratePct - 0.04) < 1e-9 && s.toNextRub === 2_000_000 && Math.abs(s.nextRatePct - 0.03) < 1e-9);
const s2 = turnoverStatus('trader', 7_000_000);
ok('Трейдер, 7 млн: вторая ступень 0.03%', Math.abs(s2.ratePct - 0.03) < 1e-9 && s2.toNextRub === 3_000_000);
const s3 = turnoverStatus('trader', 25_000_000);
ok('Трейдер, 25 млн: последняя ступень 0.025%, дальше нет', Math.abs(s3.ratePct - 0.025) < 1e-9 && s3.toNextRub === null && s3.nextRatePct === null);
ok('на границе 5 млн ещё первая ступень', Math.abs(turnoverStatus('trader', 5_000_000).ratePct - 0.04) < 1e-9);
ok('Инвестор: лестницы нет → null', turnoverStatus('investor', 1) === null);
ok('Премиум, 13 млн: вторая ступень 0.02%', Math.abs(turnoverStatus('premium', 13_000_000).ratePct - 0.02) < 1e-9);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки оборота прошли ✓');
