// РЕЙТИНГОВАЯ СИСТЕМА «откат или разворот» (идея трейдера 2026-08-14): вместо поиска
// одного идеального признака — набрать много признаков (все индикаторы в разных
// вариациях), у каждого начислять очко за/против разворота, и смотреть, работает ли СУММА
// очков как предсказатель: «если сразу два-три сработали — значит с высокой вероятностью
// разворот».
//
// ⚠️ ГЛАВНАЯ ЗАЩИТА ОТ САМООБМАНА (иначе весь смысл теряется): перебирая ~30 признаков,
// «работающие» находишь всегда, даже в чистом шуме. Поэтому строго:
//   1. История делится по ВРЕМЕНИ пополам.
//   2. На СТАРОЙ половине измеряется каждый признак; в систему берутся только те, что
//      дали заметное отклонение на достаточной выборке. Веса — тоже со старой половины.
//   3. Итоговая шкала проверяется на НОВОЙ половине, которую отбор признаков не видел.
// Если на новых данных шкала монотонна (чем больше очков — тем чаще разворот) — система
// настоящая. Если рассыпается — честно значит, что это была подгонка.
//
// Run: node scripts/reversalScoreSystem.mjs [D1|H1]
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'traderpro-score-'));

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
const { computePatternsAtEntry, PATTERN_DIRECTIONS } = await import(
  esmify(path.join(repoRoot, 'src/services/analytics/patterns.js'))
);
const { rsi, macd, ema, sma, bollingerSeries } = await import(indicatorsUrl);
const { fetchDailyCandles } = await import(
  esmify(path.join(repoRoot, 'src/services/marketData/candles.js'), [
    ["from '../tinkoff.js'", "from './tinkoff.js'"],
  ])
);

const TF = process.argv[2] || 'D1';
const TF_MINUTES = TF === 'D1' ? 1440 : 60;

const TICKERS = [
  { ticker: 'SBER', instrumentType: 'stock' }, { ticker: 'GAZP', instrumentType: 'stock' },
  { ticker: 'LKOH', instrumentType: 'stock' }, { ticker: 'GMKN', instrumentType: 'stock' },
  { ticker: 'MTSS', instrumentType: 'stock' }, { ticker: 'ROSN', instrumentType: 'stock' },
  { ticker: 'NVTK', instrumentType: 'stock' }, { ticker: 'TATN', instrumentType: 'stock' },
  { ticker: 'PLZL', instrumentType: 'stock' }, { ticker: 'CHMF', instrumentType: 'stock' },
  { ticker: 'MGNT', instrumentType: 'stock' }, { ticker: 'IMOEXF', instrumentType: 'future' },
];

const WARMUP_BARS = 210;
const ADVERSE_ATR_MULT = 1.0;
const FOLLOWUP_WINDOW = 30;

function directionOf(p) {
  if (PATTERN_DIRECTIONS.bullish.includes(p)) return 1;
  if (PATTERN_DIRECTIONS.bearish.includes(p)) return -1;
  return 0;
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

const rows = [];

for (const { ticker, instrumentType } of TICKERS) {
  process.stdout.write(`${ticker}... `);
  let candles;
  try {
    candles = await fetchDailyCandles({ ticker, instrumentType, toDate: new Date(), timeframe: TF, lookbackDays: TF === 'D1' ? 2200 : 1500 });
  } catch (e) { console.log(`ошибка: ${e.message}`); continue; }
  if (!candles || candles.length < WARMUP_BARS + 100) { console.log('мало данных'); continue; }
  console.log(`${candles.length} свечей`);

  const closes = candles.map((c) => c.close);
  const rsiS = rsi(closes, 14);
  const { histogram: macdS, macdLine, signalLine } = macd(closes);
  const ema9S = ema(closes, 9), ema21S = ema(closes, 21);
  const ema100S = ema(closes, 100), ema200S = ema(closes, 200);
  const sma50S = sma(closes, 50);
  const bbS = bollingerSeries(closes, 20, 2);
  const atrS = atrSeries(candles, 14);
  const stochS = stochastic(candles, 14);

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
      const noisePct = (atrEntry * ADVERSE_ATR_MULT / entryPrice) * 100;

      let k = null;
      for (let j = i + 1; j <= Math.min(candles.length - 1, i + FOLLOWUP_WINDOW); j++) {
        const adv = dir === 1 ? ((entryPrice - candles[j].low) / entryPrice) * 100
          : ((candles[j].high - entryPrice) / entryPrice) * 100;
        if (adv >= noisePct) { k = j; break; }
      }
      if (k == null) continue;
      if (rsiS[i] == null || rsiS[k] == null || !bbS[k] || ema200S[k] == null || sma50S[k] == null) continue;

      const side = (series, idx) => series[idx] == null ? null : ((closes[idx] - series[idx]) / series[idx]) * 100 * dir;
      const bbPos = (idx) => {
        const b = bbS[idx];
        if (!b || b.upper === b.lower) return null;
        const raw = (closes[idx] - b.lower) / (b.upper - b.lower);
        return dir === 1 ? raw : 1 - raw;
      };
      const bbWidth = (idx) => { const b = bbS[idx]; return b ? ((b.upper - b.lower) / closes[idx]) * 100 : null; };

      let closesOutsideBand = 0;
      for (let m = i + 1; m <= k; m++) {
        const b = bbS[m];
        if (!b) continue;
        if (dir === 1 ? closes[m] < b.lower : closes[m] > b.upper) closesOutsideBand += 1;
      }
      const bandSlope = (() => {
        const f = bbS[Math.max(0, k - 5)], t = bbS[k];
        if (!f || !t) return null;
        const fv = dir === 1 ? f.lower : f.upper, tv = dir === 1 ? t.lower : t.upper;
        return ((tv - fv) / fv) * 100 * dir;
      })();
      const volAvg = candles.slice(Math.max(0, k - 20), k).map((x) => x.volume).filter(Number.isFinite);
      const volRatio = volAvg.length && Number.isFinite(candles[k].volume)
        ? candles[k].volume / (volAvg.reduce((s, v) => s + v, 0) / volAvg.length) : null;

      // Исход
      let recovered = null;
      for (let m = k + 1; m <= Math.min(candles.length - 1, k + FOLLOWUP_WINDOW); m++) {
        const ret = dir === 1 ? ((closes[m] - entryPrice) / entryPrice) * 100
          : ((entryPrice - closes[m]) / entryPrice) * 100;
        if (ret > 0) { recovered = true; break; }
        const adv = dir === 1 ? ((entryPrice - candles[m].low) / entryPrice) * 100
          : ((candles[m].high - entryPrice) / entryPrice) * 100;
        if (adv >= noisePct * 2) { recovered = false; break; }
      }
      if (recovered == null) continue;

      rows.push({
        date: candles[i].date, recovered,
        rsiChange: (rsiS[k] - rsiS[i]) * dir,
        rsiLevel: rsiS[k],
        stochChange: (stochS[k] != null && stochS[i] != null) ? (stochS[k] - stochS[i]) * dir : null,
        macdChange: (macdS[k] - macdS[i]) * dir,
        macdSide: macdS[k] * dir,
        macdCrossed: (macdLine?.[k] != null && signalLine?.[k] != null) ? (macdLine[k] - signalLine[k]) * dir < 0 : null,
        atrChangePct: atrEntry ? ((atrS[k] - atrEntry) / atrEntry) * 100 : null,
        bbPosCross: bbPos(k),
        bbPosChange: (bbPos(i) != null && bbPos(k) != null) ? bbPos(k) - bbPos(i) : null,
        bbWidthChange: (bbWidth(i) != null && bbWidth(k) != null) ? bbWidth(k) - bbWidth(i) : null,
        closesOutsideBand, bandSlope, volRatio,
        ema9Side: side(ema9S, k), ema21Side: side(ema21S, k), sma50Side: side(sma50S, k),
        ema100Side: side(ema100S, k), ema200Side: side(ema200S, k),
        ema9Broken: (side(ema9S, i) > 0 && side(ema9S, k) < 0),
        ema21Broken: (side(ema21S, i) > 0 && side(ema21S, k) < 0),
        ema200Broken: (side(ema200S, i) > 0 && side(ema200S, k) < 0),
        emaStacked: (ema9S[k] != null && ema21S[k] != null) ? ((ema9S[k] - ema21S[k]) * dir < 0) : null,
        barsToСross: k - i,
      });
    }
  }
}

// --- Каталог признаков: каждый индикатор в НЕСКОЛЬКИХ вариациях (как просил трейдер) ----
const FEATURES = [
  ['RSI упал >10 против нас', (r) => r.rsiChange <= -10],
  ['RSI упал >15 против нас', (r) => r.rsiChange <= -15],
  ['RSI почти не изменился (±3)', (r) => Math.abs(r.rsiChange) <= 3],
  ['RSI сейчас в зоне слабости (<40 по направлению)', (r) => r.rsiLevel != null && r.rsiLevel < 40],
  ['Стохастик упал >15', (r) => r.stochChange != null && r.stochChange <= -15],
  ['MACD-гистограмма развернулась против', (r) => r.macdChange < 0],
  ['MACD-гистограмма уже на стороне против', (r) => r.macdSide < 0],
  ['MACD пересёк сигнальную против', (r) => r.macdCrossed === true],
  ['ATR расширился >20%', (r) => r.atrChangePct != null && r.atrChangePct > 20],
  ['ATR расширился >40%', (r) => r.atrChangePct != null && r.atrChangePct > 40],
  ['ATR сжался >10%', (r) => r.atrChangePct != null && r.atrChangePct < -10],
  ['Боллинджер: ушли из верхней половины', (r) => r.bbPosChange != null && r.bbPosChange <= -0.3],
  ['Боллинджер: сейчас в нижней трети канала', (r) => r.bbPosCross != null && r.bbPosCross < 0.33],
  ['Боллинджер: полосы расширяются', (r) => r.bbWidthChange != null && r.bbWidthChange > 0.5],
  ['Боллинджер: полосы сжимаются', (r) => r.bbWidthChange != null && r.bbWidthChange < -0.3],
  ['Боллинджер: вышли за границу 1 раз', (r) => r.closesOutsideBand === 1],
  ['Боллинджер: вышли за границу 2+ раз', (r) => r.closesOutsideBand >= 2],
  ['Боллинджер: полоса едет против нас', (r) => r.bandSlope != null && r.bandSlope < -0.5],
  ['Объём слабый (<0.8×)', (r) => r.volRatio != null && r.volRatio < 0.8],
  ['Объём крупный (>1.3×)', (r) => r.volRatio != null && r.volRatio > 1.3],
  ['Объём экстремальный (>2×)', (r) => r.volRatio != null && r.volRatio > 2],
  ['Пробита EMA9', (r) => r.ema9Broken === true],
  ['Пробита EMA21', (r) => r.ema21Broken === true],
  ['Пробита EMA200', (r) => r.ema200Broken === true],
  ['Цена ниже EMA21', (r) => r.ema21Side != null && r.ema21Side < 0],
  ['Цена ниже SMA50', (r) => r.sma50Side != null && r.sma50Side < 0],
  ['Цена ниже EMA100', (r) => r.ema100Side != null && r.ema100Side < 0],
  ['Цена ниже EMA200', (r) => r.ema200Side != null && r.ema200Side < 0],
  ['Цена ВЫШЕ EMA200 (тренд цел)', (r) => r.ema200Side != null && r.ema200Side > 0],
  ['EMA9 ушла под EMA21 (порядок сломан)', (r) => r.emaStacked === true],
  ['Движение против дошло быстро (1-2 бара)', (r) => r.barsToСross <= 2],
  ['Движение против шло долго (7+ баров)', (r) => r.barsToСross >= 7],
];

const sorted = [...rows].sort((a, b) => new Date(a.date) - new Date(b.date));
const splitAt = Math.floor(sorted.length / 2);
const train = sorted.slice(0, splitAt), test = sorted.slice(splitAt);
const trainBase = (train.filter((r) => r.recovered).length / train.length) * 100;
const testBase = (test.filter((r) => r.recovered).length / test.length) * 100;

console.log(`\n${'='.repeat(105)}`);
console.log(`РЕЙТИНГОВАЯ СИСТЕМА — ${TF}, всего ${rows.length} случаев`);
console.log(`Обучение n=${train.length} (база ${trainBase.toFixed(1)}%) | Проверка n=${test.length} (база ${testBase.toFixed(1)}%)`);
console.log(`${'='.repeat(105)}\n`);

// Шаг 1: отбор признаков ТОЛЬКО на обучающей половине
const MIN_N = 60, MIN_DELTA = 6;
const selected = [];
for (const [label, pred] of FEATURES) {
  const sub = train.filter(pred);
  if (sub.length < MIN_N) continue;
  const rate = (sub.filter((r) => r.recovered).length / sub.length) * 100;
  const delta = rate - trainBase;
  if (Math.abs(delta) < MIN_DELTA) continue;
  // Вес: +1 очко за разворот (delta<0), -1 за откат (delta>0). Простые целые веса, не
  // подогнанные коэффициенты — чем проще шкала, тем меньше шансов переобучиться.
  selected.push({ label, pred, weight: delta < 0 ? 1 : -1, trainDelta: delta, trainN: sub.length });
}
selected.sort((a, b) => a.trainDelta - b.trainDelta);

console.log(`Отобрано ${selected.length} признаков из ${FEATURES.length} (порог: n>=${MIN_N}, |откл.|>=${MIN_DELTA} п.п.), веса ±1:`);
for (const f of selected) {
  console.log(`  ${f.weight > 0 ? '+1 (разворот)' : '-1 (откат)  '} | ${f.label.padEnd(48)} | обуч. ${(f.trainDelta >= 0 ? '+' : '') + f.trainDelta.toFixed(1)} п.п. (n=${f.trainN})`);
}

// Шаг 2: считаем очки и проверяем шкалу на ОБЕИХ половинах
function scoreOf(r) { return selected.reduce((s, f) => s + (f.pred(r) ? f.weight : 0), 0); }
function bucketReport(list, baseRate, title) {
  console.log(`\n${title}`);
  console.log('Очков  |    n | доля "вернулось" (откат) | отклонение от базы');
  console.log('-'.repeat(70));
  const byScore = new Map();
  for (const r of list) {
    const s = scoreOf(r);
    if (!byScore.has(s)) byScore.set(s, []);
    byScore.get(s).push(r);
  }
  const keys = [...byScore.keys()].sort((a, b) => a - b);
  const out = [];
  for (const s of keys) {
    const sub = byScore.get(s);
    if (sub.length < 25) continue;
    const rate = (sub.filter((r) => r.recovered).length / sub.length) * 100;
    out.push({ score: s, n: sub.length, rate });
    console.log(`${String(s).padStart(5)}  | ${String(sub.length).padStart(4)} | ${rate.toFixed(1).padStart(21)}% | ${((rate - baseRate) >= 0 ? '+' : '') + (rate - baseRate).toFixed(1)} п.п.`);
  }
  return out;
}

const trainBuckets = bucketReport(train, trainBase, '--- ОБУЧЕНИЕ (здесь система и строилась — успех тут ничего не доказывает) ---');
const testBuckets = bucketReport(test, testBase, '--- ПРОВЕРКА на новых данных (вот это и есть настоящий тест) ---');

// Шаг 3: монотонность — главный критерий. Чем больше очков, тем РЕЖЕ должно быть
// «вернулось». Если это выполняется на новых данных — шкала настоящая.
function monotonicity(buckets) {
  if (buckets.length < 3) return null;
  let ok = 0, total = 0;
  for (let i = 1; i < buckets.length; i++) { total += 1; if (buckets[i].rate <= buckets[i - 1].rate) ok += 1; }
  return (ok / total) * 100;
}
const monoTest = monotonicity(testBuckets);
console.log(`\n${'='.repeat(105)}`);
if (monoTest == null) {
  console.log('ВЕРДИКТ: слишком мало групп по очкам на проверке — судить нельзя.');
} else {
  const spread = testBuckets.length ? testBuckets[0].rate - testBuckets[testBuckets.length - 1].rate : 0;
  console.log(`ВЕРДИКТ на новых данных: монотонность ${monoTest.toFixed(0)}% (шагов «стало реже», сколько положено)`);
  console.log(`Разброс между лучшей и худшей группой: ${spread.toFixed(1)} п.п. (${testBuckets[0]?.rate.toFixed(1)}% → ${testBuckets[testBuckets.length - 1]?.rate.toFixed(1)}%)`);
  if (monoTest >= 75 && spread >= 20) console.log('✅ Шкала РАБОТАЕТ на данных, которых не видела: очки реально ранжируют откат vs разворот.');
  else if (monoTest >= 60) console.log('⚠️ Шкала работает частично — направление верное, но не на каждом шаге.');
  else console.log('❌ Шкала не подтвердилась — сумма очков не ранжирует исход на новых данных.');
}

fs.rmSync(tmpDir, { recursive: true, force: true });
