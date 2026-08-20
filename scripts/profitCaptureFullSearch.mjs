// Расширенный поиск для рейтинга фиксации прибыли (2026-08-17, запрос трейдера): не 12
// признаков "от себя", а десятки вариаций + полный перебор комбинаций, как делали для
// разворотов (scripts/reversalPairsAnalysis.mjs). Плюс режим рынка (тренд/боковик,
// уже есть готовый детектор marketContext.js) — и как отдельный признак, и как
// сегментация выборки (проверяем сигнал ВНУТРИ одного режима отдельно).
//
// Честная калибровка ожиданий (см. ответ трейдеру): цель — не 80-90% точности (такое
// означало бы предсказание будущего, физически невозможно на открытом рынке), а
// сдвинуть с ~50-60% (монетка/слабый сигнал) до 65-75% на лучших подтверждённых
// комбинациях — уже было бы отличным результатом.
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-fullsearch-'));

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

const indicatorsUrl = esmify(path.join(repoRoot, 'src/services/analytics/indicators.js'));
esmify(path.join(repoRoot, 'src/services/analytics/candlestickPatterns.js'));
esmify(path.join(repoRoot, 'src/services/analytics/marketContext.js'));
const { computePatternsAtEntry, PATTERN_DIRECTIONS } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'))
);
const { computeMarketContextAtEntry } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/marketContext.js'))
);
const { rsi, macd, ema, sma, bollingerSeries } = await import(indicatorsUrl);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

const TF = 'D1';
const TF_MINUTES = 1440;

// Больше инструментов, раз ищем более тонкий сигнал — нужна выборка побольше.
const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' }, { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' }, { ticker: 'ROSN', instrumentType: 'stock' },
  { ticker: 'NVTK', instrumentType: 'stock' }, { ticker: 'TATN', instrumentType: 'stock' },
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'CHMF', instrumentType: 'stock' },
  { ticker: 'MGNT', instrumentType: 'stock' }, { ticker: 'RUAL', instrumentType: 'stock' },
  { ticker: 'VTBR', instrumentType: 'stock' }, { ticker: 'ALRS', instrumentType: 'stock' },
  { ticker: 'SNGS', instrumentType: 'stock' }, { ticker: 'IMOEXF', instrumentType: 'future' },
];

const WARMUP_BARS = 210;
const ARM_ATR_MULT = 1.0;
const FOLLOWUP_WINDOW = 45;

function directionOf(p) {
  if (PATTERN_DIRECTIONS.bullish.includes(p)) return 1;
  if (PATTERN_DIRECTIONS.bearish.includes(p)) return -1;
  return 0;
}
function atrSeries(candles, period = 14) {
  const trs = candles.map((c, i) => i === 0 ? c.high - c.low
    : Math.max(c.high - c.low, Math.abs(c.high - candles[i - 1].close), Math.abs(c.low - candles[i - 1].close)));
  const out = new Array(candles.length).fill(null);
  let sum = 0;
  for (let i = 0; i < trs.length; i++) {
    sum += trs[i];
    if (i >= period) sum -= trs[i - period];
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}
function stochastic(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period - 1; i < candles.length; i++) {
    const s = candles.slice(i - period + 1, i + 1);
    const hi = Math.max(...s.map((c) => c.high)), lo = Math.min(...s.map((c) => c.low));
    out[i] = hi === lo ? 50 : ((candles[i].close - lo) / (hi - lo)) * 100;
  }
  return out;
}
// ADX-лайт: сила тренда через нормализованный размах направленного движения (упрощённо,
// не канонический ADX, но той же идеи — "насколько уверенно цена идёт в одну сторону").
function adxLite(candles, period = 14) {
  const out = new Array(candles.length).fill(null);
  for (let i = period; i < candles.length; i++) {
    let upSum = 0, downSum = 0;
    for (let j = i - period + 1; j <= i; j++) {
      const up = candles[j].high - candles[j - 1].high;
      const down = candles[j - 1].low - candles[j].low;
      if (up > down && up > 0) upSum += up;
      if (down > up && down > 0) downSum += down;
    }
    const total = upSum + downSum;
    out[i] = total > 0 ? (Math.abs(upSum - downSum) / total) * 100 : 0;
  }
  return out;
}

const rows = [];

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: TF, lookbackDays: 2200 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < WARMUP_BARS + 100) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);

  const closes = candles.map((c) => c.close);
  const rsi7 = rsi(closes, 7), rsi14 = rsi(closes, 14), rsi21 = rsi(closes, 21);
  const { histogram: macdS } = macd(closes);
  const ema5S = ema(closes, 5), ema9S = ema(closes, 9), ema13S = ema(closes, 13), ema21S = ema(closes, 21), ema50S = ema(closes, 50);
  const bbS = bollingerSeries(closes, 20, 2);
  const bbS10 = bollingerSeries(closes, 10, 2); // короче период — реагирует быстрее
  const atrS = atrSeries(candles, 14);
  const stochS = stochastic(candles, 14);
  const adxS = adxLite(candles, 14);

  const seen = new Set();
  const lastUsable = candles.length - 1 - FOLLOWUP_WINDOW * 2;

  for (let i = WARMUP_BARS; i <= lastUsable; i++) {
    const patterns = computePatternsAtEntry(candles, candles[i].date, { timeframeMinutes: TF_MINUTES });
    if (!patterns) continue;
    for (const c of patterns.candidates) {
      if (c.status === 'forming') continue;
      const dir = directionOf(c.pattern);
      if (dir === 0) continue;
      const key = Array.isArray(c.points) && c.points.length
        ? `${c.pattern}|${c.points[0].index}-${c.points[c.points.length - 1].index}` : `${c.pattern}|${i}`;
      if (seen.has(key)) continue;
      seen.add(key);

      const entryPrice = closes[i];
      const atrEntry = atrS[i];
      if (!atrEntry) continue;
      const armPct = (atrEntry * ARM_ATR_MULT / entryPrice) * 100;

      const end = Math.min(candles.length - 1, i + FOLLOWUP_WINDOW);
      let armIndex = null, eventualMfe = 0, eventualMfeIndex = i;
      for (let j = i + 1; j <= end; j++) {
        const bar = candles[j];
        const fav = dir === 1 ? ((bar.high - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.low) / entryPrice) * 100;
        if (fav > eventualMfe) { eventualMfe = fav; eventualMfeIndex = j; }
        if (armIndex == null && fav >= armPct) armIndex = j;
      }
      if (armIndex == null || eventualMfe < armPct * 1.2) continue;

      // Режим рынка на момент входа — сегментация + признак.
      const marketCtx = computeMarketContextAtEntry(candles, candles[i].date);
      const trendGauge = marketCtx?.trend?.gaugePercent ?? null; // 0-100, 50=боковик
      const isTrending = trendGauge != null ? Math.abs(trendGauge - 50) > 20 : null;

      for (let k = armIndex; k <= eventualMfeIndex; k++) {
        const bar = candles[k];
        const currentFav = dir === 1 ? ((bar.close - entryPrice) / entryPrice) * 100 : ((entryPrice - bar.close) / entryPrice) * 100;
        if (currentFav <= 0) continue;
        const remaining = eventualMfe - currentFav;
        if (remaining < -0.01) continue;
        const remainingFraction = remaining / currentFav;
        let label = null;
        if (remainingFraction < 0.2) label = 'near_top';
        else if (remainingFraction > 0.5) label = 'still_running';
        if (!label) continue;
        if (rsi14[k] == null || !bbS[k]) continue;

        const sideOf = (series, idx) => series[idx] == null ? null : ((closes[idx] - series[idx]) / series[idx]) * 100 * dir;
        const bbPosOf = (b) => { if (!b || b.upper === b.lower) return null; const raw = (closes[k] - b.lower) / (b.upper - b.lower); return dir === 1 ? raw : 1 - raw; };
        const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
        const volRatio20 = volAvg.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;
        const volAvg10 = candles.slice(Math.max(0, k - 10), k).map((x) => x.volume).filter(Number.isFinite);
        const volRatio10 = volAvg10.length && Number.isFinite(bar.volume) ? bar.volume / (volAvg10.reduce((s, v) => s + v, 0) / volAvg10.length) : null;

        rows.push({
          ticker, date: candles[i].date, label, dir,
          rsi7: rsi7[k], rsi14: rsi14[k], rsi21: rsi21[k],
          rsi7ChangeArm: rsi7[armIndex] != null && rsi7[k] != null ? (rsi7[k] - rsi7[armIndex]) * dir : null,
          rsi14ChangeArm: rsi14[armIndex] != null && rsi14[k] != null ? (rsi14[k] - rsi14[armIndex]) * dir : null,
          stoch: stochS[k], stochChangeArm: stochS[armIndex] != null && stochS[k] != null ? (stochS[k] - stochS[armIndex]) * dir : null,
          macdSide: macdS[k] != null ? macdS[k] * dir : null,
          adx: adxS[k],
          bbPos20: bbPosOf(bbS[k]), bbPos10: bbPosOf(bbS10[k]),
          ema5Side: sideOf(ema5S, k), ema9Side: sideOf(ema9S, k), ema13Side: sideOf(ema13S, k),
          ema21Side: sideOf(ema21S, k), ema50Side: sideOf(ema50S, k),
          volRatio20, volRatio10,
          barsFromArm: k - armIndex, currentFavPct: currentFav,
          trendGauge, isTrending,
        });
      }
    }
  }
}

console.log(`\nВсего размеченных точек: ${rows.length}`);
const nearTopN = rows.filter((r) => r.label === 'near_top').length;
console.log(`near_top: ${nearTopN}, still_running: ${rows.length - nearTopN}\n`);

const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
const splitAt = Math.floor(sorted.length / 2);
const train = sorted.slice(0, splitAt), test = sorted.slice(splitAt);
function baseRate(list) { return list.length ? (list.filter((r) => r.label === 'near_top').length / list.length) * 100 : 0; }
const trainBase = baseRate(train), testBase = baseRate(test);
console.log(`База — обучение ${trainBase.toFixed(1)}%, проверка ${testBase.toFixed(1)}%\n`);

// РАСШИРЕННЫЙ набор признаков — много вариаций одного и того же индикатора, как просил трейдер.
const FEATURES = [
  ['RSI7 экстремум', (r) => r.dir === 1 ? r.rsi7 > 75 : r.rsi7 < 25],
  ['RSI14 экстремум (>70)', (r) => r.dir === 1 ? r.rsi14 > 70 : r.rsi14 < 30],
  ['RSI21 экстремум', (r) => r.dir === 1 ? r.rsi21 > 65 : r.rsi21 < 35],
  ['RSI7 не растёт от арма', (r) => r.rsi7ChangeArm != null && Math.abs(r.rsi7ChangeArm) <= 3],
  ['RSI14 не растёт от арма', (r) => r.rsi14ChangeArm != null && Math.abs(r.rsi14ChangeArm) <= 2],
  ['Стохастик экстремум (>85)', (r) => r.stoch != null && r.stoch > 85],
  ['Стохастик не растёт', (r) => r.stochChangeArm != null && Math.abs(r.stochChangeArm) <= 5],
  ['MACD глубоко в нашу пользу', (r) => r.macdSide != null && r.macdSide > 0.5],
  ['ADX высокий (>40, сильный тренд)', (r) => r.adx != null && r.adx > 40],
  ['ADX низкий (<15, слабый тренд)', (r) => r.adx != null && r.adx < 15],
  ['Боллинджер20 верх (>0.85)', (r) => r.bbPos20 != null && r.bbPos20 > 0.85],
  ['Боллинджер10 верх (>0.85, короче период)', (r) => r.bbPos10 != null && r.bbPos10 > 0.85],
  ['Отрыв EMA5 большой (>2%)', (r) => r.ema5Side != null && r.ema5Side > 2],
  ['Отрыв EMA9 большой (>3%)', (r) => r.ema9Side != null && r.ema9Side > 3],
  ['Отрыв EMA13 большой (>4%)', (r) => r.ema13Side != null && r.ema13Side > 4],
  ['Отрыв EMA21 большой (>5%)', (r) => r.ema21Side != null && r.ema21Side > 5],
  ['Отрыв EMA50 большой (>7%)', (r) => r.ema50Side != null && r.ema50Side > 7],
  ['Объём20 всплеск (>1.8×)', (r) => r.volRatio20 != null && r.volRatio20 > 1.8],
  ['Объём10 всплеск (>2×)', (r) => r.volRatio10 != null && r.volRatio10 > 2],
  ['Объём падает (<0.6×)', (r) => r.volRatio20 != null && r.volRatio20 < 0.6],
  ['Держим 10+ баров', (r) => r.barsFromArm >= 10],
  ['Держим 15+ баров', (r) => r.barsFromArm >= 15],
  ['Держим <=2 бара', (r) => r.barsFromArm <= 2],
  ['Прибыль >5%', (r) => r.currentFavPct > 5],
  ['Прибыль >8%', (r) => r.currentFavPct > 8],
  ['Рынок в сильном тренде (детектор режима)', (r) => r.isTrending === true],
  ['Рынок в боковике (детектор режима)', (r) => r.isTrending === false],
];

function rateOn(list, pred, base) {
  const sub = list.filter(pred);
  if (!sub.length) return { n: 0, rate: null, delta: null };
  const rate = (sub.filter((r) => r.label === 'near_top').length / sub.length) * 100;
  return { n: sub.length, rate, delta: rate - base };
}

console.log('--- ОДИНОЧНЫЕ ПРИЗНАКИ ---');
const usable = [];
for (const [label, pred] of FEATURES) {
  const tr = rateOn(train, pred, trainBase), te = rateOn(test, pred, testBase);
  if (tr.n < 80 || te.n < 60) { console.log(`${label.padEnd(45)} | мало данных`); continue; }
  const verdict = Math.sign(tr.delta) === Math.sign(te.delta) && Math.abs(te.delta) >= Math.abs(tr.delta) * 0.5 ? '✅' : '❌';
  console.log(`${label.padEnd(45)} | обуч.${(tr.delta >= 0 ? '+' : '') + tr.delta.toFixed(1)}п.п. | пров.${(te.delta >= 0 ? '+' : '') + te.delta.toFixed(1)}п.п. (n=${te.n}) | ${verdict}`);
  if (verdict === '✅') usable.push({ label, pred, teDelta: te.delta });
}

// Полный перебор пар и троек среди подтвердившихся одиночных — находим лучшие связки.
console.log(`\n--- ПЕРЕБОР ПАР/ТРОЕК ИЗ ${usable.length} ПОДТВЕРДИВШИХСЯ ПРИЗНАКОВ ---`);
const combos = [];
function evalCombo(idxs) {
  const preds = idxs.map((i) => usable[i].pred);
  const pred = (r) => preds.every((p) => p(r));
  const tr = rateOn(train, pred, trainBase);
  if (tr.n < 50 || Math.abs(tr.delta) < 10) return;
  const te = rateOn(test, pred, testBase);
  if (te.n < 35) return;
  const confirmed = Math.sign(te.delta) === Math.sign(tr.delta) && Math.abs(te.delta) >= Math.abs(tr.delta) * 0.5;
  if (!confirmed) return;
  combos.push({ labels: idxs.map((i) => usable[i].label), n: te.n, rate: te.rate, delta: te.delta });
}
for (let a = 0; a < usable.length; a++) {
  for (let b = a + 1; b < usable.length; b++) {
    evalCombo([a, b]);
    for (let c = b + 1; c < usable.length; c++) evalCombo([a, b, c]);
  }
}
combos.sort((x, y) => y.rate - x.rate);
console.log(`Подтвердившихся комбинаций: ${combos.length}\n`);
console.log('ТОП-10 ПО ТОЧНОСТИ (доля near_top на проверке):');
for (const c of combos.slice(0, 10)) {
  console.log(`  ${c.rate.toFixed(1)}% (n=${c.n}, откл. ${(c.delta >= 0 ? '+' : '') + c.delta.toFixed(1)}п.п.) | ${c.labels.join(' + ')}`);
}

// Сегментация по режиму рынка отдельно — сильнее ли лучшая связка ВНУТРИ одного режима.
console.log('\n--- ЛУЧШАЯ СВЯЗКА, РАЗБИТАЯ ПО РЕЖИМУ РЫНКА ---');
if (combos.length) {
  const best = combos[0];
  // Восстановить предикат лучшей связки по индексам меток (проще — пересчитать заново).
  const bestFeatureLabels = best.labels;
  const bestPreds = usable.filter((u) => bestFeatureLabels.includes(u.label)).map((u) => u.pred);
  const bestPred = (r) => bestPreds.every((p) => p(r));
  for (const [label, filterFn] of [['Только тренд', (r) => r.isTrending === true], ['Только боковик', (r) => r.isTrending === false], ['Все режимы вместе', () => true]]) {
    const sub = test.filter((r) => bestPred(r) && filterFn(r));
    if (sub.length < 20) { console.log(`${label.padEnd(20)} | мало данных (n=${sub.length})`); continue; }
    const rate = (sub.filter((r) => r.label === 'near_top').length / sub.length) * 100;
    console.log(`${label.padEnd(20)} | n=${sub.length} | ${rate.toFixed(1)}% near_top`);
  }
}

fs.rmSync(tmpDir, { recursive: true, force: true });
