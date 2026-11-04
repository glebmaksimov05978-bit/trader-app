// Насколько хорошо детекторы фигур приложения узнают фигуры на графиках с ИЗВЕСТНЫМ ответом (npm run eval:patterns).
// Генератор тренажёра (services/trainer/patternGenerator.js) вкладывает фигуру в шумный ряд, детекторы
// (services/analytics/patterns.js) смотрят на график в момент, когда фигура уже видна, и мы считаем:
//   • узнал ли нужную фигуру (в списке кандидатов с уверенностью не ниже порога показа);
//   • была ли она самой уверенной из найденных;
//   • что ещё «увидели» (путаница) и как часто «видят» фигуру там, где её нет (ложные срабатывания).
// Чисто измерительный скрипт — ничего не меняет в приложении. Результаты зависят от шума и от того, как генератор
// рисует фигуру: это проверка на ИДЕАЛИЗИРОВАННЫХ примерах, а не на живом рынке.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const analytics = path.resolve(__dirname, '../src/services/analytics');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-evalpat-'));
function esmify(srcAbs) {
  let t = fs.readFileSync(srcAbs, 'utf8');
  t = t.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, s) => (/\.[a-z]+$/i.test(s) ? m : `from ${q}${s}.js${q}`));
  const out = path.join(tmp, path.basename(srcAbs));
  fs.writeFileSync(out, t, 'utf8');
  return pathToFileURL(out).href;
}
for (const f of ['indicators', 'candlestickPatterns']) esmify(path.join(analytics, `${f}.js`));
const { computePatternsAtEntry, MIN_DISPLAY_CONFIDENCE, PATTERN_LABELS } = await import(esmify(path.join(analytics, 'patterns.js')));
const { generatePattern, PATTERN_IDS, PATTERN_SPECS } = await import(pathToFileURL(path.resolve(__dirname, '../src/services/trainer/patternGenerator.js')).href);

// Какие названия детектора считаем «правильным ответом» для каждой фигуры (флаги у детектора названы по наклону канала).
const ACCEPT = {
  double_top: ['double_top'], double_bottom: ['double_bottom'],
  head_shoulders_top: ['head_shoulders_top'], head_shoulders_bottom: ['head_shoulders_bottom'],
  triangle_ascending: ['triangle_ascending'], triangle_descending: ['triangle_descending'],
  triangle_symmetric: ['triangle_symmetric', 'pennant_bullish', 'pennant_bearish'],
  wedge_rising: ['wedge_rising'], wedge_falling: ['wedge_falling'],
  flag_bull: ['flag_descending', 'flag_horizontal', 'pennant_bullish'],
  flag_bear: ['flag_ascending', 'flag_horizontal', 'pennant_bearish'],
};
const SEEDS = Number(process.env.SEEDS || 120);
const NOISES = [0.3, 0.5, 0.7];
const SHAPE_ONLY = (c) => !/^(pin_bar|engulfing)/.test(c.pattern); // свечные фигуры в этом сравнении не участвуют

function candidatesAt(candles, cut) {
  const r = computePatternsAtEntry(candles.slice(0, cut + 1), candles[cut].date, { timeframeMinutes: 1440 });
  return (r?.candidates || []).filter(SHAPE_ONLY);
}

const pad = (s, n) => String(s).padEnd(n);
const pct = (a, b) => `${Math.round((a / b) * 100)}%`.padStart(4);
console.log(`Проверка детекторов фигур на графиках с известным ответом (по ${SEEDS} графиков на фигуру и уровень шума)`);
console.log(`Порог показа в приложении: уверенность ≥ ${MIN_DISPLAY_CONFIDENCE}\n`);
console.log(`${pad('Фигура', 34)}${NOISES.map((n) => `шум ${n}`.padStart(16)).join('')}   (узнал / был главным)`);

const confusion = {};
const summary = {};
for (const id of PATTERN_IDS) {
  const row = [];
  for (const noise of NOISES) {
    let hit = 0, top = 0;
    for (let seed = 1; seed <= SEEDS; seed++) {
      const g = generatePattern(id, { seed, noise });
      const cands = candidatesAt(g.candles, g.cut);
      const ok = cands.filter((c) => ACCEPT[id].includes(c.pattern));
      if (ok.length) hit++;
      if (cands.length && ACCEPT[id].includes(cands[0].pattern)) top++;
      for (const p of new Set(cands.map((c) => c.pattern))) if (!ACCEPT[id].includes(p)) confusion[`${id} → ${p}`] = (confusion[`${id} → ${p}`] || 0) + 1;
    }
    row.push(`${pct(hit, SEEDS)} / ${pct(top, SEEDS)}`.padStart(16));
    summary[`${id}@${noise}`] = { hit: hit / SEEDS, top: top / SEEDS };
  }
  console.log(`${pad(PATTERN_SPECS[id].label, 34)}${row.join('')}`);
}

// Ложные срабатывания: случайное блуждание без фигуры.
console.log('\nЛожные срабатывания на графике БЕЗ фигуры (доля графиков, где детектор что-то «увидел»):');
const falseCount = {};
let anyFalse = 0;
const N0 = SEEDS * 3;
for (let seed = 1; seed <= N0; seed++) {
  const g = generatePattern('none', { seed, noise: 0.5 });
  const cands = candidatesAt(g.candles, g.cut);
  if (cands.length) anyFalse++;
  for (const p of new Set(cands.map((c) => c.pattern))) falseCount[p] = (falseCount[p] || 0) + 1;
}
console.log(`  хоть одна фигура: ${pct(anyFalse, N0)} графиков`);
for (const [p, n] of Object.entries(falseCount).sort((a, b) => b[1] - a[1]).slice(0, 8)) console.log(`  ${pad(PATTERN_LABELS[p] || p, 36)} ${pct(n, N0)}`);

console.log('\nНаиболее частая путаница (что видели вместо нужной фигуры, число графиков из ' + SEEDS * NOISES.length + '):');
for (const [k, n] of Object.entries(confusion).sort((a, b) => b[1] - a[1]).slice(0, 10)) console.log(`  ${k}: ${n}`);

if (process.env.EVAL_JSON) fs.writeFileSync(process.env.EVAL_JSON, JSON.stringify({ summary, falsePositive: { any: anyFalse / N0, byPattern: falseCount } }, null, 1));
