// Проверка гипотезы трейдера (2026-08-14): "раньше стратегия работала лучше на волатильных
// инструментах (IMOEXF), сейчас там минус — может, УПАЛА ТОЧНОСТЬ УГАДЫВАНИЯ НАПРАВЛЕНИЯ?"
// Если так — это проблема ВХОДА (детектор фигур), а не выхода, и чинить надо там.
//
// Меряем directionHit% — "цена хоть раз прошла порог в сторону, предсказанную фигурой" —
// НЕЗАВИСИМО от того, как мы выходили. Тот же способ, что в scripts/patternCalibration.mjs
// (раздел сессии 08-09/10: тогда получилось 76-90% по типам фигур на 6 тикерах).
// Дополнительно: разбивка по ПЕРИОДАМ (старая половина vs новая), чтобы увидеть, упала ли
// точность со временем, и по волатильности инструмента.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-diracc-'));

function esmify(srcAbsPath, extraReplacements = []) {
  let text = fs.readFileSync(srcAbsPath, 'utf8');
  text = text.replace(/from\s+(['"])(\.\.?\/[^'"]+?)\1/g, (m, q, spec) => {
    if (/\.[a-z]+$/i.test(spec)) return m;
    return `from ${q}${spec}.js${q}`;
  });
  for (const [find, replace] of extraReplacements) text = text.split(find).join(replace);
  const outPath = path.join(tmpDir, path.basename(srcAbsPath));
  fs.writeFileSync(outPath, text, 'utf8');
  return pathToFileURL(outPath).href;
}

fs.writeFileSync(path.join(tmpDir, 'tinkoff.js'), `
export class TinkoffAPI {}
export function moneyToFloat() { return 0; }
`);

esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
esmify(path.join(repoRoot, 'src/services/analytics/candlestickPatterns.js'));
const { computePatternsAtEntry, PATTERN_DIRECTIONS } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'))
);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

const TICKERS = [
  { ticker: 'IMOEXF', instrumentType: 'future' },   // главный подозреваемый (гипотеза трейдера)
  { ticker: 'NVTK', instrumentType: 'stock' },      // лучший по деньгам (+42%)
  { ticker: 'SBER', instrumentType: 'stock' },      // в плюсе
  { ticker: 'GAZP', instrumentType: 'stock' },      // в плюсе
  { ticker: 'PLZL', instrumentType: 'stock' },      // худший (−46.7%)
  { ticker: 'ALRS', instrumentType: 'stock' },      // второй худший (−43.6%)
  { ticker: 'GMKN', instrumentType: 'stock' },      // плохой (−30.1%)
  { ticker: 'MTSS', instrumentType: 'stock' },      // средний
];

const WARMUP_BARS = 60;
const OUTCOME_WINDOW_BARS = 45;
const SUCCESS_THRESHOLD_PCT = 2;

function directionOf(p) {
  if (PATTERN_DIRECTIONS.bullish.includes(p)) return 1;
  if (PATTERN_DIRECTIONS.bearish.includes(p)) return -1;
  return 0;
}
function instanceKey(c, barIndex) {
  if (Array.isArray(c.points) && c.points.length) {
    return `${c.pattern}|${c.points[0].index}-${c.points[c.points.length - 1].index}`;
  }
  return `${c.pattern}|bar${barIndex}`;
}

console.log('Тикер    | Период   | Случаев | Направление угадано | Волатильность (ср. дневной размах)');
console.log('-'.repeat(95));

for (const { ticker, instrumentType } of TICKERS) {
  let candles;
  try {
    candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: 'D1', lookbackDays: 2200 });
  } catch (e) { console.log(`${ticker}: ошибка ${e.message}`); continue; }
  if (!candles || candles.length < 300) { console.log(`${ticker}: мало данных`); continue; }

  const splitIndex = Math.floor(candles.length * 0.8);
  const seen = new Set();
  const rows = [];
  const lastUsable = candles.length - 1 - OUTCOME_WINDOW_BARS;

  for (let i = WARMUP_BARS; i <= lastUsable; i++) {
    const res = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: 1440 });
    if (!res) continue;
    for (const c of res.candidates) {
      if (c.status === 'forming') continue;
      const dir = directionOf(c.pattern);
      if (dir === 0) continue;
      const key = instanceKey(c, i);
      if (seen.has(key)) continue;
      seen.add(key);

      const entryPrice = candles[i].close;
      const end = Math.min(candles.length - 1, i + OUTCOME_WINDOW_BARS);
      let maxFavorable = 0;
      for (let j = i + 1; j <= end; j++) {
        const fav = dir === 1
          ? ((candles[j].high - entryPrice) / entryPrice) * 100
          : ((entryPrice - candles[j].low) / entryPrice) * 100;
        maxFavorable = Math.max(maxFavorable, fav);
      }
      rows.push({ isTest: i >= splitIndex, directionHit: maxFavorable >= SUCCESS_THRESHOLD_PCT ? 1 : 0 });
    }
  }

  // Волатильность инструмента — средний дневной размах в % (для проверки "волатильные vs спокойные")
  const ranges = candles.map((c) => ((c.high - c.low) / c.close) * 100).filter(Number.isFinite);
  const avgRange = ranges.reduce((s, v) => s + v, 0) / ranges.length;

  for (const [label, subset] of [['старая', rows.filter((r) => !r.isTest)], ['НОВАЯ', rows.filter((r) => r.isTest)]]) {
    if (!subset.length) continue;
    const hit = (subset.filter((r) => r.directionHit).length / subset.length) * 100;
    console.log(`${ticker.padEnd(8)} | ${label.padEnd(8)} | ${String(subset.length).padStart(7)} | ${hit.toFixed(1).padStart(18)}% | ${label === 'старая' ? avgRange.toFixed(2) + '%' : ''}`);
  }
  console.log('-'.repeat(95));
}

fs.rmSync(tmpDir, { recursive: true, force: true });
