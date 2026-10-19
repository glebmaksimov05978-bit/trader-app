// Проверка модели и математики рисунков на графике (npm run test:drawings).
import {
  chartKey, normalizeDrawings, newDrawing, addDrawing, removeDrawing, drawingsFor, withDrawings,
  fibLevels, rulerStats, rulerText, snapPrice, lineValueAt, userLevelsFrom, nearestLevel, distToSegment, atrOf, moveDrawing, movePoint, patternToDrawings,
  MAX_PER_CHART, MAX_CHARTS, PALETTE,
} from '../src/services/chartDrawings.js';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

// strategy.js в браузере подключает соседей без расширений — для Node копируем во временную папку
// и дописываем «.js» (тот же приём, что у роботов).
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-drawings-'));
for (const f of ['strategy', 'exitRules', 'patterns', 'indicators', 'candlestickPatterns']) {
  let t = fs.readFileSync(path.join(__dirname, `../src/services/analytics/${f}.js`), 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  fs.writeFileSync(path.join(tmp, `${f}.js`), t, 'utf8');
}
const { CONDITION_CATALOG, evaluateStrategy } = await import(pathToFileURL(path.join(tmp, 'strategy.js')).href);

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };
const near = (a, b, e = 1e-9) => Math.abs(a - b) <= e;

// ---- ключ ----
ok('ключ: тикер и таймфрейм', chartKey('sber', 'H1') === 'SBER_H1');
ok('ключ: небезопасные символы заменяются', chartKey('BR-X6.', 'D1') === 'BR_X6__D1' || chartKey('BR-X6.', 'D1') === 'BR_X6_D1');
ok('ключ: пустой таймфрейм — D1', chartKey('SBER', '') === 'SBER_D1');

// ---- нормализация ----
const good = { id: 'a', type: 'hline', p1: { time: 1000, price: 300 }, color: '#e0584f', width: 2 };
ok('нормальный рисунок сохраняется', normalizeDrawings([good]).length === 1 && normalizeDrawings([good])[0].color === '#e0584f');
ok('неизвестный тип отброшен', normalizeDrawings([{ ...good, type: 'zigzag' }]).length === 0);
ok('нет цены — отброшен', normalizeDrawings([{ ...good, p1: { time: 1, price: NaN } }]).length === 0);
ok('для трендовой нужна вторая точка', normalizeDrawings([{ ...good, type: 'trend' }]).length === 0);
ok('чужой цвет заменяется', normalizeDrawings([{ ...good, color: 'javascript:alert(1)' }])[0].color === PALETTE[0]);
ok('толщина ограничена 1..4', normalizeDrawings([{ ...good, width: 99 }])[0].width === 4 && normalizeDrawings([{ ...good, width: -3 }])[0].width === 1);
ok('метка обрезается до 40 символов', normalizeDrawings([{ id: 't', type: 'text', p1: { time: 1, price: 1 }, label: 'x'.repeat(100) }])[0].label.length === 40);
ok('не массив → пусто', normalizeDrawings(null).length === 0 && normalizeDrawings({}).length === 0);
ok('лимит на график', normalizeDrawings(Array.from({ length: 200 }, (_, i) => ({ ...good, id: `i${i}` }))).length === MAX_PER_CHART);

// ---- создание, добавление, удаление ----
const d1 = newDrawing({ type: 'trend', p1: { time: 100, price: 10 }, p2: { time: 200, price: 20 }, idSeed: 'x1' });
ok('newDrawing: id и цвет по умолчанию', d1.id === 'x1' && d1.color === PALETTE[0] && d1.type === 'trend');
ok('newDrawing: без второй точки — ошибка', (() => { try { newDrawing({ type: 'ray', p1: { time: 1, price: 1 } }); return false; } catch { return true; } })());
ok('newDrawing: неизвестный инструмент — ошибка', (() => { try { newDrawing({ type: 'abc', p1: { time: 1, price: 1 } }); return false; } catch { return true; } })());
let list = addDrawing([], d1);
ok('addDrawing не меняет исходный список', list.length === 1);
for (let i = 0; i < MAX_PER_CHART + 5; i++) list = addDrawing(list, newDrawing({ type: 'hline', p1: { time: 1 + i, price: 1 + i }, idSeed: `h${i}` }));
ok('при переполнении вытесняются старые', list.length === MAX_PER_CHART && !list.some((d) => d.id === 'x1') && list[list.length - 1].id === `h${MAX_PER_CHART + 4}`);
ok('removeDrawing', removeDrawing([d1], 'x1').length === 0 && removeDrawing([d1], 'zzz').length === 1);

// ---- профиль ----
const profile = { chartDrawings: { SBER_H1: [good] } };
ok('drawingsFor читает свой график', drawingsFor(profile, 'SBER', 'H1').length === 1);
ok('другой таймфрейм — пусто', drawingsFor(profile, 'SBER', 'D1').length === 0);
ok('withDrawings сохраняет остальные графики', (() => {
  const next = withDrawings({ chartDrawings: { SBER_H1: [good], GAZP_D1: [good] } }, 'SBER', 'H1', [d1]);
  return next.GAZP_D1.length === 1 && next.SBER_H1[0].id === 'x1';
})());
ok('пустой список сохраняется как [] — иначе при слиянии в базе линии вернутся', Array.isArray(withDrawings(profile, 'SBER', 'H1', []).SBER_H1) && withDrawings(profile, 'SBER', 'H1', []).SBER_H1.length === 0);
ok('слишком много графиков — не сохраняем новый', (() => {
  const big = Object.fromEntries(Array.from({ length: MAX_CHARTS }, (_, i) => [`T${i}_D1`, [good]]));
  return withDrawings({ chartDrawings: big }, 'NEW', 'D1', [good]) === null && withDrawings({ chartDrawings: big }, 'T1', 'D1', [good]) !== null;
})());

// ---- Фибоначчи ----
const fib = fibLevels({ time: 0, price: 100 }, { time: 1, price: 200 });
ok('Фибо: 0% = 100, 100% = 200', fib[0].price === 100 && fib[fib.length - 1].price === 200);
ok('Фибо: 61,8% = 161,8', near(fib.find((l) => l.ratio === 0.618).price, 161.8, 1e-9));
const fibDown = fibLevels({ time: 0, price: 200 }, { time: 1, price: 100 });
ok('Фибо вниз: 50% = 150', fibDown.find((l) => l.ratio === 0.5).price === 150);

// ---- линейка ----
const rs = rulerStats({ p1: { time: 0, price: 100 }, p2: { time: 3600 * 10, price: 104 }, atr: 2, barSeconds: 3600 });
ok('линейка: +4 пункта, +4%, 10 баров, 2 ATR', rs.delta === 4 && rs.pct === 4 && rs.bars === 10 && rs.atrMult === 2 && rs.direction === 'up');
const rdown = rulerStats({ p1: { time: 0, price: 100 }, p2: { time: 86400 * 3, price: 97 } });
ok('линейка вниз: −3%, 3 дня', rdown.pct === -3 && near(rdown.days, 3) && rdown.bars === null && rdown.atrMult === null);
ok('текст линейки', rulerText(rs) === '+4 · +4% · 10 бар. · 2 ATR');
ok('текст линейки вниз без баров — в днях', rulerText(rdown) === '−3 · −3% · 3 дн.');
ok('линейка от нуля не делит на ноль', rulerStats({ p1: { time: 0, price: 0 }, p2: { time: 1, price: 5 } }).pct === null);

// ---- магнит ----
const candle = { open: 100, high: 105, low: 98, close: 103 };
ok('магнит: 104,8 → high 105', snapPrice(104.8, candle, 0.5) === 105);
ok('магнит: далеко — без изменений', snapPrice(101.2, candle, 0.3) === 101.2);
ok('магнит: между close и high берёт ближайший', snapPrice(104.1, candle, 2) === 105 || snapPrice(104.1, candle, 2) === 103);
ok('магнит: нет свечи или порога — без изменений', snapPrice(10, null, 1) === 10 && snapPrice(10, candle, 0) === 10);

// ---- прямая через две точки ----
ok('цена прямой в середине', lineValueAt({ time: 0, price: 100 }, { time: 10, price: 110 }, 5) === 105);
ok('цена прямой за правым краем (экстраполяция)', lineValueAt({ time: 0, price: 100 }, { time: 10, price: 110 }, 20) === 120);
ok('вертикальная прямая — null', lineValueAt({ time: 5, price: 100 }, { time: 5, price: 110 }, 5) === null);

// ---- уровни для стратегии ----
const set = normalizeDrawings([
  { id: 'h', type: 'hline', p1: { time: 0, price: 300 } },
  { id: 'v', type: 'vline', p1: { time: 50, price: 0.0001 } },
  { id: 'r', type: 'ray', p1: { time: 0, price: 100 }, p2: { time: 100, price: 110 } },
  { id: 't', type: 'trend', p1: { time: 0, price: 100 }, p2: { time: 100, price: 110 } },
  { id: 'z', type: 'rect', p1: { time: 0, price: 280 }, p2: { time: 100, price: 290 } },
  { id: 'f', type: 'fib', p1: { time: 0, price: 100 }, p2: { time: 100, price: 200 } },
  { id: 'x', type: 'text', p1: { time: 0, price: 123 }, label: 'заметка' },
]);
const lv = userLevelsFrom(set, 150, { barSeconds: 10 });
const kinds = lv.map((l) => l.kind);
ok('горизонталь — уровень', lv.some((l) => l.kind === 'hline' && l.price === 300));
ok('луч на моменте 150 = 115', near(lv.find((l) => l.kind === 'ray').price, 115));
ok('трендовая линия ушла за правый край больше чем на 2 бара — не уровень', !kinds.includes('trend'));
ok('прямоугольник даёт две границы', lv.filter((l) => l.kind === 'rect').length === 2);
ok('Фибо даёт 7 уровней', lv.filter((l) => l.kind === 'fib').length === 7);
ok('метка и вертикаль уровнями не являются', !lv.some((l) => l.drawingId === 'x' || l.drawingId === 'v'));
ok('трендовая линия ещё действует в пределах 2 баров правее конца', userLevelsFrom(set, 115, { barSeconds: 10 }).some((l) => l.kind === 'trend'));
ok('внутри отрезка тренд — значение на прямой', near(userLevelsFrom(set, 50, { barSeconds: 10 }).find((l) => l.kind === 'trend').price, 105));
ok('луч слева от начала не действует', !userLevelsFrom(set, -10).some((l) => l.kind === 'ray'));

// ---- ближайший уровень ----
const nl = nearestLevel([{ price: 100 }, { price: 110 }], 108);
ok('ближайший уровень 110, 1,85%', nl.price === 110 && near(nl.distancePct, (2 / 108) * 100));
ok('нет уровней — null', nearestLevel([], 100) === null && nearestLevel([{ price: 1 }], 0) === null);

// ---- ATR ----
const flat = Array.from({ length: 30 }, () => ({ high: 102, low: 98, close: 100 }));
ok('ATR ровного ряда с размахом 4 = 4', near(atrOf(flat), 4));
ok('ATR: мало свечей → null', atrOf(flat.slice(0, 10)) === null && atrOf(null) === null);
ok('ATR учитывает гэпы', atrOf([...flat.slice(0, 15), { high: 112, low: 110, close: 111 }, ...flat.slice(0, 15).map(() => ({ high: 112, low: 108, close: 110 }))]) > 4);

// ---- перемещение ----
const tl = { id: 't', type: 'trend', p1: { time: 100, price: 10 }, p2: { time: 200, price: 20 }, color: '#6485d8', width: 1 };
const mv = moveDrawing(tl, 50, 5);
ok('линия целиком: обе точки сдвинуты', mv.p1.time === 150 && mv.p1.price === 15 && mv.p2.time === 250 && mv.p2.price === 25);
ok('исходный рисунок не изменён', tl.p1.time === 100);
const hl = { id: 'h', type: 'hline', p1: { time: 100, price: 10 }, color: '#6485d8', width: 1 };
ok('горизонталь двигается только по цене', moveDrawing(hl, 999, 3).p1.time === 100 && moveDrawing(hl, 999, 3).p1.price === 13);
const vl = { id: 'v', type: 'vline', p1: { time: 100, price: 10 }, color: '#6485d8', width: 1 };
ok('вертикаль — только по времени', moveDrawing(vl, 7, 999).p1.time === 107 && moveDrawing(vl, 7, 999).p1.price === 10);
ok('одна точка линии переставляется, другая остаётся', (() => { const r = movePoint(tl, 'p2', { time: 300, price: 40 }); return r.p2.time === 300 && r.p2.price === 40 && r.p1.time === 100; })());
ok('у горизонтали точка меняет только цену', movePoint(hl, 'p1', { time: 5, price: 50 }).p1.time === 100 && movePoint(hl, 'p1', { time: 5, price: 50 }).p1.price === 50);

// ---- фигура алгоритма → рисунки ----
const D0 = (i) => new Date(Date.UTC(2026, 0, 1 + i));
const dirs = { bullish: ['wedge_falling', 'double_bottom'], bearish: ['double_top', 'head_shoulders_top'] };
const wedge = { pattern: 'wedge_falling', points: [
  { index: 10, date: D0(10), price: 110, type: 'high' }, { index: 14, date: D0(14), price: 98, type: 'low' },
  { index: 18, date: D0(18), price: 106, type: 'high' }, { index: 22, date: D0(22), price: 97, type: 'low' }, { index: 26, date: D0(26), price: 102, type: 'high' }],
  boundaries: { upper: { slope: -0.5, intercept: 115 }, lower: { slope: -0.2, intercept: 100.8 } } };
const wd = patternToDrawings(wedge, dirs);
ok('клин: две трендовые линии', wd.length === 2 && wd.every((d) => d.type === 'trend'));
ok('клин бычий — зелёный', wd[0].color === '#3fb68b');
ok('верхняя граница идёт по подогнанной линии: 115 − 0,5×10 = 110 в первой точке', near(wd[0].p1.price, 110) && near(wd[0].p2.price, 115 - 0.5 * 26));
ok('нижняя граница — от первого до последнего минимума', wd[1].p1.time === Math.floor(D0(14).getTime() / 1000) && wd[1].p2.time === Math.floor(D0(22).getTime() / 1000));
const dt = patternToDrawings({ pattern: 'double_top', points: [
  { index: 5, date: D0(5), price: 120, type: 'high' }, { index: 9, date: D0(9), price: 110, type: 'low' }, { index: 13, date: D0(13), price: 120, type: 'high' }] }, dirs);
ok('двойная вершина: две линии ломаной, красные', dt.length === 2 && dt[0].color === '#e0584f');
const hs = patternToDrawings({ pattern: 'head_shoulders_top', neckline: 100, points: [0, 1, 2, 3, 4].map((k) => ({ index: k, date: D0(k), price: 100 + k, type: k % 2 ? 'low' : 'high' })) }, dirs);
ok('голова-плечи: 4 звена и линия шеи', hs.length === 5 && hs.filter((d) => d.type === 'hline').length === 1 && hs.find((d) => d.type === 'hline').p1.price === 100);
ok('без точек (свечная фигура) — рисовать нечего', patternToDrawings({ pattern: 'engulfing_bullish' }, dirs).length === 0 && patternToDrawings(null).length === 0);
ok('нейтральная — синяя', patternToDrawings({ pattern: 'triangle_symmetric', points: [{ index: 1, date: D0(1), price: 1, type: 'high' }, { index: 5, date: D0(5), price: 2, type: 'low' }] }, dirs)[0].color === '#6485d8');

// ---- попадание клика ----
ok('точка на отрезке — 0', distToSegment(5, 0, 0, 0, 10, 0) === 0);
ok('точка над отрезком — высота', distToSegment(5, 3, 0, 0, 10, 0) === 3);
ok('за концом — расстояние до конца', distToSegment(13, 4, 0, 0, 10, 0) === 5);
ok('вырожденный отрезок', distToSegment(3, 4, 0, 0, 0, 0) === 5);

// ---- условие стратегии «цена у моей линии» ----
const def = CONDITION_CATALOG.find((c) => c.id === 'near_my_line');
ok('условие есть в каталоге', !!def && def.category === 'market');
const strat = { conditions: [{ id: 'near_my_line', enabled: true, param: 0.5, direction: 'both' }] };
const ctx = (o) => ({ indicators: { close: 300 }, ...o });
let res = evaluateStrategy(strat, ctx({ userLevels: [{ price: 301, label: 'горизонталь' }, { price: 320, label: 'луч' }] }));
ok('цена в 0,33% от линии → выполнено', res.results[0].passed === true && res.passed === 1);
res = evaluateStrategy(strat, ctx({ userLevels: [{ price: 310, label: 'горизонталь' }] }));
ok('цена в 3,3% от линии → не выполнено', res.results[0].passed === false);
res = evaluateStrategy(strat, ctx({ userLevels: [] }));
ok('линий нет → «нет данных», в счёт не идёт', res.results[0].na === true && res.total === 0);
res = evaluateStrategy(strat, ctx({}));
ok('контекст без линий (бэктест) → «нет данных»', res.results[0].na === true);
res = evaluateStrategy(strat, { userLevels: [{ price: 301 }], plan: { entryPrice: 300.5 } });
ok('цена входа из плана важнее последней цены', res.results[0].passed === true);

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки рисунков на графике прошли ✓');
