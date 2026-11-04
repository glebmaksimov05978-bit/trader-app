// Проверка генератора учебных графиков тренажёра (npm run test:trainer): воспроизводимость, корректность свечей,
// положение момента «вопроса», направление продолжения, рост шума.
import { generatePattern, PATTERN_IDS, PATTERN_SPECS, makeRng } from '../src/services/trainer/patternGenerator.js';

let fails = 0;
const ok = (n, c) => { console.log(`${c ? '✓' : '✗'} ${n}`); if (!c) fails++; };

// 1. Воспроизводимость: те же параметры — тот же график; другое семя — другой.
const a = generatePattern('double_top', { seed: 7, noise: 0.5 });
const b = generatePattern('double_top', { seed: 7, noise: 0.5 });
const c = generatePattern('double_top', { seed: 8, noise: 0.5 });
ok('одно и то же семя даёт тот же график', JSON.stringify(a.candles) === JSON.stringify(b.candles));
ok('другое семя даёт другой график', JSON.stringify(a.candles) !== JSON.stringify(c.candles));
const r1 = makeRng(5), r2 = makeRng(5);
ok('генератор случайных чисел воспроизводим и в диапазоне [0,1)', [1, 2, 3].every(() => { const x = r1(); return x === r2() && x >= 0 && x < 1; }));

// 2. Все фигуры: свечи корректны, момент вопроса внутри, продолжение есть.
let allValid = true, cutsOk = true, dirsOk = true;
for (const id of [...PATTERN_IDS, 'none']) {
  for (let seed = 1; seed <= 25; seed++) {
    const g = generatePattern(id, { seed, noise: 0.5, bars: 56, after: 12 });
    const cs = g.candles;
    if (cs.length !== 56 + 12) allValid = false;
    for (let i = 0; i < cs.length; i++) {
      const k = cs[i];
      if (!(k.low > 0) || k.high < Math.max(k.open, k.close) - 1e-9 || k.low > Math.min(k.open, k.close) + 1e-9) allValid = false;
      if (i && !(cs[i].date > cs[i - 1].date)) allValid = false;
    }
    if (!(g.cut > 20 && g.cut < 56)) cutsOk = false;
    if (id !== 'none') {
      // продолжение идёт в сторону логики фигуры (учебная модель)
      const move = cs[cs.length - 1].close - cs[g.cut].close;
      if ((PATTERN_SPECS[id].direction === 'up') !== (move > 0)) dirsOk = false;
    }
  }
}
ok('свечи всех фигур корректны: high ≥ open/close ≥ low, цены положительные, даты растут, длина фигура+продолжение', allValid);
ok('момент вопроса лежит внутри фигуры', cutsOk);
ok('продолжение после вопроса идёт в сторону логики фигуры', dirsOk);

// 3. Шум делает ряд «неровнее»: средняя амплитуда свечей растёт.
const wiggle = (noise) => {
  let s = 0, n = 0;
  for (let seed = 1; seed <= 40; seed++) for (const k of generatePattern('triangle_symmetric', { seed, noise }).candles) { s += (k.high - k.low) / k.close; n++; }
  return s / n;
};
ok('больше шума — шире свечи', wiggle(0.7) > wiggle(0.3));

// 4. Неизвестная фигура — понятная ошибка; правда по фигуре записана.
let threw = false; try { generatePattern('nope'); } catch { threw = true; }
ok('неизвестная фигура — ошибка', threw);
const t = generatePattern('head_shoulders_top', { seed: 1 }).truth;
ok('правильный ответ записан: фигура, направление, название', t.pattern === 'head_shoulders_top' && t.direction === 'down' && /Голова/.test(t.label));
ok('«без фигуры» помечено как таковое', generatePattern('none', { seed: 1 }).truth.pattern === 'none');

if (fails) { console.log(`\nПровалено: ${fails}`); process.exit(1); }
console.log('\nВсе проверки генератора тренажёра прошли ✓');
