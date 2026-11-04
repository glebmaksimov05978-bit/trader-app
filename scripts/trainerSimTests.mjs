// Проверка бумажной позиции и разбора сделок тренажёра (npm run test:trainer):
// исполнение стопа/тейка, гэпы, неоднозначная свеча, R и комиссия, движение стопа, разбор привычек, разделение с реальными сделками.
import {
  openPosition, onBar, closePosition, moveStop, moveTake, unrealized, runToEnd, positionSize,
} from '../src/services/trainer/trainerSim.js';
import { summarize, strategyVerdict, byStrategy, findings, analyze, onlyTrainer, isTrainerTrade, MIN_N } from '../src/services/trainer/trainerStats.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const bar = (o, h, l, c, i = 0) => ({ date: new Date(Date.UTC(2024, 0, 2 + i)), open: o, high: h, low: l, close: c, volume: 1 });
const open = (o = {}) => openPosition({ side: 'long', price: 100, stop: 95, take: 110, date: new Date(Date.UTC(2024, 0, 1)), bar: 0, riskMoney: 1000, feePctPerSide: 0, ...o });

// --- открытие ---
const p = open();
ok('размер позиции под риск: 1000 ₽ при стопе в 5 пунктах = 200 штук', near(p.qty, 200) && near(positionSize({ riskMoney: 1000, entry: 100, stop: 95 }), 200));
ok('планируемая прибыль к риску: 10 / 5 = 2', near(p.plannedRR, 2));
const throws = (f) => { try { f(); return false; } catch { return true; } };
ok('стоп не с той стороны — ошибка (покупка: стоп выше цены)', throws(() => open({ stop: 101 })));
ok('без стопа сделка не открывается', throws(() => open({ stop: 0 })));
ok('тейк не с той стороны — ошибка', throws(() => open({ take: 99 })));
ok('для продажи стоп должен быть выше, тейк ниже', !throws(() => open({ side: 'short', stop: 105, take: 90 })) && throws(() => open({ side: 'short', stop: 95, take: 90 })));

// --- исполнение ---
let r = onBar(p, bar(100, 104, 98, 103), 1);
ok('свеча внутри диапазона: позиция жива, ход фиксируется (лучший +0,8R, худший 0,4R)', !r.closed && near(r.position.mfeR, 0.8) && near(r.position.maeR, 0.4) && r.position.barsHeld === 1);
r = onBar(p, bar(100, 103, 94, 96), 1);
ok('касание стопа: выход по стопу, −1R', r.closed && r.position.exitReason === 'stop' && near(r.position.exitPrice, 95) && near(r.position.r, -1) && near(r.position.pnlVirtual, -1000));
r = onBar(p, bar(100, 111, 99, 108), 1);
ok('касание тейка: выход по тейку, +2R', r.closed && r.position.exitReason === 'take' && near(r.position.r, 2) && near(r.position.pnlVirtual, 2000));
r = onBar(p, bar(100, 111, 94, 100), 1);
ok('в одной свече достижимы и стоп, и тейк — считается стоп (консервативно), с пометкой', r.closed && r.position.exitReason === 'stop' && r.position.ambiguous === true);
r = onBar(p, bar(92, 93, 90, 91), 1);
ok('гэп за стопом: выход по цене открытия, убыток больше 1R', r.closed && r.position.gap === true && near(r.position.exitPrice, 92) && near(r.position.r, -1.6));
r = onBar(p, bar(113, 115, 112, 114), 1);
ok('гэп за тейком: выход по цене открытия, прибыль больше планируемой', r.closed && r.position.gap === true && near(r.position.exitPrice, 113) && near(r.position.r, 2.6));

// --- шорт ---
const sp = open({ side: 'short', stop: 105, take: 90 });
r = onBar(sp, bar(100, 106, 99, 104), 1);
ok('шорт: стоп сверху, −1R', r.closed && r.position.exitReason === 'stop' && near(r.position.r, -1));
r = onBar(sp, bar(100, 101, 89, 91), 1);
ok('шорт: тейк снизу, +2R', r.closed && r.position.exitReason === 'take' && near(r.position.r, 2));

// --- комиссия ---
const fp = open({ feePctPerSide: 0.05 });
const fc = closePosition(fp, 105, new Date(), 3);
ok('комиссия 0,05 % с каждой стороны вычитается из R: +1R − 0,02R = +0,98R', near(fc.rGross, 1) && near(fc.costR, 0.02) && near(fc.r, 0.98));

// --- ручное закрытие, нереализованное ---
ok('нереализованный результат по текущей цене', near(unrealized(p, 102.5).r, 0.5));
const mc = closePosition(p, 97.5, new Date(), 2);
ok('ручное закрытие: причина «manual», −0,5R, повторное закрытие ничего не меняет', mc.exitReason === 'manual' && near(mc.r, -0.5) && closePosition(mc, 50, new Date(), 9).exitPrice === 97.5);

// --- движение стопа/тейка ---
let m = moveStop(p, 98, 1, 103);
ok('подтянули стоп ближе к цене — «tighten»', m.stopPrice === 98 && m.stopMoves[0].direction === 'tighten' && p.stopPrice === 95);
m = moveStop(m, 93, 2, 103);
ok('отодвинули стоп от цены — «widen»; R считается от ПЕРВОНАЧАЛЬНОГО риска', m.stopMoves[1].direction === 'widen' && near(m.riskPerUnit, 5));
ok('стоп не может оказаться выше текущей цены (покупка)', throws(() => moveStop(p, 104, 1, 103)));
ok('тейк можно убрать и поставить заново', moveTake(p, null).takePrice === null && near(moveTake(p, 120, 100).plannedRR, 4) && throws(() => moveTake(p, 99, 100)));

// --- прогон по списку свечей ---
const done = runToEnd(p, [bar(100, 102, 99, 101, 1), bar(101, 104, 100, 103, 2), bar(103, 111, 102, 110, 3)], 1);
ok('прогон по свечам: закрылась на третьей по тейку', done.status === 'closed' && done.exitReason === 'take' && done.exitBar === 3 && done.barsHeld === 3);

// ======= разбор =======
const mk = (i, o = {}) => ({ kind: 'trainer', status: 'closed', dataMode: 'history', ticker: 'SBER', strategyId: 's1', strategyName: 'Пробой', entryDate: new Date(Date.UTC(2024, 0, 1 + i * 5)).toISOString(), exitDate: new Date(Date.UTC(2024, 0, 3 + i * 5)).toISOString(), entryBar: i * 10, exitBar: i * 10 + 2, barsHeld: 2, r: 1, mfeR: 1.2, exitReason: 'take', stopMoves: [], plannedRR: 2, ...o });

ok('реальные сделки и сделки робота в разбор не попадают', onlyTrainer([{ r: 1, status: 'closed' }, { kind: 'paper', r: 1 }, mk(0)]).length === 1 && isTrainerTrade(mk(0)) && !isTrainerTrade({ paper: true }));
let few = []; for (let i = 0; i < 10; i++) few.push(mk(i));
const f0 = findings(few);
ok('меньше 25 сделок — только строка «пока мало», без выводов', f0.length === 1 && f0[0].id === 'sample' && f0[0].n === 10);
ok('стратегия при малом числе сделок: «мало данных», а не «работает»', strategyVerdict(few).code === 'few');

let many = []; for (let i = 0; i < 30; i++) many.push(mk(i, { r: i % 2 ? 1.5 : -1, mfeR: 1.6, barsHeld: 2, exitReason: i % 2 ? 'take' : 'stop' }));
const s = summarize(many);
ok('сводка: 30 сделок, доля прибыльных 50 %, средний R +0,25, профит-фактор 1,5', s.n === 30 && near(s.winRate, 0.5) && near(s.avgR, 0.25) && near(s.profitFactor, 1.5) && s.maxLossStreak === 1);
ok('стратегия с 30 сделками и +0,25R: «пока по бумаге в плюсе» (не «работает»)', strategyVerdict(many).code === 'positive' && /по бумаге/.test(strategyVerdict(many).label));
const neg = many.map((t) => ({ ...t, r: t.r > 0 ? 0.5 : -1 }));
ok('отрицательное ожидание — «по бумаге не подтвердилась»', strategyVerdict(neg).code === 'negative');

// привычка: отодвигание стопа
const widen = []; for (let i = 0; i < 30; i++) widen.push(mk(i, i < 8 ? { r: -1.6, stopMoves: [{ bar: 1, from: 95, to: 92, direction: 'widen' }], exitReason: 'stop' } : { r: 0.4 }));
let fd = findings(widen);
ok('находит привычку отодвигать стоп (8 сделок, хуже остальных)', fd.some((x) => x.id === 'stop_widened' && x.n === 8));
ok('находит убытки больше плана', fd.some((x) => x.id === 'loss_beyond_plan'));

// привычка: ранняя фиксация
const early = []; for (let i = 0; i < 30; i++) early.push(mk(i, { r: 0.4, mfeR: 2, exitReason: 'manual' }));
ok('находит раннюю фиксацию прибыли (взято 20 % хода)', findings(early).some((x) => x.id === 'early_exit' && /20 %/.test(x.text)));

// привычка: убыточные держим дольше
const held = []; for (let i = 0; i < 30; i++) held.push(mk(i, i % 2 ? { r: 1, barsHeld: 2 } : { r: -1, barsHeld: 6, exitReason: 'stop' }));
ok('находит «убыточные держу дольше прибыльных»', findings(held).some((x) => x.id === 'losers_held_longer'));

// привычка: быстрый вход после убытка (каждая 3-я сделка — убыток; следом сразу вход, который тоже убыточен; третья — спокойный вход, прибыльный)
const dayMs = 86400000, t0 = Date.UTC(2024, 0, 1);
const rev = [];
let prevExitBar = 0;
for (let i = 0; i < 30; i++) {
  const phase = i % 3;                           // 0 — убыток; 1 — вход сразу после убытка; 2 — вход спустя время
  const entryBar = prevExitBar + (phase === 1 ? 1 : 20), exitBar = entryBar + 2;
  rev.push(mk(i, { entryBar, exitBar, entryDate: new Date(t0 + entryBar * dayMs).toISOString(), exitDate: new Date(t0 + exitBar * dayMs).toISOString(), r: phase === 0 ? -1 : phase === 1 ? -0.9 : 0.8, exitReason: 'stop' }));
  prevExitBar = exitBar;
}
const qr = findings(rev).find((x) => x.id === 'quick_reentry');
ok('находит поспешные входы после убытка (10 сделок, хуже остальных)', !!qr && qr.n === 10);

// нет данных — нет выводов; хорошая дисциплина — нет предупреждений
const clean = []; for (let i = 0; i < 30; i++) clean.push(mk(i, { r: i % 2 ? 1.8 : -1, barsHeld: 3, mfeR: 1.9, exitReason: i % 2 ? 'take' : 'stop' }));
ok('чистая выборка не получает ложных предупреждений', findings(clean).filter((x) => x.level === 'warn').length === 0);

// по стратегиям и по режимам
const mixed = [...many.map((t) => ({ ...t, strategyId: 'a', strategyName: 'А' })), ...few.map((t) => ({ ...t, strategyId: 'b', strategyName: 'Б', dataMode: 'live' })), ...[mk(99, { strategyId: null, strategyName: undefined })]];
const bs = byStrategy(mixed);
ok('разбор по стратегиям: А — 30 сделок, Б — «мало данных», без стратегии — отдельной строкой', bs.find((x) => x.id === 'a').n === 30 && bs.find((x) => x.id === 'b').code === 'few' && bs.some((x) => x.id === null && x.name === 'Без стратегии'));
const an = analyze(mixed);
ok('в разборе есть метка области «trainer» и деление на историю/живое', an.scope === 'trainer' && an.modes.history.n === 31 && an.modes.live.n === 10);
ok(`порог выводов — ${MIN_N} сделок`, MIN_N === 25);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки бумажной позиции и разбора прошли ✓');
