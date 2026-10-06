// Проверка «вечных» фьючерсов: коды контрактов, выбор контракта, склейка, защита от экспирации.
// Сеть не нужна: используются только чистые функции.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-roll-'));
const md = path.join(__dirname, '../src/services/marketData');
for (const f of ['candles.js', 'futuresRoll.js']) {
  let t = fs.readFileSync(path.join(md, f), 'utf8').replace("from '../tinkoff'", "from './tinkoff.js'");
  fs.writeFileSync(path.join(tmp, f), t);
}
fs.writeFileSync(path.join(tmp, 'tinkoff.js'), 'export class TinkoffAPI {}\nexport function moneyToFloat(){return 0;}\n');
const m = await import(pathToFileURL(path.join(tmp, 'futuresRoll.js')).href);
let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const d = (s) => new Date(s);

ok('код контракта: BR дек 2026 = BRZ6', m.contractCode('BR', 2026, 12) === 'BRZ6' && m.contractCode('PT', 2027, 3) === 'PTH7');
const br = m.FUTURES_ROOTS.BR, pt = m.FUTURES_ROOTS.PT;
ok('предыдущие месячные от BRZ6: BRX6, BRV6, BRU6', m.previousCodes(br, 2026, 12, 3).map((x) => x.code).join() === 'BRX6,BRV6,BRU6');
ok('предыдущие квартальные от PTH7: PTZ6, PTU6, PTM6', m.previousCodes(pt, 2027, 3, 3).map((x) => x.code).join() === 'PTZ6,PTU6,PTM6');
ok('разбор кода BRZ6 → 12 месяц 2026', JSON.stringify(m.parseCode('BRZ6', br, d('2026-10-07'))) === '{"year":2026,"month":12}');
ok('разбор чужого кода — null', m.parseCode('XXZ6', br) === null);
ok('это корень: BR да, SBERF нет', m.isFuturesRoot('br') && !m.isFuturesRoot('SBERF'));

const now = d('2026-10-28T12:00:00Z');
const list = [
  { secid: 'BRZ6', expiry: d('2026-12-01T20:00:00Z') }, { secid: 'BRX6', expiry: d('2026-11-02T20:00:00Z') },
  { secid: 'BRV6', expiry: d('2026-10-01T20:00:00Z') }, // уже истёк
  { secid: 'BRF7', expiry: d('2027-01-04T20:00:00Z') },
];
const pick = m.pickContracts(list, now, 5);
ok('истёкший отброшен', pick.alive.length === 3 && pick.alive[0].secid === 'BRX6');
ok('ближайший = BRX6 (5 дн.), торгуемый при пороге 5 = BRX6', pick.nearest.secid === 'BRX6' && pick.tradable.secid === 'BRX6');
ok('при пороге 7 торгуемый уходит на следующий BRZ6', m.pickContracts(list, now, 7).tradable.secid === 'BRZ6');
ok('нет контракта с запасом → tradable null', m.pickContracts([list[1]], now, 30).tradable === null);

// Склейка: старый контракт торговался с ценой выше на 10% (контанго) — на стыке не должно быть скачка.
const bar = (day, close) => ({ date: d(`2026-10-${String(day).padStart(2, '0')}T00:00:00Z`), open: close, high: close + 1, low: close - 1, close, volume: 1 });
const old = { candles: [1, 2, 3, 4, 5, 6].map((x) => bar(x, 110 + x)) };      // 111..116
const cur = { candles: [4, 5, 6, 7, 8].map((x) => bar(x, 100 + x)) };          // 104..108 (с 4-го числа)
const st = m.stitchContracts([old, cur]);
ok('склейка: 3 старых бара + 5 новых', st.length === 8);
ok('базовый контракт не тронут', st[3].close === 104 && st[7].close === 108);
const ratio = 104 / 114; // 4-е число: новый 104, старый 114
ok('старые бары умножены на коэффициент стыка', Math.abs(st[2].close - 113 * ratio) < 1e-9);
ok('скачка на стыке нет (бар 3-го ≈ бар 4-го по масштабу)', Math.abs(st[2].close - st[3].close) < 3);
ok('без общих баров старая часть пропускается', m.stitchContracts([{ candles: [bar(1, 50)] }, { candles: [bar(5, 100)] }]).length === 1);
ok('пустые части не ломают', m.stitchContracts([{ candles: [] }, { candles: [] }]).length === 0 && m.stitchContracts([]).length === 0);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки фьючерсов-корней прошли ✓');
