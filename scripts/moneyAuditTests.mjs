// scripts/moneyAuditTests.mjs
//
// Сверка денежных расчётов «по бумажке», до копейки (npm run test:money). Сеть и база не нужны.
// Каждый пример посчитан вручную (расчёт — в комментарии над проверкой), приложение обязано дать ровно то же число.
// Проверяются ВСЕ места, где цена превращается в рубли: общий модуль (contractMath), закрытие сделки в Журнале,
// план сделки в Калькуляторе, открытый риск, плечо и ГО, дневной оборот, импорт фьючерсов.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-money-'));

function esmify(src, extra = []) {
  let t = fs.readFileSync(src, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  for (const [a, b] of extra) t = t.split(a).join(b);
  const out = path.join(tmp, path.basename(src));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
fs.writeFileSync(path.join(tmp, 'trades.js'), 'export async function updateTrade() {}\nexport function resolveOpenedAt(t) { return t.openedAt ? new Date(t.openedAt) : null; }\n');
fs.writeFileSync(path.join(tmp, 'tradePostmortem.js'), 'export async function computeTradePostmortem() { return null; }\n');
fs.writeFileSync(path.join(tmp, 'strategy.js'), 'export function getStrategies() { return []; }\nexport function getActiveStrategy() { return null; }\n');
esmify(path.join(repoRoot, 'src/services/analytics/commission.js'));
const M = await import(esmify(path.join(repoRoot, 'src/services/contractMath.js')));
const { computeClosePnl, applyTradeClose } = await import(esmify(path.join(repoRoot, 'src/services/tradeClose.js'), [
  ["from './analytics/strategy.js'", "from './strategy.js'"], ["from './analytics/commission.js'", "from './commission.js'"],
]));
const { calcTrade, scaleToContracts } = await import(esmify(path.join(repoRoot, 'src/utils/calculator.js')));
const { positionRisk } = await import(esmify(path.join(repoRoot, 'src/services/analytics/openRisk.js')));
const L = await import(esmify(path.join(repoRoot, 'src/services/leverageMath.js')));
const { commissionRateFor } = await import(pathToFileURL(path.join(tmp, 'commission.js')).href);
// pnlFromSpec из импорта: вырезаем одну функцию, чтобы не тянуть базу и API брокера.
const importSrc = fs.readFileSync(path.join(repoRoot, 'src/services/import/importTrades.js'), 'utf8');
const fnText = importSrc.slice(importSrc.indexOf('export function pnlFromSpec'), importSrc.indexOf('// Futures P&L needs each instrument'));
fs.writeFileSync(path.join(tmp, 'pnlFromSpec.js'), fnText);
const { pnlFromSpec } = await import(pathToFileURL(path.join(tmp, 'pnlFromSpec.js')).href);

let fails = 0;
const eq = (name, got, want) => {
  const good = typeof want === 'number' ? Math.abs(got - want) < 0.005 && Math.round(got * 100) === Math.round(want * 100) : got === want;
  console.log(`${good ? '✓' : '✗'} ${name}: ${got}${good ? '' : `  (ожидалось ${want})`}`);
  if (!good) fails++;
};

// Инструменты. У фьючерса «стоимость шага» — рубли за шаг для ВСЕГО контракта (лот уже внутри), лот не умножается.
const SI = { instrumentType: 'future', lot: 1000, minStep: 1, minStepAmount: 1 };          // доллар-рубль: 1 пункт = 1 ₽
const BR = { instrumentType: 'future', lot: 10, minStep: 0.01, minStepAmount: 7.5 };       // нефть: 0,01 = 7,5 ₽ → 750 ₽ за пункт
const MM = { instrumentType: 'future', lot: 1, minStep: 0.05, minStepAmount: 0.5 };        // мини-индекс: 0,05 = 0,5 ₽ → 10 ₽ за пункт
const SBER = { instrumentType: 'stock', lot: 10 };                                          // акция, объём в лотах по 10 штук
const RATE_F = 0.0004;  // фьючерсы, тариф «Трейдер»: 0,04% с каждой стороны
const RATE_S = 0.0005;  // акции, тариф «Трейдер»: 0,05% с каждой стороны

console.log('— ставки тарифа');
eq('Трейдер, фьючерс', commissionRateFor('trader', 'future').rate, 0.0004);
eq('Трейдер, акция', commissionRateFor('trader', 'stock').rate, 0.0005);

console.log('— рубли за пункт и стоимость позиции');
eq('Si: 1 ₽ за пункт', M.rubPerPoint(SI), 1);
eq('Brent: 7,5 / 0,01 = 750 ₽ за пункт', M.rubPerPoint(BR), 750);
eq('MM: 0,5 / 0,05 = 10 ₽ за пункт', M.rubPerPoint(MM), 10);
eq('SBER: лот 10', M.rubPerPoint(SBER), 10);
// акция с заполненной «стоимостью шага» остаётся акцией: считается лотом
eq('акция с заполненной стоимостью шага — всё равно лот', M.rubPerPoint({ ...SBER, minStep: 0.01, minStepAmount: 0.1 }), 10);
eq('Si 5 контр. по 92 450 = 462 250 ₽', M.positionValueRub(SI, 92450, 5), 462250);
eq('Brent 3 контр. по 80,12 = 180 270 ₽', M.positionValueRub(BR, 80.12, 3), 180270);

console.log('— закрытие сделки (Журнал, Сопровождение, сделки системы)');
// Si лонг 5: 92 450 → 92 913. Ход 463 × 1 × 5 = 2 315,00. Комиссия (462 250 + 464 565) × 0,04% = 370,726 → 370,73.
// Чистыми 2 315 − 370,726 = 1 944,274 → 1 944,27.
let r = computeClosePnl({ trade: { ...SI, direction: 'long', entryPrice: 92450 }, exitPrice: 92913, qty: 5, commRate: RATE_F });
eq('Si лонг: результат', r.pnl, 1944.27); eq('Si лонг: комиссия', r.commission, 370.73);
// Brent шорт 3: 80,12 → 78,47. Ход 1,65 × 750 × 3 = 3 712,50. Комиссия (180 270 + 176 557,50) × 0,04% = 142,731 → 142,73.
// Чистыми 3 569,769 → 3 569,77.
r = computeClosePnl({ trade: { ...BR, direction: 'short', entryPrice: 80.12 }, exitPrice: 78.47, qty: 3, commRate: RATE_F });
eq('Brent шорт: результат', r.pnl, 3569.77); eq('Brent шорт: комиссия', r.commission, 142.73);
// Brent шорт 3 в минус: 80,12 → 81,30. Ход −1,18 × 750 × 3 = −2 655,00. Комиссия (180 270 + 182 925) × 0,04% = 145,278.
// Чистыми −2 800,278 → −2 800,28.
r = computeClosePnl({ trade: { ...BR, direction: 'short', entryPrice: 80.12 }, exitPrice: 81.3, qty: 3, commRate: RATE_F });
eq('Brent шорт в минус: результат', r.pnl, -2800.28);
// MM лонг 12: 2 469,15 → 2 481,70. Ход 12,55 × 10 × 12 = 1 506,00. Комиссия (296 298 + 297 804) × 0,04% = 237,6408 → 237,64.
// Чистыми 1 268,3592 → 1 268,36.
r = computeClosePnl({ trade: { ...MM, direction: 'long', entryPrice: 2469.15 }, exitPrice: 2481.7, qty: 12, commRate: RATE_F });
eq('MM лонг: результат', r.pnl, 1268.36); eq('MM лонг: комиссия', r.commission, 237.64);
// SBER лонг 7 лотов: 301,45 → 297,10. Ход −4,35 × 10 × 7 = −304,50. Комиссия (21 101,50 + 20 797) × 0,05% = 20,94925 → 20,95.
// Чистыми −325,44925 → −325,45.
r = computeClosePnl({ trade: { ...SBER, direction: 'long', entryPrice: 301.45 }, exitPrice: 297.1, qty: 7, commRate: RATE_S });
eq('SBER лонг в минус: результат', r.pnl, -325.45); eq('SBER: комиссия', r.commission, 20.95);
// Частями: Si 5 контр., сначала 2 по 92 700, потом 3 по 92 913.
//   2: ход 250×2 = 500; комиссия (184 900 + 185 400) × 0,04% = 148,12 → 351,88
//   3: ход 463×3 = 1 389; комиссия (277 350 + 278 739) × 0,04% = 222,4356 → 1 166,5644 → 1 166,56
const p1 = computeClosePnl({ trade: { ...SI, direction: 'long', entryPrice: 92450 }, exitPrice: 92700, qty: 2, commRate: RATE_F });
const p2 = computeClosePnl({ trade: { ...SI, direction: 'long', entryPrice: 92450 }, exitPrice: 92913, qty: 3, commRate: RATE_F });
eq('Si частями: первая часть', p1.pnl, 351.88); eq('Si частями: вторая часть', p2.pnl, 1166.56);
eq('Si частями: сумма без хвостов', Math.round((p1.pnl + p2.pnl) * 100) / 100, 1518.44);

console.log('— поле «комиссия» у сделки, открытой из приложения');
// Brent шорт 3 по 80,12: при открытии пишется только вход 180 270 × 0,04% = 72,108 → 72,11.
// Закрыли 2 по 78,47: выход 78,47 × 750 × 2 × 0,04% = 47,082 → 47,08 → всего 119,19.
// Закрыли 1 по 78,50: выход 78,50 × 750 × 0,04% = 23,55 → всего 142,74. Вход дважды не считается.
const openComm = M.sideCommission(BR, 80.12, 3, RATE_F);
eq('Brent: комиссия входа при открытии', openComm, 72.11);
const writes = [];
globalThis.__moneyWrites = writes;
let tr = { id: 'x', ...BR, direction: 'short', entryPrice: 80.12, volume: 3, remainingVolume: 3, commission: openComm, entryCommissionIncluded: true, pnl: null, openedAt: '2026-11-02T10:00:00Z' };
let res = await applyTradeClose({ trade: tr, exitPrice: 78.47, qty: 2, commRate: RATE_F });
eq('Brent: комиссия после частичного закрытия', res.patch.commission, 119.19);
// результат части: ход 1,65 × 750 × 2 = 2 475 − (120 180 + 117 705) × 0,04% = 95,154 → 2 379,846 → 2 379,85
eq('Brent: результат после частичного закрытия', res.patch.pnl, 2379.85);
tr = { ...tr, ...res.patch };
res = await applyTradeClose({ trade: tr, exitPrice: 78.5, qty: 1, commRate: RATE_F });
eq('Brent: комиссия после полного закрытия', res.patch.commission, 142.74);
// вторая часть: ход 1,62 × 750 = 1 215 − (60 090 + 58 875) × 0,04% = 47,586 → 1 167,414 → 1 167,41; всего 3 547,26
eq('Brent: результат после полного закрытия', res.patch.pnl, 3547.26);
// Старая сделка без пометки: закрытие добавляет обе стороны (как и раньше) — 0 + 95,15.
res = await applyTradeClose({ trade: { id: 'y', ...BR, direction: 'short', entryPrice: 80.12, volume: 2, remainingVolume: 2, pnl: null }, exitPrice: 78.47, qty: 2, commRate: RATE_F });
eq('сделка без пометки (ручная): комиссия за обе стороны', res.patch.commission, 95.15);

console.log('— синхронизация сделки с Т-Банком (итог по операциям брокера)');
// Si лонг: купили 3 по 92 400 и 2 по 92 525 → средняя (277 200 + 185 050) / 5 = 92 450. Продали 2 по 92 700 и 3 по 92 913.
// Это тот же пример, что «Si частями» выше: 351,88 + 1 166,56 = 1 518,44. Средний выход (185 400 + 278 739) / 5 = 92 827,80.
// Комиссия: вход 462 250 × 0,04% = 184,90; выходы 74,16 + 111,4956 → 111,50; всего 370,56.
const sl = M.summarizeLegs({ ...SI, direction: 'long' }, [
  { type: 'open', price: 92400, quantity: 3, timestampUtc: '2026-11-02T07:10:00Z' },
  { type: 'open', price: 92525, quantity: 2, timestampUtc: '2026-11-02T07:40:00Z' },
  { type: 'close', price: 92700, quantity: 2, timestampUtc: '2026-11-02T10:00:00Z' },
  { type: 'close', price: 92913, quantity: 3, timestampUtc: '2026-11-02T12:30:00Z' },
], RATE_F);
eq('Si по операциям: средний вход', sl.entryPrice, 92450); eq('Si по операциям: средний выход', sl.exitPrice, 92827.8);
eq('Si по операциям: результат', sl.pnl, 1518.44); eq('Si по операциям: комиссия', sl.commission, 370.56);
eq('Si по операциям: статус', sl.status, 'closed'); eq('Si по операциям: закрыта в', sl.closedAt, '2026-11-02T12:30:00Z');
// Акция с лотом 10: брокер отдаёт штуки (70 и 30), Журнал ведёт лоты → 7 и 3. Закрыто 3 лота по 297,10 при входе 301,45:
// ход −4,35 × 10 × 3 = −130,50; комиссия (9 043,50 + 8 913) × 0,05% = 8,97825 → −139,47825 → −139,48. Остаток 4 лота.
const ss = M.summarizeLegs({ ...SBER, direction: 'long' }, [
  { type: 'open', price: 301.45, quantity: 70, timestampUtc: '2026-11-02T07:10:00Z' },
  { type: 'close', price: 297.1, quantity: 30, timestampUtc: '2026-11-02T10:00:00Z' },
], RATE_S);
eq('SBER по операциям: объём в лотах', ss.volume, 7); eq('SBER по операциям: остаток', ss.remainingVolume, 4);
eq('SBER по операциям: результат части', ss.pnl, -139.48); eq('SBER по операциям: статус', ss.status, 'partial');
eq('только открытие — результата ещё нет', M.summarizeLegs({ ...SI, direction: 'long' }, [{ type: 'open', price: 92400, quantity: 1 }], RATE_F).pnl, null);

console.log('— план сделки (Калькулятор)');
// Si лонг: вход 92 450, стоп 92 150, цель 93 350, депозит 500 000, риск 1% = 5 000 ₽, ГО покупки 14 500, лимит ГО 30%.
// Убыток на контракт 300 ₽ + комиссия (92 450 + 92 150) × 0,04% = 73,84 → 373,84 → по риску 13 контрактов.
// По ГО: 150 000 / 14 500 = 10 контрактов → итог 10.
// Макс. убыток: 3 000 + (924 500 + 921 500) × 0,04% = 3 000 + 738,40 = 3 738,40.
// Прибыль: 9 000 − (924 500 + 933 500) × 0,04% = 9 000 − 743,20 = 8 256,80.
// Безубыток: 92 450 × 1,0004 / 0,9996 = 92 523,99 → на сетке шага 1 считаем с точностью 0,01 → 92 524,00 (с запасом вверх).
// Плечо: 92 450 / 14 500 = 6,3759.
const c = calcTrade({ entryPrice: 92450, stopLoss: 92150, takeProfit: 93350, depositSize: 500000, riskPercent: 1, ...SI, initialMarginBuy: 14500, initialMarginSell: 15200, commissionRate: RATE_F, maxMarginPercent: 30 });
eq('Si план: по риску', c.contractsByRisk, 13); eq('Si план: итог контрактов', c.contracts, 10);
eq('Si план: стоимость позиции', c.positionValue, 924500); eq('Si план: ГО всего', c.totalMargin, 145000);
eq('Si план: макс. убыток', c.totalLoss, 3738.4); eq('Si план: прибыль', c.totalProfit, 8256.8);
eq('Si план: безубыток', c.breakeven, 92524); eq('Si план: плечо', c.leverage, 6.3759);
eq('Si план: доля депозита под ГО, %', c.marginUsagePercent, 29);
// Тот же план, но объём руками — 4 контракта: убыток 1 200 + (369 800 + 368 600) × 0,04% = 1 200 + 295,36 = 1 495,36.
const c4 = scaleToContracts(c, 4, { entryPrice: 92450, commissionRate: RATE_F, depositSize: 500000, instrumentType: 'future' });
eq('Si план, 4 контракта руками: макс. убыток', c4.totalLoss, 1495.36); eq('Si план, 4 контракта: ГО', c4.totalMargin, 58000);
// План и фактическое закрытие по стопу обязаны совпасть: закрыли 10 контрактов по 92 150.
r = computeClosePnl({ trade: { ...SI, direction: 'long', entryPrice: 92450 }, exitPrice: 92150, qty: 10, commRate: RATE_F });
eq('Si: закрытие по стопу = «макс. убыток» плана', r.pnl, -c.totalLoss);
r = computeClosePnl({ trade: { ...SI, direction: 'long', entryPrice: 92450 }, exitPrice: 93350, qty: 10, commRate: RATE_F });
eq('Si: закрытие по цели = «прибыль» плана', r.pnl, c.totalProfit);
// Brent шорт: вход 80,12, стоп 80,92, цель 78,12, депозит 300 000, риск 1% = 3 000, ГО продажи 9 454,51.
// Убыток на контракт 0,80 × 750 = 600 + комиссия (80,12 + 80,92) × 750 × 0,04% = 48,312 → 648,312 → по риску 4.
// По ГО: 90 000 / 9 454,51 = 9 → итог 4. Макс. убыток 2 400 + 48,312 × 4 = 2 593,248 → 2 593,25.
// Прибыль 2,00 × 750 × 4 = 6 000 − (80,12 + 78,12) × 750 × 4 × 0,04% = 6 000 − 189,888 = 5 810,112 → 5 810,11.
// Безубыток шорта: 80,12 × 0,9996 / 1,0004 = 80,05593 → 80,05.
const b = calcTrade({ entryPrice: 80.12, stopLoss: 80.92, takeProfit: 78.12, depositSize: 300000, riskPercent: 1, ...BR, initialMarginBuy: 7438.81, initialMarginSell: 9454.51, commissionRate: RATE_F, maxMarginPercent: 30 });
eq('Brent план: контрактов', b.contracts, 4); eq('Brent план: макс. убыток', b.totalLoss, 2593.25);
eq('Brent план: прибыль', b.totalProfit, 5810.11); eq('Brent план: безубыток', b.breakeven, 80.05);
eq('Brent план: ГО (сторона продажи)', b.totalMargin, 37818.04);
r = computeClosePnl({ trade: { ...BR, direction: 'short', entryPrice: 80.12 }, exitPrice: 80.92, qty: 4, commRate: RATE_F });
eq('Brent: закрытие по стопу = «макс. убыток» плана', r.pnl, -b.totalLoss);
// SBER лонг: вход 301,45, стоп 297,10, цель 310,15, депозит 400 000, риск 1% = 4 000, лимит позиции 30% = 120 000.
// Убыток на лот 43,50 + комиссия (301,45 + 297,10) × 10 × 0,05% = 2,99275 → 46,49275 → по риску 86 лотов.
// По деньгам: 120 000 / 3 014,50 = 39 лотов → итог 39. Макс. убыток 39 × 46,49275 = 1 813,21725 → 1 813,22.
// Прибыль 8,70 × 10 × 39 = 3 393 − (301,45 + 310,15) × 390 × 0,05% = 3 393 − 119,262 = 3 273,738 → 3 273,74.
const s = calcTrade({ entryPrice: 301.45, stopLoss: 297.1, takeProfit: 310.15, depositSize: 400000, riskPercent: 1, lot: 10, minStep: 0.01, commissionRate: RATE_S, instrumentType: 'stock', maxMarginPercent: 30 });
eq('SBER план: по риску', s.contractsByRisk, 86); eq('SBER план: итог лотов', s.contracts, 39);
eq('SBER план: стоимость позиции', s.positionValue, 117565.5);
eq('SBER план: макс. убыток', s.totalLoss, 1813.22); eq('SBER план: прибыль', s.totalProfit, 3273.74);
r = computeClosePnl({ trade: { ...SBER, direction: 'long', entryPrice: 301.45 }, exitPrice: 297.1, qty: 39, commRate: RATE_S });
eq('SBER: закрытие по стопу = «макс. убыток» плана', r.pnl, -s.totalLoss);

console.log('— открытый риск');
// Si лонг, осталось 3 из 5, стоп 92 150: 300 × 1 × 3 = 900 ₽; стоимость 92 450 × 3 = 277 350.
let pr = positionRisk({ ...SI, ticker: 'SiZ6', direction: 'long', entryPrice: 92450, stopLoss: 92150, volume: 5, remainingVolume: 3 });
eq('Si: риск до стопа', pr.riskRub, 900); eq('Si: стоимость остатка', pr.notional, 277350);
// Brent шорт 3, стоп 80,92: 0,80 × 750 × 3 = 1 800 ₽.
pr = positionRisk({ ...BR, ticker: 'BRZ6', direction: 'short', entryPrice: 80.12, stopLoss: 80.92, volume: 3 });
eq('Brent: риск до стопа', pr.riskRub, 1800);
// SBER 7 лотов, стоп 297,10: 4,35 × 10 × 7 = 304,50 ₽.
pr = positionRisk({ ...SBER, ticker: 'SBER', direction: 'long', entryPrice: 301.45, stopLoss: 297.1, volume: 7 });
eq('SBER: риск до стопа', pr.riskRub, 304.5);

console.log('— плечо и ГО');
// MM: стоимость контракта 2 469,15 / 0,05 × 0,5 = 24 691,50; ГО 2 750,40 → плечо 8,9774; на 3 контракта ГО 8 251,20.
const lv = L.tradeLeverage({ ...MM, isFuture: true, entryPrice: 2469.15, volume: 3, marginPerContract: 2750.4 });
eq('MM: плечо', Math.round(lv.leverage * 10000) / 10000, 8.9774); eq('MM: ГО на позицию', lv.marginTotal, 8251.2);
// Результат 1 268,36 ₽ на ГО 33 004,80 (12 контрактов) = 3,8430%.
eq('MM: результат в % от ГО', Math.round(L.returnOnMarginPct(1268.36, 2750.4 * 12) * 10000) / 10000, 3.843);
// Сколько контрактов на 300 000 при лимите 30%: лонг 90 000 / 7 438,81 = 12; шорт 90 000 / 9 454,51 = 9.
const cap = L.capacityByDirection({ deposit: 300000, maxMarginPercent: 30, marginBuy: 7438.81, marginSell: 9454.51, valueRub: 60090 });
eq('Brent: лонг до', cap.long.maxByLimit, 12); eq('Brent: шорт до', cap.short.maxByLimit, 9);

console.log('— импорт фьючерсов из отчёта брокера');
// Brent шорт 3 контракта, закрыто 2 по 78,47 (осталось 1). Накоплено «пунктов × объём»: 1,65 × 2 = 3,30 → 3,30 × 750 = 2 475,00.
// Комиссии по отчёту: вход 72,11 за 3 контракта (24,0367 на контракт), закрытие 47,08. Всего в сделке 119,19.
// К закрытой части относится: 47,08 + 24,0367 × 2 = 95,1533; чистыми 2 475 − 95,1533 = 2 379,8467 → 2 379,85.
// (Раньше вычиталась вся комиссия входа: 2 475 − 119,19 = 2 355,81 — занижение на 24,04 ₽.)
const imp = { pnlPoints: 3.3, commission: 119.19, openCommissionPerUnit: 72.11 / 3, volume: 3, remainingVolume: 1 };
eq('Brent импорт, закрыта часть: результат', pnlFromSpec(imp, 0.01, 7.5).pnl, 2379.85);
eq('та же формула в общем модуле (Журнал, ручной ввод рублей за пункт)', M.pointsPnlRub(imp, 750), 2379.85);
// Закрыта целиком (3 контракта, закрытия 47,08 + 23,60): 1,65×2 + 1,62×1 = 4,92 → 3 690,00 − (72,11 + 70,68) = 3 547,21.
const impFull = { pnlPoints: 4.92, commission: 142.79, openCommissionPerUnit: 72.11 / 3, volume: 3, remainingVolume: 0 };
eq('Brent импорт, закрыта целиком: результат', pnlFromSpec(impFull, 0.01, 7.5).pnl, 3547.21);

console.log(fails ? `\nПровалено: ${fails}` : '\nВсе денежные расчёты сошлись с ручным расчётом до копейки ✓');
process.exit(fails ? 1 : 0);
