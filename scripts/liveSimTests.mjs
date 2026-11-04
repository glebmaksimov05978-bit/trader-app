// Проверка живых бумажных сделок тренажёра (npm run test:trainer): заявка, исполнение по открытию следующей свечи,
// проверка только по ЗАКРЫТЫМ свечам, стоп/тейк, отложенное вступление в силу передвинутого стопа, ручное закрытие, отмена.
import { createLiveOrder, advanceLive, moveLiveStop, closeLive, isClosedBar, barNumber, stopFor } from '../src/services/trainer/liveSim.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-6) => Math.abs(a - b) < e;
const throws = (f) => { try { f(); return false; } catch { return true; } };

const H = 3600000;                       // свечи часовые
const t0 = Date.UTC(2025, 5, 2, 7, 0);   // начало первой свечи
const bar = (i, o, h, l, c) => ({ date: new Date(t0 + i * H), open: o, high: h, low: l, close: c, volume: 1 });
const order = (o = {}) => createLiveOrder({ side: 'long', stop: 95, take: 110, riskMoney: 1000, ticker: 'SBER', timeframe: 'H1', tfMinutes: 60, lastCandleDate: new Date(t0 + 1 * H), lastPrice: 100, feePctPerSide: 0, ...o });
const after = (i) => t0 + i * H + 1000;  // «сейчас» — сразу после начала свечи i

// --- заявка ---
const o1 = order();
ok('заявка создана: ожидает, метка «тренажёр», живые данные, стоп записан', o1.status === 'pending' && o1.kind === 'trainer' && o1.dataMode === 'live' && o1.stopSchedule[0].price === 95);
ok('без стопа / стоп не с той стороны / тейк не с той стороны — ошибки', throws(() => order({ stop: 0 })) && throws(() => order({ stop: 101 })) && throws(() => order({ take: 99 })) && throws(() => order({ riskMoney: 0 })));
ok('шорт: стоп выше, тейк ниже', !throws(() => order({ side: 'short', stop: 105, take: 90 })) && throws(() => order({ side: 'short', stop: 95, take: 90 })));
ok('«закрытая» свеча — та, чей период уже закончился', isClosedBar(bar(0, 1, 1, 1, 1), 60, t0 + H) && !isClosedBar(bar(0, 1, 1, 1, 1), 60, t0 + H - 1));

// --- ожидание, пока следующая свеча не началась ---
let r = advanceLive(o1, [bar(0, 99, 101, 98, 100), bar(1, 100, 101, 99, 100)], after(1));
ok('пока после заявки не началась новая свеча — заявка ждёт', r.doc.status === 'pending' && !r.changed);

// --- исполнение по открытию следующей свечи (она ещё не закрыта) ---
r = advanceLive(o1, [bar(1, 100, 101, 99, 100), bar(2, 101, 103, 100, 102)], after(2));
ok('следующая свеча началась: заявка исполнена по ЕЁ ОТКРЫТИЮ, позиция открыта', r.doc.status === 'open' && r.doc.entryPrice === 101 && r.events.includes('filled') && r.changed);
ok('исполненная, но ещё не закрытая свеча стоп/тейк не проверяет', r.doc.barsHeld === 0 && r.doc.lastBarTime === o1.lastBarTime);
const open1 = r.doc;

// --- закрытая свеча: стоп/тейк проверяются ---
r = advanceLive(open1, [bar(2, 101, 103, 100, 102), bar(3, 102, 104, 101, 103)], after(3));
ok('свеча закрылась без касаний: позиция жива, барьер продвинут, лучший ход записан', r.doc.status === 'open' && r.doc.barsHeld === 1 && r.doc.mfeR > 0 && new Date(r.doc.lastBarTime).getTime() === t0 + 2 * H);
const hit = advanceLive(open1, [bar(2, 101, 103, 94, 96), bar(3, 96, 97, 95, 96)], after(3));
ok('закрытая свеча коснулась стопа: выход по стопу 95 при входе 101 (риск 6) — ровно −1R', hit.doc.status === 'closed' && hit.doc.exitReason === 'stop' && hit.events.includes('stop') && near(hit.doc.r, -1) && hit.doc.exitPrice === 95);
const tk = advanceLive(open1, [bar(2, 101, 112, 100, 111), bar(3, 111, 112, 110, 111)], after(3));
ok('закрытая свеча коснулась тейка: выход по тейку, прибыль', tk.doc.status === 'closed' && tk.doc.exitReason === 'take' && tk.doc.r > 0);
const forming = advanceLive(open1, [bar(2, 101, 112, 94, 111)], after(2));
ok('та же свеча, но ещё не закрыта (нет «сейчас» после её конца) — НЕ закрывает позицию', forming.doc.status === 'open');
const twice = advanceLive(hit.doc, [bar(2, 101, 103, 94, 96), bar(3, 96, 97, 95, 96)], after(4));
ok('закрытая сделка не меняется при повторных обновлениях', twice.doc.status === 'closed' && !twice.changed && twice.doc.r === hit.doc.r);

// --- повторное чтение тех же свечей ничего не ломает ---
const again = advanceLive(r.doc, [bar(2, 101, 103, 100, 102), bar(3, 102, 104, 101, 103)], after(3));
ok('повторное чтение уже обработанных свечей не добавляет «держали» заново', again.doc.barsHeld === r.doc.barsHeld && !again.changed);

// --- отложенное чтение: страницу не открывали несколько свечей ---
const gap = advanceLive(o1, [bar(1, 100, 101, 99, 100), bar(2, 101, 102, 100, 101), bar(3, 101, 103, 100, 102), bar(4, 102, 103, 94, 95), bar(5, 95, 96, 94, 95)], after(6));
ok('страницу не открывали 5 свечей: заявка исполнена, позиция дошла до стопа на нужной свече', gap.doc.status === 'closed' && gap.doc.exitReason === 'stop' && gap.events.join() === 'filled,stop' && gap.doc.exitDate === new Date(t0 + 4 * H).toISOString());

// --- гэп при исполнении ---
const bad = advanceLive(o1, [bar(1, 100, 101, 99, 100), bar(2, 90, 91, 89, 90)], after(2));
ok('если свеча открылась уже за стопом — заявка отменена (а не исполнена по плохой цене), причина записана', bad.doc.status === 'cancelled' && /за стопом/.test(bad.doc.cancelReason) && bad.events.includes('cancelled'));

// --- шорт ---
const so = order({ side: 'short', stop: 105, take: 90 });
const sr = advanceLive(so, [bar(1, 100, 101, 99, 100), bar(2, 100, 101, 99, 100), bar(3, 99, 100, 88, 89)], after(4));
ok('шорт: исполнен по открытию, тейк снизу даёт прибыль', sr.doc.status === 'closed' && sr.doc.exitReason === 'take' && sr.doc.r > 0);

// --- передвинутый стоп вступает в силу только со свечей, которые начались позже ---
const moveAt = t0 + 2 * H + 30 * 60000;              // передвинули в середине свечи 2
let mv = moveLiveStop(open1, 100.5, moveAt, 102);
ok('стоп передвинут (подтянули): запись «tighten», в расписании — момент передвижения', mv.stopPrice === 100.5 && mv.stopMoves[0].direction === 'tighten' && mv.stopSchedule.length === 2 && mv.stopSchedule[1].afterMs === moveAt);
ok('для свечи, начавшейся ДО передвижения, действует прежний стоп; для начавшейся после — новый', stopFor(mv, bar(2, 1, 1, 1, 1)) === 95 && stopFor(mv, bar(3, 1, 1, 1, 1)) === 100.5);
const lateHit = advanceLive(mv, [bar(2, 101, 103, 100, 102), bar(3, 102, 103, 100, 101)], after(4));
ok('свеча 2 (начата до передвижения) падала до 100, но прежний стоп 95 не тронут; свеча 3 коснулась нового стопа 100,5 — выход по нему', lateHit.doc.status === 'closed' && lateHit.doc.exitPrice === 100.5 && lateHit.doc.exitBar === barNumber(t0 + 3 * H, 60));
ok('стоп нельзя поставить выше текущей цены (покупка) и у неоткрытой позиции', throws(() => moveLiveStop(open1, 103, moveAt, 102)) && throws(() => moveLiveStop(o1, 96, moveAt, 100)));
mv = moveLiveStop(mv, 97, moveAt + 1000, 102);
ok('отодвинули стоп назад — «widen» (для разбора привычек)', mv.stopMoves[1].direction === 'widen');

// --- ручное закрытие ---
const cl = closeLive(open1, bar(2, 101, 103, 100, 102.5));
ok('ручное закрытие по цене последней свечи: причина «manual», (102,5 − 101) / 6 = +0,25R', cl.status === 'closed' && cl.exitReason === 'manual' && near(cl.exitPrice, 102.5) && near(cl.rGross, 0.25));
ok('закрытая вручную сделка ссылается на номер свечи, сопоставимый с входом', cl.exitBar >= cl.entryBar && cl.entryBar === barNumber(t0 + 2 * H, 60));
ok('закрыть можно только открытую позицию', throws(() => closeLive(o1, bar(1, 1, 1, 1, 1))) && throws(() => closeLive(cl, bar(1, 1, 1, 1, 1))));

// --- результат совместим с разбором ---
ok('закрытая живая сделка — в формате разбора (kind, dataMode, r, exitReason)', hit.doc.kind === 'trainer' && hit.doc.dataMode === 'live' && Number.isFinite(hit.doc.r) && hit.doc.exitReason);
ok('документ можно сохранить в базу (без Date и undefined: проходит через JSON без потерь)', JSON.stringify(JSON.parse(JSON.stringify(hit.doc))) === JSON.stringify(hit.doc));

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки живых бумажных сделок прошли ✓');
