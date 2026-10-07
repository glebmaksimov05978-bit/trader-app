// Проверка переноса закрытия из Telegram в Журнал (npm run test:fillsclose): тот же способ загрузки
// applyTradeClose, что и в scripts/telegram/applyFills.mjs, на выдуманной сделке. Сеть и база не нужны.
import fs from 'fs'; import os from 'os'; import path from 'path'; import { fileURLToPath, pathToFileURL } from 'url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'tp-fillstest-'));
function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src)); fs.writeFileSync(out, t, 'utf8'); return pathToFileURL(out).href;
}
// ВАЖНО: заглушка должна совпадать с той, что в applyFills.mjs — читаем её прямо оттуда.
const src = fs.readFileSync(path.join(repoRoot, 'scripts/telegram/applyFills.mjs'), 'utf8');
const stub = /fs\.writeFileSync\(path\.join\(tmp, 'trades\.js'\), `([\s\S]*?)`\);/.exec(src);
if (!stub) { console.log('✗ заглушка trades.js не найдена в applyFills.mjs'); process.exit(1); }
fs.writeFileSync(path.join(tmp, 'trades.js'), stub[1]);
fs.writeFileSync(path.join(tmp, 'tradePostmortem.js'), 'export async function computeTradePostmortem() { return null; }\n');
for (const f of ['strategy', 'commission', 'exitRules', 'indicators', 'candlestickPatterns', 'patterns', 'marketContext']) esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
const { applyTradeClose } = await import(esmify(path.join(repoRoot, 'src/services/tradeClose.js'), [["from './analytics/strategy.js'", "from './strategy.js'"], ["from './analytics/commission.js'", "from './commission.js'"]]));
const { captured } = await import(pathToFileURL(path.join(tmp, 'trades.js')).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

const trade = { id: 'T1', ticker: 'SBER', direction: 'long', instrumentType: 'stock', entryPrice: 300, volume: 10, remainingVolume: 10, lot: 10, minStep: 0.01, minStepAmount: 0, status: 'open', openedAt: { seconds: 1790000000 }, commissionRate: 0.0005 };

captured.length = 0;
let res = await applyTradeClose({ trade, exitPrice: 310, qty: 10, closedAtDate: new Date('2026-10-07T10:00:00Z'), userProfile: {}, source: 'telegram' });
ok('полное закрытие: патч перехвачен', captured.length === 1 && captured[0].id === 'T1');
ok('статус closed, остаток 0', captured[0].patch.status === 'closed' && captured[0].patch.remainingVolume === 0);
ok('P&L = (310−300)×10 лот.×10 шт = 1000 минус комиссия 30 → 970', Math.abs(captured[0].patch.pnl - 970) < 0.01);
ok('ступень закрытия добавлена с источником telegram', captured[0].patch.legs.at(-1).type === 'close' && captured[0].patch.legs.at(-1).source === 'telegram');
ok('ступень входа восстановлена, когда legs не было', captured[0].patch.legs[0].type === 'open' && captured[0].patch.legs[0].quantity === 10);

captured.length = 0;
res = await applyTradeClose({ trade, exitPrice: 305, qty: 4, closedAtDate: new Date('2026-10-07T10:00:00Z'), userProfile: {}, source: 'telegram' });
ok('частичное закрытие: статус partial, остаток 6', captured[0].patch.status === 'partial' && captured[0].patch.remainingVolume === 6 && res.partial === true);
ok('частичное: даты закрытия нет', captured[0].patch.closedAt === undefined);
if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки переноса закрытия прошли ✓');
