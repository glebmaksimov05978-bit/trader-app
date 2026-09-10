// scripts/tradeCloseTests.mjs
//
// Проверка services/tradeClose.js: npm run test:close
//
// Общий код закрытия сделки, которым теперь пользуется и ручное закрытие в Журнале, и
// закрытие настоящей заявкой брокеру из Сопровождения. Firestore здесь подменён
// перехватчиком записей — ни одного реального обращения к базе.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-close-'));

function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}

// Перехватчик Firestore: updateTrade складывает патчи в массив вместо записи в базу.
const writes = [];
fs.writeFileSync(path.join(tmp, 'firebase.js'), 'export const db = {};\n');
fs.writeFileSync(path.join(tmp, 'trades.js'), `
export async function updateTrade(id, patch) {
  globalThis.__writes.push({ id, patch });
}
export function resolveOpenedAt(trade) {
  if (trade.openedAt) return new Date(trade.openedAt);
  if (trade.date) return new Date(trade.date);
  return null;
}
`);
globalThis.__writes = writes;

// Постмортем требует сеть (свечи) — не нужен для проверки арифметики закрытия, глушим.
fs.writeFileSync(path.join(tmp, 'tradePostmortem.js'), 'export async function computeTradePostmortem() { return null; }\n');

for (const f of ['indicators', 'candlestickPatterns', 'patterns', 'marketContext', 'strategy', 'exitRules', 'commission']) {
  esmify(path.join(repoRoot, `src/services/analytics/${f}.js`));
}
const closeUrl = esmify(path.join(repoRoot, 'src/services/tradeClose.js'), [
  ["from './analytics/strategy.js'", "from './strategy.js'"],
  ["from './analytics/commission.js'", "from './commission.js'"],
]);
const { computeClosePnl, applyTradeClose } = await import(closeUrl);

let fails = 0;
const ok = (c, m) => { if (!c) { console.log('  ПРОВАЛ:', m); fails++; } };

// --- computeClosePnl: та же формула, что была в Journal.js calcQuickPnl -------------
const longTrade = { entryPrice: 100, direction: 'long', lot: 1 };
const r1 = computeClosePnl({ trade: longTrade, exitPrice: 110, qty: 5, commRate: 0.0005 });
// pnl = (110-100)*5*1 = 50; commission = 100*5*1*0.0005*2 = 0.5; net = 49.5
ok(Math.abs(r1.pnl - 49.5) < 1e-9, `лонг в плюс: ожидали 49.5, получили ${r1.pnl}`);
ok(Math.abs(r1.commission - 0.5) < 1e-9, `комиссия: ожидали 0.5, получили ${r1.commission}`);

const shortTrade = { entryPrice: 100, direction: 'short', lot: 1 };
const r2 = computeClosePnl({ trade: shortTrade, exitPrice: 90, qty: 5, commRate: 0.0005 });
// шорт: pnl = (100-90)*5 = 50, та же комиссия
ok(Math.abs(r2.pnl - 49.5) < 1e-9, `шорт в плюс: ожидали 49.5, получили ${r2.pnl}`);

const futTrade = { entryPrice: 100, direction: 'long', lot: 1, minStep: 5, minStepAmount: 10 };
const r3 = computeClosePnl({ trade: futTrade, exitPrice: 115, qty: 2, commRate: 0.0004 });
// шаг цены 5 = 10 руб: (115-100)/5 = 3 шага * 10 * 2 конт. = 60; commission = 100*2*1*0.0004*2 = 0.16
ok(Math.abs(r3.pnl - (60 - 0.16)) < 1e-9, `фьючерс по шагу цены: ожидали ${60 - 0.16}, получили ${r3.pnl}`);

ok(computeClosePnl({ trade: longTrade, exitPrice: 0, qty: 5 }) === null, 'нулевая цена выхода — null, не NaN');
ok(computeClosePnl({ trade: { direction: 'long' }, exitPrice: 100, qty: 5 }) === null, 'нет цены входа — null');

// --- applyTradeClose: полное закрытие ------------------------------------------------
writes.length = 0;
const trade1 = {
  id: 't1', entryPrice: 100, direction: 'long', lot: 1, volume: 10,
  entryStrategyId: null,
};
const res1 = await applyTradeClose({
  trade: trade1, exitPrice: 110, qty: 10, closedAtDate: new Date('2026-09-15T10:00:00Z'),
  commRate: 0.0005, source: 'order',
});
console.log(`Полное закрытие: partial=${res1.partial}, remaining=${res1.remaining}, pnl=${res1.pnl}`);
ok(res1.partial === false, 'закрыт весь объём — не partial');
ok(res1.remaining === 0, 'остаток 0 после полного закрытия');
ok(writes.length === 1, `ровно одна запись в базу (постмортем заглушен), получили ${writes.length}`);
const patch1 = writes[0].patch;
ok(patch1.status === 'closed', 'статус closed');
ok(patch1.remainingVolume === 0, 'remainingVolume 0');
ok(patch1.closeDate && patch1.closedAt, 'дата закрытия проставлена');
ok(Array.isArray(patch1.legs) && patch1.legs.length === 2, `две ступени (открытие+закрытие), получили ${patch1.legs?.length}`);
ok(patch1.legs[0].type === 'open' && patch1.legs[1].type === 'close', 'первая ступень open, вторая close');
ok(patch1.legs[1].side === 'sell', 'закрытие лонга — продажа');
ok(patch1.legs[1].source === 'order', 'источник ступени — order, как передали');

// --- applyTradeClose: частичное закрытие сохраняет накопленное ------------------------
writes.length = 0;
const trade2 = {
  id: 't2', entryPrice: 200, direction: 'short', lot: 1, volume: 10, remainingVolume: 6,
  pnl: 25, commission: 3, legs: [{ type: 'open', side: 'sell', price: 200, quantity: 10, commission: 0, timestampUtc: '2026-09-01T00:00:00Z' }],
};
const res2 = await applyTradeClose({
  trade: trade2, exitPrice: 190, qty: 3, closedAtDate: new Date('2026-09-15T11:00:00Z'),
  commRate: 0.0005, source: 'manual',
});
console.log(`Частичное закрытие: partial=${res2.partial}, remaining=${res2.remaining}, pnl(этой фиксации)=${res2.pnl}`);
ok(res2.partial === true, 'объём остаётся в рынке — partial');
ok(res2.remaining === 3, `остаток должен быть 3 (6-3), получили ${res2.remaining}`);
const patch2 = writes[0].patch;
ok(patch2.status === 'partial', 'статус partial');
ok(patch2.pnl === 25 + res2.pnl, 'pnl накопленный, а не перезаписанный');
ok(!('closeDate' in patch2) && !('closedAt' in patch2), 'частичное закрытие не проставляет дату закрытия сделки');
ok(patch2.legs.length === 2, 'существующая ступень open сохранена, добавлена одна close');
ok(patch2.legs[1].side === 'buy', 'закрытие шорта — покупка');

// --- ошибка считается честно, а не проглатывается --------------------------------
let threw = false;
try {
  await applyTradeClose({ trade: { id: 't3', direction: 'long' }, exitPrice: 100, qty: 1 });
} catch { threw = true; }
ok(threw, 'закрытие без цены входа должно бросить понятную ошибку, а не тихо создать мусорный патч');

console.log(fails === 0 ? '\nВсе проверки закрытия сделки прошли ✓' : `\n${fails} проверок провалено`);
process.exit(fails ? 1 : 0);
