// scripts/paper/paperManageTests.mjs
//
// Проверка бухгалтерии бумажных сделок: npm run test:paper
//
// Проверяется planPaperUpdate из managePaperTrades.mjs — чистое решение «что произошло со
// сделкой к текущему бару». Свечи здесь выдуманные и подобраны так, чтобы срабатывание
// было однозначным: правила выхода пустые (никакого трейлинга), поэтому закрыть позицию
// может только пересечение стопа или цели — то есть результат не зависит от калибровок,
// которые могут меняться.
//
// Самая важная проверка здесь — ПОВТОРНЫЙ проход по уже закрытой сделке. Робот ходит раз
// в 15 минут и каждый раз переигрывает историю сделки с самого входа; если бухгалтерия
// не защищена, он припишет второе закрытие и задвоит P&L. Это худший из возможных отказов:
// цифры выглядят правдоподобно, а сделка «заработала» вдвое больше, чем было на самом деле.
import { pathToFileURL } from 'url';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { planPaperUpdate } = await import(pathToFileURL(path.join(__dirname, 'managePaperTrades.mjs')).href);

let failed = 0;
function check(name, actual, expect) {
  const ok = expect(actual);
  const shown = typeof actual === 'object' ? JSON.stringify(actual) : String(actual);
  console.log(`${ok ? '✓' : '✗'} ${name}: ${shown.length > 90 ? shown.slice(0, 90) + '…' : shown}`);
  if (!ok) failed += 1;
}

// В поле `date` у свечи лежит НАСТОЯЩИЙ объект даты, а не строка: indicators.js зовёт у
// него .getTime() напрямую, без обёртки. Со строкой расчёт индикаторов падает — на этом
// первая версия теста и споткнулась.
const day = (n) => new Date(Date.UTC(2026, 8, 1 + n));
const bar = (n, o, h, l, c) => ({ date: day(n), open: o, high: h, low: l, close: c, volume: 1000 });

// Индикаторы считаются на КАЖДОМ баре, даже когда правила выхода пустые, — значит серии
// нужен разгон, иначе считать просто не на чем. Ровная полка на 100: ни стоп, ни цель не
// задеты, сработает только специально добавленный последний бар.
const warmup = (count = 40) => Array.from({ length: count }, (_, i) => bar(i, 100, 101, 99, 100));
const LAST = 40;

// Сделка: лонг 10 контрактов от 100, цель 110, стопа нет. Лот 1 и нулевая стоимость шага —
// чтобы P&L считался простой формулой (цена × объём) и его можно было проверить в уме.
const baseTrade = {
  id: 'p1', ticker: 'TEST', direction: 'long', instrumentType: 'stock',
  entryPrice: 100, volume: 10, remainingVolume: 10,
  lot: 1, minStep: 1, minStepAmount: 0,
  status: 'open', openedAt: day(0), commissionRate: 0.0005,
};
const COMM = 0.0005;
const RULES = {}; // ни трейлинга, ни профит-системы — закрыть может только стоп/цель

// --- цель достигнута: сделка закрывается целиком ---
const takeTrade = { ...baseTrade, takeProfit: 110 };
const takeCandles = [...warmup(), bar(LAST, 101, 112, 100, 111)];
const takePlan = planPaperUpdate({ trade: takeTrade, rules: RULES, candles: takeCandles, entryIndex: 0, commRate: COMM });

check('Цель достигнута — сделка закрыта', takePlan.patch?.status, (v) => v === 'closed');
check('Остатка в рынке не осталось', takePlan.patch?.remainingVolume, (v) => v === 0);
check('Закрыто по цене цели, а не по цене бара', takePlan.patch?.exitPrice, (v) => v === 110);
// (110 − 100) × 10 = 100 грязными, комиссия 100 × 10 × 0.0005 × 2 = 1 → 99 чистыми.
check('P&L посчитан той же формулой, что и в Журнале', takePlan.patch?.pnl, (v) => Math.abs(v - 99) < 1e-6);
check('Записана одна закрывающая ступень', (takePlan.patch?.legs || []).filter((l) => l.type === 'close').length, (v) => v === 1);

// --- ГЛАВНОЕ: повторный проход по уже закрытой сделке ничего не добавляет ---
const afterClose = { ...takeTrade, ...takePlan.patch };
const secondPass = planPaperUpdate({ trade: afterClose, rules: RULES, candles: takeCandles, entryIndex: 0, commRate: COMM });
check('Повторный проход по закрытой сделке пропускается', secondPass.skipped, (v) => typeof v === 'string');
check('P&L не задвоился', secondPass.patch, (v) => v === undefined);

// --- стоп: та же механика в убыточную сторону ---
const stopTrade = { ...baseTrade, stopLoss: 95 };
const stopCandles = [...warmup(), bar(LAST, 100, 101, 94, 96)];
const stopPlan = planPaperUpdate({ trade: stopTrade, rules: RULES, candles: stopCandles, entryIndex: 0, commRate: COMM });
check('Стоп задет — сделка закрыта', stopPlan.patch?.status, (v) => v === 'closed');
// (95 − 100) × 10 = −50, минус комиссия 1 → −51.
check('Убыток посчитан с комиссией', stopPlan.patch?.pnl, (v) => Math.abs(v - (-51)) < 1e-6);

// --- ничего не произошло: робот не должен трогать базу ---
const quietCandles = warmup(42);
const quietPlan = planPaperUpdate({ trade: { ...baseTrade, takeProfit: 200 }, rules: RULES, candles: quietCandles, entryIndex: 0, commRate: COMM });
check('Без событий — пропуск, а не пустая запись', quietPlan.skipped, (v) => typeof v === 'string');

// --- шорт закрывается зеркально ---
const shortTrade = { ...baseTrade, direction: 'short', takeProfit: 90 };
const shortCandles = [...warmup(), bar(LAST, 100, 101, 88, 89)];
const shortPlan = planPaperUpdate({ trade: shortTrade, rules: RULES, candles: shortCandles, entryIndex: 0, commRate: COMM });
check('Шорт: цель ниже входа — сделка закрыта', shortPlan.patch?.status, (v) => v === 'closed');
// Шорт: (100 − 90) × 10 = 100 грязными, минус та же комиссия 1 → 99.
check('Шорт: прибыль считается в обратную сторону', shortPlan.patch?.pnl, (v) => Math.abs(v - 99) < 1e-6);

if (failed) {
  console.error(`\nПровалено проверок: ${failed}`);
  process.exit(1);
}
console.log('\nВсе проверки бумажных сделок прошли ✓');
